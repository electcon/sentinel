// Sentinel — entry point.
//
// Boot order:
//   1. require('dotenv').config() if running locally
//   2. Connect Postgres pool
//   3. Run schema init (idempotent ALTER TABLE / CREATE TABLE IF NOT EXISTS)
//   4. Mount HTTP routes (dashboard + admin + alerts webhook)
//   5. app.listen(PORT)
//
// Workers (ingest, digest cron) are SEPARATE processes started via the
// scripts in package.json. Render runs them as cron jobs or separate
// services. The web process never blocks on ingest.

'use strict';

const express = require('express');
const { Pool } = require('pg');
const initSchema = require('./scripts/init-db');

if (!process.env.DATABASE_URL) {
  console.error('[sentinel] FATAL: DATABASE_URL not set');
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5
});

const app = express();

// Security headers — applied to every response. CSP is strict because
// our HTML pages don't load any external scripts; if the dashboard
// adds a chart library later, relax these accordingly.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'");
  next();
});

// Stripe webhook needs the RAW body for signature verification —
// register before express.json() consumes it.
app.post('/api/stripe-webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  try {
    const stripeClient = require('./lib/stripe-client');
    if (!stripeClient.isConfigured()) return res.status(503).json({ error: 'stripe not configured' });
    let event;
    try {
      event = stripeClient.constructWebhookEvent(req.body, req.headers['stripe-signature']);
    } catch (e) {
      console.error('[stripe-webhook] signature verification failed:', e.message);
      return res.status(400).json({ error: 'invalid signature' });
    }

    // Subscription state → billing_status. Resolve customer by Stripe
    // customer ID stored in our customers row.
    if (event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      const status = stripeClient.mapSubscriptionStatus(sub.status);
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
      const startedAt = sub.start_date ? new Date(sub.start_date * 1000) : null;
      const amountCents = sub.items?.data?.[0]?.price?.unit_amount || null;
      const interval = sub.items?.data?.[0]?.price?.recurring?.interval || null;
      const period = interval === 'year' ? 'annual' : (interval === 'month' ? 'monthly' : null);
      try {
        await pool.query(`
          UPDATE customers
          SET billing_status = $1,
              billing_amount_cents = COALESCE($2, billing_amount_cents),
              billing_period = COALESCE($3, billing_period),
              billing_starts_at = COALESCE($4, billing_starts_at),
              stripe_subscription_id = $5
          WHERE stripe_customer_id = $6
        `, [status, amountCents, period, startedAt, sub.id, stripeCustomerId]);
        console.log(`[stripe-webhook] subscription ${event.type} → status=${status} for stripe_customer=${stripeCustomerId}`);
      } catch (e) {
        console.error('[stripe-webhook] DB update failed:', e.message);
      }
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      const inv = event.data.object;
      const stripeCustomerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
      try {
        await pool.query(`UPDATE customers SET billing_status = 'active' WHERE stripe_customer_id = $1 AND billing_status IN ('trialing','past_due')`, [stripeCustomerId]);
      } catch (_) {}
      console.log(`[stripe-webhook] invoice paid for stripe_customer=${stripeCustomerId}`);
    } else if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object;
      const stripeCustomerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
      try {
        await pool.query(`UPDATE customers SET billing_status = 'past_due' WHERE stripe_customer_id = $1`, [stripeCustomerId]);
      } catch (_) {}
      console.log(`[stripe-webhook] invoice payment_failed for stripe_customer=${stripeCustomerId}`);
    } else {
      // Other events ignored for now. Stripe expects 2xx for any event we successfully receive.
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[stripe-webhook]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.json({ limit: '1mb' }));

// ── Health (Render uses this for health checks) ─────────────────────
app.get('/api/health', async (req, res) => {
  let dbOk = false; let dbMs = null;
  try {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    dbMs = Date.now() - t0;
    dbOk = true;
  } catch (e) { /* dbOk stays false */ }
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    timestamp: new Date().toISOString(),
    db: { ok: dbOk, ms: dbMs },
    service: 'sentinel',
    version: require('./package.json').version
  });
});

// ── Smoke endpoints (week-1/2 only, gated by SMOKE_TOKEN env) ───────
// All under /api/_smoke/* and removed once a real admin auth layer
// lands in week 5.

// Master kill switch: SMOKE_DISABLED=true disables all /api/_smoke/*
// endpoints (404). Flip on Render once real customers are onboarded
// and you no longer need to run ad-hoc tests via the dev token.
function smokeEnabled() {
  return process.env.SMOKE_DISABLED !== 'true';
}

function requireSmokeToken(req, res, next) {
  if (!smokeEnabled()) return res.status(404).json({ error: 'not found' });
  const tok = req.get('x-smoke-token') || '';
  const expected = process.env.SMOKE_TOKEN || '';
  if (!expected || tok !== expected) return res.status(401).json({ error: 'bad token' });
  next();
}

// High-risk smoke ops (sends real email, creates synthetic data,
// cross-customer reads) require an additional ADMIN_PASSWORD via
// X-Admin-Password header. Defense in depth: the smoke token alone
// is not enough for these. Operator must supply both.
function requireSmokeAdmin(req, res, next) {
  if (!smokeEnabled()) return res.status(404).json({ error: 'not found' });
  const tok = req.get('x-smoke-token') || '';
  const pw = req.get('x-admin-password') || '';
  const expectedTok = process.env.SMOKE_TOKEN || '';
  const expectedPw = process.env.ADMIN_PASSWORD || '';
  if (!expectedTok || tok !== expectedTok) return res.status(401).json({ error: 'bad token' });
  if (!expectedPw || pw !== expectedPw) return res.status(401).json({ error: 'admin password required for this endpoint' });
  next();
}

// Classify a synthetic mention end-to-end.
// Body: { text, target?, source?, provider?: 'anthropic'|'openrouter', openrouterModel? }
app.post('/api/_smoke/classify', requireSmokeToken, async (req, res) => {
  try {
    const { classify } = require('./classify');
    const body = (req.body && req.body.text) || '';
    if (!body) return res.status(400).json({ error: 'text required' });
    const out = await classify({
      targetName: req.body.target || 'Test Candidate',
      body,
      source: req.body.source || 'smoke',
      authorHandle: 'smoke-test',
      postedAt: new Date().toISOString(),
      provider: req.body.provider,
      openrouterModel: req.body.openrouterModel
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one Reddit ingest run. Returns the per-customer summary.
app.post('/api/_smoke/reddit-run', requireSmokeToken, async (req, res) => {
  try {
    const { runOnce } = require('./workers/reddit');
    const log = (m) => console.log(m);
    const summary = await runOnce({ pool, log });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bluesky firehose stats (Jetstream WebSocket). Useful for confirming
// the firehose is connected and processing posts.
app.get('/api/_smoke/bluesky-firehose-stats', requireSmokeToken, (req, res) => {
  if (!global._jetstream) return res.json({ enabled: false, hint: 'set BLUESKY_FIREHOSE_ENABLED=true on Render' });
  res.json({ enabled: true, ...global._jetstream.getStats() });
});

// Trigger one Bluesky ingest run.
app.post('/api/_smoke/bluesky-run', requireSmokeToken, async (req, res) => {
  try {
    const { runOnce } = require('./workers/bluesky');
    const log = (m) => console.log(m);
    const summary = await runOnce({ pool, log });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one RSS ingest run.
app.post('/api/_smoke/rss-run', requireSmokeToken, async (req, res) => {
  try {
    const { runOnce } = require('./workers/rss');
    const log = (m) => console.log(m);
    const summary = await runOnce({ pool, log });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one X (Twitter) ingest run.
app.post('/api/_smoke/x-run', requireSmokeToken, async (req, res) => {
  try {
    const { runOnce } = require('./workers/x');
    const log = (m) => console.log(m);
    const summary = await runOnce({ pool, log });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one Telegram ingest run.
app.post('/api/_smoke/telegram-run', requireSmokeToken, async (req, res) => {
  try {
    const { runOnce } = require('./workers/telegram');
    const log = (m) => console.log(m);
    const summary = await runOnce({ pool, log });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one TruthSocial ingest run.
app.post('/api/_smoke/truthsocial-run', requireSmokeToken, async (req, res) => {
  try {
    const { runOnce } = require('./workers/truthsocial');
    const summary = await runOnce({ pool, log: console.log });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one CISA AIS poll. No-op if CISA_TAXII_* env vars unset.
app.post('/api/_smoke/cisa-run', requireSmokeToken, async (req, res) => {
  try {
    const { runOnce } = require('./workers/cisa');
    const summary = await runOnce({ pool, log: console.log });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FBI CDE risk summary for a state. ?state=NH (postal abbreviation).
// Smoke-token gated.
app.get('/api/_smoke/fbi-state-stats', requireSmokeToken, async (req, res) => {
  try {
    const state = String(req.query.state || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) return res.status(400).json({ error: 'pass ?state=XX (2-letter abbrev)' });
    const { riskSummaryForState } = require('./lib/fbi-cde');
    const out = await riskSummaryForState(state);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Idempotent dev-customer seeder. POST to provision the test customer
// and dev targets (Cinde Warmington, Eileen Laubacher, Charlie Crist).
// HIGH RISK — writes a customer with hardcoded password; admin gate.
app.post('/api/_smoke/seed-dev', requireSmokeAdmin, async (req, res) => {
  try {
    const child_process = require('child_process');
    child_process.execFile(process.execPath, ['scripts/seed-dev.js'], { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) return res.status(500).json({ error: err.message, stdout, stderr });
      res.json({ ok: true, stdout, stderr });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read most-recent mentions for inspection. Optional ?customer_name=foo
// or ?tier=3 filters. CROSS-CUSTOMER read — admin gate.
app.get('/api/_smoke/mentions', requireSmokeAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const tierFilter = req.query.tier ? `AND m.threat_tier >= ${parseInt(req.query.tier, 10)}` : '';
    const r = await pool.query(`
      SELECT m.id, m.source, m.source_id, m.source_url, m.posted_at, m.ingested_at,
             m.threat_tier, m.sentiment, m.rationale, m.classifier_v, m.s3_key,
             m.body_excerpt, c.name AS customer_name, t.name AS target_name
      FROM mentions m
      JOIN customers c ON c.id = m.customer_id
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE 1=1 ${tierFilter}
      ORDER BY m.ingested_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ count: r.rowCount, mentions: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one weekly-report sweep. force=true bypasses Sunday-only check.
app.post('/api/_smoke/weekly-run', requireSmokeAdmin, async (req, res) => {
  try {
    const { runOnce } = require('./workers/weekly');
    const force = !!(req.body && req.body.force);
    const summary = await runOnce({ pool, log: console.log, force });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one digest sweep. Body: { force: true } bypasses the 23h gap.
// HIGH RISK — sends real email if RESEND_API_KEY set; admin gate.
app.post('/api/_smoke/digest-run', requireSmokeAdmin, async (req, res) => {
  try {
    const { runOnce } = require('./workers/digest');
    const force = !!(req.body && req.body.force);
    const summary = await runOnce({ pool, log: console.log, force });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one alert sweep. HIGH RISK — sends real email + fires
// customer-defined webhooks. Admin gate.
app.post('/api/_smoke/alert-run', requireSmokeAdmin, async (req, res) => {
  try {
    const { runOnce } = require('./workers/alert');
    const summary = await runOnce({ pool, log: console.log });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Inject a synthetic mention for the dev customer. Tier 2 → review queue,
// tier 3/4 → threat_event for alert worker. Body: { tier?: 2|3|4 }
// HIGH RISK — creates fake customer data; admin gate.
app.post('/api/_smoke/inject-test-threat', requireSmokeAdmin, async (req, res) => {
  try {
    const t = (req.body && req.body.tier);
    const tier = t === 2 ? 2 : t === 4 ? 4 : 3;
    const cust = await pool.query(`SELECT id, name, alert_email FROM customers WHERE name = 'Sentinel Dev (test)' LIMIT 1`);
    if (!cust.rowCount) return res.status(400).json({ error: 'dev customer not found — run seed-dev first' });
    const tgt = await pool.query(`SELECT id, name FROM targets WHERE customer_id = $1 LIMIT 1`, [cust.rows[0].id]);
    if (!tgt.rowCount) return res.status(400).json({ error: 'dev target not found' });

    const SYNTH = {
      2: { body: 'Warmington is a corrupt witch and her whole family are leeches. They all deserve to be run out of NH for good.', rationale: 'Synthetic tier-2 test: dehumanizing labels + family attack + mob-removal language' },
      3: { body: 'She lives at 14 Maple Street in Concord NH. Anyone in the area should pay her a visit and let her know what we think of her family. She wont be safe.', rationale: 'Synthetic tier-3 test: doxxing + menacing tone' },
      4: { body: 'I am driving to her event in Concord tomorrow with my rifle. She is not going to walk out of that building alive.', rationale: 'Synthetic tier-4 test: explicit threat + weapon + time-bound location' }
    };
    const synth = SYNTH[tier];
    const sourceId = 'synth_' + Date.now() + '_t' + tier;
    const reviewStatus = tier === 2 ? 'pending' : null;

    const ins = await pool.query(`
      INSERT INTO mentions (
        customer_id, target_id, source, source_id, source_url,
        author_handle, posted_at, body_excerpt,
        threat_tier, sentiment, rationale, classifier_v, review_status
      ) VALUES (
        $1, $2, 'synth', $3, 'https://example.com/synth',
        'synth_test', NOW(), $4,
        $5, -2, $6, 'tax-v1.2', $7
      ) RETURNING id
    `, [cust.rows[0].id, tgt.rows[0].id, sourceId, synth.body, tier, synth.rationale, reviewStatus]);
    const mentionId = ins.rows[0].id;

    if (tier >= 3) {
      await pool.query(`
        INSERT INTO threat_events (mention_id, customer_id, target_id, tier, status)
        VALUES ($1, $2, $3, $4, 'open')
      `, [mentionId, cust.rows[0].id, tgt.rows[0].id, tier]);
    }

    res.json({
      ok: true,
      tier,
      mention_id: mentionId,
      target: tgt.rows[0].name,
      customer: cust.rows[0].name,
      alert_email: cust.rows[0].alert_email,
      next: tier === 2
        ? 'visit /dashboard/review-queue to triage'
        : 'POST /api/_smoke/alert-run to fire the alert email'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Consolidate duplicate customers by name. For each name with N>1 rows,
// pick the row with the most mentions as primary and:
//   1. UPDATE all targets/mentions/threat_events/classifications to point to primary
//   2. DELETE the other customers and their now-empty target rows
// Bounded by name; idempotent. Used to clean up the legacy seed-dev
// bug that produced two "Sentinel Dev (test)" customers.
// HIGH RISK — deletes data; admin gate.
app.post('/api/_smoke/cleanup-duplicates', requireSmokeAdmin, async (req, res) => {
  try {
    const dups = await pool.query(`
      SELECT name, COUNT(*)::int AS n FROM customers GROUP BY name HAVING COUNT(*) > 1
    `);
    const result = [];
    for (const d of dups.rows) {
      const all = await pool.query(`
        SELECT c.id, COALESCE(m.n, 0)::int AS mention_count
        FROM customers c
        LEFT JOIN (SELECT customer_id, COUNT(*) AS n FROM mentions GROUP BY customer_id) m ON m.customer_id = c.id
        WHERE c.name = $1
        ORDER BY mention_count DESC, c.created_at ASC
      `, [d.name]);
      const primary = all.rows[0].id;
      const orphans = all.rows.slice(1).map(r => r.id);
      // Reparent everything from orphans → primary. Targets need name uniqueness
      // collapse, so reparent then dedupe.
      let mentionsMoved = 0, targetsMoved = 0, threatsMoved = 0, dropped = 0;
      for (const o of orphans) {
        const ms = await pool.query('UPDATE mentions SET customer_id = $1 WHERE customer_id = $2', [primary, o]);
        mentionsMoved += ms.rowCount;
        const ts = await pool.query('UPDATE threat_events SET customer_id = $1 WHERE customer_id = $2', [primary, o]);
        threatsMoved += ts.rowCount;
        // Targets: reparent BUT collide with the unique (customer_id, name) index.
        // Strategy: drop orphan targets that have a name-twin under primary;
        // reparent the rest.
        const tgts = await pool.query('SELECT id, name FROM targets WHERE customer_id = $1', [o]);
        for (const tg of tgts.rows) {
          const dupe = await pool.query('SELECT id FROM targets WHERE customer_id = $1 AND name = $2', [primary, tg.name]);
          if (dupe.rowCount > 0) {
            // Repoint mentions that point to this orphan target, then drop the orphan target row.
            await pool.query('UPDATE mentions SET target_id = $1 WHERE target_id = $2', [dupe.rows[0].id, tg.id]);
            await pool.query('UPDATE threat_events SET target_id = $1 WHERE target_id = $2', [dupe.rows[0].id, tg.id]);
            await pool.query('DELETE FROM targets WHERE id = $1', [tg.id]);
            dropped++;
          } else {
            await pool.query('UPDATE targets SET customer_id = $1 WHERE id = $2', [primary, tg.id]);
            targetsMoved++;
          }
        }
        await pool.query('DELETE FROM customers WHERE id = $1', [o]);
      }
      result.push({ name: d.name, primary, orphans_dropped: orphans.length, mentions_moved: mentionsMoved, targets_moved: targetsMoved, threats_moved: threatsMoved, target_dupes_dropped: dropped });
    }
    res.json({ ok: true, consolidated: result.length, details: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open threat queue. CROSS-CUSTOMER read — admin gate.
app.get('/api/_smoke/threats', requireSmokeAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT te.id, te.tier, te.status, te.created_at, te.alerted_at,
             m.body_excerpt, m.source, m.source_url, m.s3_key,
             c.name AS customer_name, t.name AS target_name
      FROM threat_events te
      JOIN mentions m ON m.id = te.mention_id
      JOIN customers c ON c.id = te.customer_id
      LEFT JOIN targets t ON t.id = te.target_id
      ORDER BY te.tier DESC, te.created_at DESC
      LIMIT 100
    `);
    res.json({ count: r.rowCount, threats: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── One-click threat acknowledgment from email ──────────────────────
// Tokenized link from alert emails. Marks threat_event status='reviewing'
// without requiring login — designed for the 3am-incident case where
// scrolling the dashboard is too much friction. Token is HMAC-signed
// with 14d TTL.
function renderAckPage(title, body, color = '#0a0f1a') {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title} — Sentinel</title>
<style>body{margin:0;background:#0a0f1a;color:#e6edf3;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#0e1422;border:1px solid #1c2330;border-radius:8px;padding:32px;max-width:520px;text-align:center}
.dot{width:48px;height:48px;border-radius:50%;background:${color};margin:0 auto 18px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:600}
h1{margin:0 0 8px;font-size:22px}p{color:#cdd5e0;line-height:1.6;margin:8px 0}a{color:#4f9af0}
button{background:#3a9c3a;color:#fff;border:0;padding:14px 28px;border-radius:6px;cursor:pointer;font-size:15px;font-weight:600}
</style></head><body><div class="card">${body}</div></body></html>`;
}
function _escAck(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function _loadThreatForAck(token) {
  const { verifyActionToken } = require('./lib/auth');
  const sess = verifyActionToken(token, 'threat_ack');
  if (!sess) return { ok: false, reason: 'invalid' };
  const q = await pool.query(`
    SELECT te.id, te.tier, te.status, m.body_excerpt, t.name AS target_name
    FROM threat_events te
    JOIN mentions m ON m.id = te.mention_id
    LEFT JOIN targets t ON t.id = te.target_id
    WHERE te.id = $1 LIMIT 1
  `, [sess.id]);
  if (!q.rowCount) return { ok: false, reason: 'notfound' };
  return { ok: true, event: q.rows[0] };
}

// GET shows a confirmation page with a POST button. Critical: do NOT
// mutate state on GET — Gmail / Outlook / virus scanners pre-fetch all
// links in incoming email, which would auto-acknowledge threats.
app.get('/threat-ack/:token', async (req, res) => {
  try {
    const r = await _loadThreatForAck(req.params.token);
    if (!r.ok) {
      const msg = r.reason === 'notfound' ? 'Threat event not found.' : 'Link expired or invalid.';
      return res.status(r.reason === 'notfound' ? 404 : 401).send(renderAckPage('Invalid', `<div class="dot" style="background:#7a1019">!</div><h1>${_escAck(msg)}</h1><p><a href="/dashboard">Open dashboard</a></p>`));
    }
    const ev = r.event;
    if (ev.status !== 'open') {
      return res.send(renderAckPage('Already handled', `<div class="dot" style="background:#3a9c3a">OK</div><h1>Already in progress</h1><p>This threat is currently in status <strong>${_escAck(ev.status)}</strong>. No further action needed.</p><p><a href="/dashboard/threats/${_escAck(ev.id)}">Open in dashboard</a></p>`, '#3a9c3a'));
    }
    res.send(renderAckPage('Confirm', `<h1>Acknowledge this threat?</h1>
      <p>Tier ${_escAck(ev.tier)} threat against <strong>${_escAck(ev.target_name || 'unknown')}</strong>.</p>
      <p style="font-size:13px;color:#8b949e;background:#0a0f1a;padding:10px 14px;border-radius:4px;margin:18px 0;border:1px solid #1c2330;text-align:left">${_escAck((ev.body_excerpt || '').slice(0, 240))}</p>
      <form method="POST" action="/threat-ack/${_escAck(req.params.token)}">
        <button type="submit">Acknowledge — mark as reviewing</button>
      </form>
      <p style="font-size:12px;color:#8b949e;margin-top:18px">This marks the threat as <em>reviewing</em> without requiring login. You can still log in afterward to add notes or change disposition.</p>`, '#1a3a5c'));
  } catch (e) {
    console.error('[threat-ack GET]', e.message);
    res.status(500).send(renderAckPage('Error', `<div class="dot" style="background:#7a1019">!</div><h1>Error</h1><p>${_escAck(e.message)}</p>`));
  }
});

// POST actually marks the threat as reviewing. Idempotent — re-POSTing
// is a no-op once status changes from 'open'.
app.post('/threat-ack/:token', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const r = await _loadThreatForAck(req.params.token);
    if (!r.ok) {
      return res.status(401).send(renderAckPage('Invalid', `<div class="dot" style="background:#7a1019">!</div><h1>Link expired or invalid</h1><p><a href="/dashboard">Open dashboard</a></p>`));
    }
    const ev = r.event;
    if (ev.status !== 'open') {
      return res.send(renderAckPage('Already handled', `<div class="dot" style="background:#3a9c3a">OK</div><h1>Already in progress</h1><p>Status: <strong>${_escAck(ev.status)}</strong>.</p><p><a href="/dashboard/threats/${_escAck(ev.id)}">Open in dashboard</a></p>`, '#3a9c3a'));
    }
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    await pool.query(`
      UPDATE threat_events
      SET status = 'reviewing',
          notes = CASE WHEN notes IS NULL OR notes = '' THEN $2 ELSE notes || E'\\n' || $2 END
      WHERE id = $1 AND status = 'open'
    `, [ev.id, `[${stamp}] [email-ack from ${ip || 'unknown ip'}] → reviewing (one-click link)`]);
    res.send(renderAckPage('Acknowledged', `<div class="dot" style="background:#3a9c3a">OK</div>
      <h1>Acknowledged</h1>
      <p>Tier ${_escAck(ev.tier)} threat against <strong>${_escAck(ev.target_name || 'unknown')}</strong> is now marked <strong>reviewing</strong>.</p>
      <p style="margin-top:18px"><a href="/dashboard/threats/${_escAck(ev.id)}">Open in dashboard</a> to add notes or change disposition.</p>`, '#3a9c3a'));
  } catch (e) {
    console.error('[threat-ack POST]', e.message);
    res.status(500).send(renderAckPage('Error', `<div class="dot" style="background:#7a1019">!</div><h1>Error</h1><p>${_escAck(e.message)}</p>`));
  }
});

// ── Public status page ─────────────────────────────────────────────
// Read-only — no auth, no PII. Two endpoints: /status (HTML) and
// /status.json (machine-readable). Suitable for uptime monitors.
async function buildStatus() {
  const t0 = Date.now();
  let dbOk = false; let dbMs = null;
  try {
    await pool.query('SELECT 1');
    dbMs = Date.now() - t0; dbOk = true;
  } catch (_) {}

  let workers = [];
  if (dbOk) {
    try {
      const r = await pool.query(`
        SELECT DISTINCT ON (worker_name) worker_name, started_at, duration_ms, ok
        FROM worker_runs ORDER BY worker_name, started_at DESC
      `);
      workers = r.rows.map(w => ({
        name: w.worker_name,
        last_run_at: w.started_at,
        last_run_ms: w.duration_ms,
        last_run_ok: w.ok,
        seconds_since: Math.floor((Date.now() - new Date(w.started_at).getTime()) / 1000)
      }));
    } catch (_) {}
  }

  return {
    service: 'sentinel',
    version: require('./package.json').version,
    timestamp: new Date().toISOString(),
    db: { ok: dbOk, ms: dbMs },
    workers
  };
}
app.get('/status.json', async (req, res) => {
  const s = await buildStatus();
  res.json(s);
});
app.get('/status', async (req, res) => {
  const s = await buildStatus();
  const ago = (sec) => sec == null ? 'never' : (sec < 60 ? sec + 's ago' : sec < 3600 ? Math.floor(sec/60) + 'm ago' : sec < 86400 ? Math.floor(sec/3600) + 'h ago' : Math.floor(sec/86400) + 'd ago');
  const escapeHtml = (str) => String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const dot = (ok) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${ok?'#3a9c3a':'#a82a2a'};margin-right:8px;vertical-align:middle"></span>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Sentinel — status</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0a0f1a;color:#e6edf3;max-width:680px;margin:40px auto;padding:0 24px}h1{margin:0 0 4px}h2{margin:24px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#8b949e}.row{display:flex;align-items:center;padding:8px 0;border-bottom:1px solid #1c2330;font-size:14px}.row span:first-child{flex:1}.muted{color:#8b949e;font-size:12px}</style>
</head><body>
<h1>Sentinel — status</h1>
<div class="muted">${escapeHtml(s.timestamp)} · v${escapeHtml(s.version)}</div>
<h2>Service</h2>
<div class="row">${dot(s.db.ok)}<span>API + DB</span><span class="muted">${s.db.ok ? 'reachable in ' + s.db.ms + 'ms' : 'unreachable'}</span></div>
<h2>Workers</h2>
${s.workers.length ? s.workers.map(w => `<div class="row">${dot(w.last_run_ok)}<span>${escapeHtml(w.name)}</span><span class="muted">${ago(w.seconds_since)} · ${w.last_run_ms || 0}ms</span></div>`).join('') : '<div class="muted">No worker runs logged yet (system just booted).</div>'}
<h2 style="margin-top:32px">About</h2>
<div class="muted">
Sentinel — a product of Parallax Advisory LLC. Defensive social-media + threat-monitoring for Democratic and Indy-aligned political campaigns.
This page reports operational health only — no customer data is exposed.
</div>
</body></html>`);
});

// ── Customer-facing dashboard + auth routes ────────────────────────
// Mounted at root so routes are at /login, /dashboard, /dashboard/...
app.use(require('./routes/dashboard')(pool));

// ── Internal admin (Basic auth via ADMIN_PASSWORD) ─────────────────
app.use(require('./routes/admin')(pool));

// ── Customer-facing public API (Bearer token auth) ─────────────────
app.use(require('./routes/api')(pool));

// Public landing page at root. Authed visitors get bounced straight to
// /dashboard via the session-cookie check; unauthed visitors get a
// one-page marketing splash + beta-access form.
app.get('/', async (req, res) => {
  // Cheap session check — if the cookie validates, redirect to dashboard.
  try {
    const { readSessionCookie, verifySession } = require('./lib/auth');
    const tok = readSessionCookie(req);
    if (tok && verifySession(tok)) return res.redirect('/dashboard');
  } catch (_) { /* fall through to landing page */ }

  const flash = req.query.thanks === '1'
    ? '<div style="background:#1a4a1a;color:#7fff7f;padding:14px 20px;border-radius:8px;margin-bottom:24px;text-align:center;font-size:15px"><strong>Got it.</strong> We\'ll be in touch within 24 hours to schedule a 30-minute walkthrough.</div>'
    : (req.query.err === '1' ? '<div style="background:#5e0e16;color:#fff;padding:12px 20px;border-radius:8px;margin-bottom:24px;text-align:center">Something went wrong submitting the form. Please email <a style="color:#fff" href="mailto:david@parallaxadvisory.llc">david@parallaxadvisory.llc</a> instead.</div>' : '');

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel — defensive monitoring for political campaigns</title>
<meta name="description" content="Sentinel watches Reddit, Bluesky, news, X, Telegram, and TruthSocial for threats and harassment against your candidate, family, and staff. Real-time tier-3 alerts.">
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: Inter, system-ui, -apple-system, sans-serif; background:#0a0f1a; color:#e6edf3; line-height:1.6 }
  a { color:#4f9af0; text-decoration:none } a:hover { text-decoration:underline }
  .nav { padding:18px 28px; display:flex; align-items:center; gap:24px; border-bottom:1px solid #1c2330 }
  .brand { font-weight:700; letter-spacing:.06em }
  .nav .right { margin-left:auto; font-size:14px }
  .hero { max-width:840px; margin:0 auto; padding:64px 28px 32px; text-align:center }
  .hero h1 { font-size:42px; line-height:1.15; margin:0 0 16px }
  .hero h1 .accent { color:#4f9af0 }
  .hero p.lede { font-size:18px; color:#cdd5e0; max-width:640px; margin:0 auto 24px }
  .container { max-width:840px; margin:0 auto; padding:0 28px }
  .row { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px; margin:32px 0 }
  .feature { background:#0e1422; border:1px solid #1c2330; border-radius:8px; padding:18px }
  .feature h3 { margin:0 0 6px; font-size:15px; text-transform:uppercase; letter-spacing:.05em; color:#8b949e }
  .feature p { margin:0; font-size:14px; color:#cdd5e0 }
  .tiers { background:#0e1422; border:1px solid #1c2330; border-radius:8px; padding:24px; margin:32px 0 }
  .tier { padding:10px 0; border-bottom:1px solid #1c2330; display:flex; align-items:flex-start; gap:14px }
  .tier:last-child { border-bottom:0 } .tier-label { font-weight:600; min-width:120px }
  .tier-1 .tier-label { color:#8b949e } .tier-2 .tier-label { color:#d8902f }
  .tier-3 .tier-label { color:#e57e3a } .tier-4 .tier-label { color:#ff7080 }
  .tier .desc { font-size:14px; color:#cdd5e0 }
  .form-card { background:linear-gradient(180deg, #1a3a5c 0%, #0e1422 100%); border:1px solid #2a5a8c; border-radius:12px; padding:28px; margin:24px 0 48px }
  .form-card h2 { margin:0 0 6px; font-size:22px; color:#e6edf3 }
  .form-card .sub { color:#cdd5e0; font-size:14px; margin-bottom:18px }
  .field { margin-bottom:14px }
  .field label { display:block; color:#cdd5e0; font-size:13px; margin-bottom:5px }
  .field input, .field textarea, .field select {
    width:100%; background:#0a0f1a; border:1px solid #2a5a8c; color:#e6edf3;
    padding:10px 12px; border-radius:5px; font-size:14px; font-family:inherit
  }
  .field textarea { min-height:80px; resize:vertical }
  .actions button { background:#4f9af0; color:#fff; border:0; padding:12px 24px; border-radius:5px; font-size:15px; font-weight:500; cursor:pointer }
  .actions button:hover { background:#3a85d8 }
  footer { padding:32px 28px; text-align:center; color:#5b6573; font-size:12px; border-top:1px solid #1c2330; margin-top:48px }
</style>
</head><body>
<div class="nav">
  <div class="brand">SENTINEL</div>
  <div class="right">
    <a href="/login">Customer login</a>
  </div>
</div>

<div class="hero">
  <h1>Defensive social-media monitoring<br>for political campaigns.</h1>
  <p class="lede">Sentinel watches public posts on <strong>Reddit, Bluesky, news, X, Telegram, and TruthSocial</strong> for mentions of your candidate, family, and staff. Threats and doxxing get a real-time email or Slack alert in under 5 minutes. Hostile rhetoric lands in a daily review queue. Noise stays out of your inbox.</p>
</div>

<div class="container">
  ${flash}

  <div class="row">
    <div class="feature">
      <h3>What we watch</h3>
      <p>Reddit · Bluesky · Google News · X (twitterapi.io) · Telegram · TruthSocial. Public posts only. Per-target search + curated extremist-channel monitoring.</p>
    </div>
    <div class="feature">
      <h3>How we classify</h3>
      <p>Every mention runs through a 4-tier threat rubric. Conservative-bias model: when in doubt, escalate. Reviewer feedback feeds back into the rubric.</p>
    </div>
    <div class="feature">
      <h3>How you're alerted</h3>
      <p>Email + optional Slack/PagerDuty/custom-webhook for tier 3+. HMAC-signed payloads. Daily 7am digest of all activity. Evidence preserved on AWS S3 (Glacier after 90d) for legal hand-off.</p>
    </div>
  </div>

  <div class="tiers">
    <h2 style="margin:0 0 14px;font-size:18px">The 4-tier rubric</h2>
    <div class="tier tier-1"><div class="tier-label">Tier 1 — noise</div><div class="desc">Routine criticism, mocking, dismissive content. Indexed for analytics; no alerts.</div></div>
    <div class="tier tier-2"><div class="tier-label">Tier 2 — hostile</div><div class="desc">Personal attacks, dehumanizing language, family attacks. Lands in your review queue for human triage.</div></div>
    <div class="tier tier-3"><div class="tier-label">Tier 3 — credible</div><div class="desc">Specific threats, doxxing of address/school/employer, calls for in-person confrontation. Real-time email alert in under 5 minutes.</div></div>
    <div class="tier tier-4"><div class="tier-label">Tier 4 — imminent</div><div class="desc">Time-bound threats with location and weapon mentioned. Same as Tier 3 plus optional Slack/PagerDuty.</div></div>
  </div>

  <div class="form-card">
    <h2>Request beta access</h2>
    <div class="sub">Friendly cohort. $0/mo during beta (June 15 – September 15). 30-min Zoom walkthrough to scope your target list.</div>
    <form method="POST" action="/beta-request">
      <div class="field"><label for="campaign_name">Campaign / organization</label>
        <input id="campaign_name" name="campaign_name" type="text" required placeholder="e.g. Jolly for Governor"></div>
      <div class="field"><label for="contact_name">Your name</label>
        <input id="contact_name" name="contact_name" type="text" placeholder="optional"></div>
      <div class="field"><label for="contact_email">Email</label>
        <input id="contact_email" name="contact_email" type="email" required placeholder="you@campaign.com"></div>
      <div class="field"><label for="role">Your role</label>
        <input id="role" name="role" type="text" placeholder="Campaign manager, chief of staff, comms director, etc."></div>
      <div class="field"><label for="state">State (postal abbreviation, optional)</label>
        <input id="state" name="state" type="text" maxlength="2" placeholder="NH" style="text-transform:uppercase"></div>
      <div class="field"><label for="message">What threats / harassment are you currently dealing with?</label>
        <textarea id="message" name="message" placeholder="Optional context — helps us scope the conversation."></textarea></div>
      <div class="actions"><button type="submit">Request access</button></div>
    </form>
  </div>

  <p style="text-align:center;color:#8b949e;font-size:13px;margin:24px 0 0">
    Already a customer? <a href="/login">Log in here</a>.
  </p>
</div>

<footer>
  Sentinel · a product of Parallax Advisory LLC<br>
  Sentinel is a monitoring tool, not a security service. Best-effort classification can miss credible threats. Customers retain responsibility for security posture and law-enforcement coordination.
</footer>
</body></html>`);
});

// Beta-request form handler. Captures lead, stores in beta_leads,
// redirects with thanks message. Visible in /admin (via SQL query for
// now; future /admin/leads page).
app.post('/beta-request', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
  try {
    const { campaign_name, contact_name, contact_email, role, state, message } = req.body || {};
    if (!campaign_name || !contact_email) return res.redirect('/?err=1');
    if (!/.+@.+\..+/.test(contact_email)) return res.redirect('/?err=1');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').slice(0, 500);
    const cleanState = String(state || '').toUpperCase().trim();
    await pool.query(`
      INSERT INTO beta_leads (campaign_name, contact_name, contact_email, role, state, message, ip, user_agent, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new')
    `, [
      String(campaign_name).slice(0, 200),
      contact_name ? String(contact_name).slice(0, 200) : null,
      String(contact_email).toLowerCase().slice(0, 200),
      role ? String(role).slice(0, 200) : null,
      /^[A-Z]{2}$/.test(cleanState) ? cleanState : null,
      message ? String(message).slice(0, 4000) : null,
      ip || null,
      ua || null
    ]);
    res.redirect('/?thanks=1');
  } catch (e) {
    console.error('[beta-request]', e.message);
    res.redirect('/?err=1');
  }
});

// ── In-process scheduler ────────────────────────────────────────────
// At v1 scale we run the ingest + alert workers directly inside the
// web process via setInterval. Single dyno, no separate Render Cron
// services needed. Each worker's processOne is idempotent (dupe-skip
// via UNIQUE(source, source_id)) so overlapping runs are safe.
//
// Disabled by default in non-production unless SCHEDULER_ENABLED=true.
// Production (NODE_ENV=production on Render) auto-enables.
const SCHEDULES = [
  { name: 'alert',   intervalMs:  60 * 1000,         startupDelayMs:  5 * 1000, run: () => require('./workers/alert').runOnce({ pool, log: scheduledLog('alert') }) },
  { name: 'bluesky', intervalMs:  5 * 60 * 1000,     startupDelayMs: 30 * 1000, run: () => require('./workers/bluesky').runOnce({ pool, log: scheduledLog('bluesky') }) },
  { name: 'reddit',  intervalMs: 10 * 60 * 1000,     startupDelayMs: 60 * 1000, run: () => require('./workers/reddit').runOnce({ pool, log: scheduledLog('reddit') }) },
  { name: 'rss',     intervalMs: 15 * 60 * 1000,     startupDelayMs: 90 * 1000, run: () => require('./workers/rss').runOnce({ pool, log: scheduledLog('rss') }) },
  { name: 'x',         intervalMs:  5 * 60 * 1000,     startupDelayMs: 100 * 1000, run: () => require('./workers/x').runOnce({ pool, log: scheduledLog('x') }) },
  { name: 'telegram',     intervalMs: 10 * 60 * 1000,     startupDelayMs: 110 * 1000, run: () => require('./workers/telegram').runOnce({ pool, log: scheduledLog('telegram') }) },
  { name: 'truthsocial',  intervalMs: 10 * 60 * 1000,     startupDelayMs: 130 * 1000, run: () => require('./workers/truthsocial').runOnce({ pool, log: scheduledLog('truthsocial') }) },
  { name: 'cisa',      intervalMs: 60 * 60 * 1000,     startupDelayMs: 240 * 1000, run: () => require('./workers/cisa').runOnce({ pool, log: scheduledLog('cisa') }) },
  { name: 'digest',  intervalMs: 30 * 60 * 1000,     startupDelayMs: 120 * 1000, run: () => require('./workers/digest').runOnce({ pool, log: scheduledLog('digest') }) },
  { name: 'weekly',  intervalMs:  6 * 60 * 60 * 1000, startupDelayMs: 200 * 1000, run: () => require('./workers/weekly').runOnce({ pool, log: scheduledLog('weekly') }) },
  { name: 'cleanup', intervalMs: 60 * 60 * 1000,     startupDelayMs: 180 * 1000, run: async () => {
      // Multi-table retention sweep, runs every hour.
      const out = {};
      const r1 = await pool.query(`DELETE FROM worker_runs WHERE started_at < NOW() - INTERVAL '7 days'`);
      out.worker_runs = r1.rowCount;
      const r2 = await pool.query(`DELETE FROM operator_audit WHERE created_at < NOW() - INTERVAL '365 days'`);
      out.operator_audit = r2.rowCount;
      const r3 = await pool.query(`DELETE FROM classifier_feedback WHERE created_at < NOW() - INTERVAL '365 days'`);
      out.classifier_feedback = r3.rowCount;
      // CISA AIS TLP rules: don't keep cyber indicators forever. 30 days
      // is conservative; bump if the customer-side cross-referencing
      // ever needs longer history.
      const r4 = await pool.query(`DELETE FROM cyber_indicators WHERE last_seen_at < NOW() - INTERVAL '30 days'`);
      out.cyber_indicators = r4.rowCount;
      // Spam leads: drop after 90 days. Real leads stay forever.
      const r5 = await pool.query(`DELETE FROM beta_leads WHERE status = 'spam' AND created_at < NOW() - INTERVAL '90 days'`);
      out.beta_leads_spam = r5.rowCount;
      return out;
    }
  }
];

function scheduledLog(name) {
  return (m) => console.log(`[sched ${name}] ${m}`);
}

function startScheduler() {
  for (const s of SCHEDULES) {
    setTimeout(() => {
      runWithGuard(s);
      setInterval(() => runWithGuard(s), s.intervalMs);
    }, s.startupDelayMs);
    console.log(`[sched] ${s.name} scheduled every ${s.intervalMs / 1000}s (first run in ${s.startupDelayMs / 1000}s)`);
  }
}

let _running = new Set();
// Per-source error budget. Five consecutive failures pause a worker
// for 30 min — protects against runaway error logs and rate-limit
// burns when an upstream is down. Auto-resume after cooldown.
const _failureCount = new Map();   // workerName → consecutive failures
const _pausedUntil = new Map();    // workerName → epoch ms
const FAIL_THRESHOLD = parseInt(process.env.WORKER_FAIL_THRESHOLD, 10) || 5;
const PAUSE_DURATION_MS = parseInt(process.env.WORKER_PAUSE_DURATION_MS, 10) || 30 * 60 * 1000;

function getPauseInfo() {
  const out = [];
  const now = Date.now();
  for (const [name, until] of _pausedUntil.entries()) {
    if (until > now) out.push({ worker: name, paused_until: new Date(until).toISOString(), remaining_seconds: Math.floor((until - now) / 1000) });
  }
  return out;
}

async function runWithGuard(s) {
  // Don't allow the same worker to overlap with itself — second tick
  // skips silently. Different workers can run in parallel.
  if (_running.has(s.name)) {
    console.log(`[sched ${s.name}] previous run still in flight — skipping this tick`);
    return;
  }
  // Auto-pause guard.
  const pausedUntil = _pausedUntil.get(s.name) || 0;
  if (pausedUntil > Date.now()) {
    console.log(`[sched ${s.name}] paused until ${new Date(pausedUntil).toISOString()} — skipping`);
    return;
  }
  _running.add(s.name);
  const startedAt = new Date();
  const t0 = Date.now();
  let ok = false; let out = null; let err = null;
  try {
    out = await s.run();
    ok = true;
    _failureCount.set(s.name, 0);
    if (_pausedUntil.has(s.name)) _pausedUntil.delete(s.name);
    console.log(`[sched ${s.name}] ${Date.now() - t0}ms`, JSON.stringify(out));
  } catch (e) {
    err = e.message;
    const failures = (_failureCount.get(s.name) || 0) + 1;
    _failureCount.set(s.name, failures);
    if (failures >= FAIL_THRESHOLD) {
      _pausedUntil.set(s.name, Date.now() + PAUSE_DURATION_MS);
      console.error(`[sched ${s.name}] PAUSED for ${PAUSE_DURATION_MS / 1000}s after ${failures} consecutive failures`);
    }
    console.error(`[sched ${s.name}] FAILED (${failures}/${FAIL_THRESHOLD}) after ${Date.now() - t0}ms: ${e.message}`);
  } finally {
    _running.delete(s.name);
    // Best-effort run log; don't propagate DB errors as scheduler errors.
    pool.query(`
      INSERT INTO worker_runs (worker_name, started_at, finished_at, duration_ms, ok, summary, error)
      VALUES ($1, $2, NOW(), $3, $4, $5::jsonb, $6)
    `, [s.name, startedAt, Date.now() - t0, ok, out ? JSON.stringify(out) : null, err]).catch(() => {});
  }
}

// Pause state is inferable from worker_runs (count of consecutive
// ok=false rows from most-recent backwards) — /admin and /status
// query that directly so they stay decoupled from in-process state.
// getPauseInfo above is for internal logging only.

// ── Boot ────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 10000;

(async () => {
  try {
    await initSchema(pool);
    console.log('[sentinel] schema init complete');
  } catch (e) {
    console.error('[sentinel] schema init FAILED:', e.message);
    process.exit(2);
  }

  const enableScheduler = process.env.SCHEDULER_ENABLED === 'true' ||
                          process.env.NODE_ENV === 'production';
  if (enableScheduler) {
    startScheduler();
  } else {
    console.log('[sched] disabled (set SCHEDULER_ENABLED=true to enable)');
  }

  // Bluesky Jetstream firehose — opt-in, off by default. When enabled,
  // the polling worker still runs (useful as a backstop) but the
  // firehose adds <60s latency on top.
  if (process.env.BLUESKY_FIREHOSE_ENABLED === 'true') {
    try {
      const { JetstreamClient } = require('./lib/bluesky-jetstream');
      global._jetstream = new JetstreamClient({ pool, log: (m) => console.log('[jetstream]', m) });
      global._jetstream.start();
      console.log('[jetstream] firehose started (opt-in)');
    } catch (e) {
      console.error('[jetstream] failed to start:', e.message);
    }
  } else {
    console.log('[jetstream] disabled (set BLUESKY_FIREHOSE_ENABLED=true to enable)');
  }

  app.listen(PORT, () => {
    console.log(`[sentinel] listening on :${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
})();

module.exports = { app, pool };
