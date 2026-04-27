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

function requireSmokeToken(req, res, next) {
  const tok = req.get('x-smoke-token') || '';
  const expected = process.env.SMOKE_TOKEN || '';
  if (!expected || tok !== expected) return res.status(401).json({ error: 'bad token' });
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

// Idempotent dev-customer seeder. POST to provision the test customer
// and dev targets (Cinde Warmington, Eileen Laubacher, Charlie Crist).
app.post('/api/_smoke/seed-dev', requireSmokeToken, async (req, res) => {
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
// or ?tier=3 filters.
app.get('/api/_smoke/mentions', requireSmokeToken, async (req, res) => {
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

// Trigger one digest sweep. Body: { force: true } bypasses the 23h gap.
app.post('/api/_smoke/digest-run', requireSmokeToken, async (req, res) => {
  try {
    const { runOnce } = require('./workers/digest');
    const force = !!(req.body && req.body.force);
    const summary = await runOnce({ pool, log: console.log, force });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger one alert sweep (sends emails for any open un-alerted tier-3+ events).
app.post('/api/_smoke/alert-run', requireSmokeToken, async (req, res) => {
  try {
    const { runOnce } = require('./workers/alert');
    const summary = await runOnce({ pool, log: console.log });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Inject a synthetic tier-3 (or tier-4) mention + threat_event for the
// dev customer's first target. Lets us test the alert path without
// waiting for a real threatening Reddit post. Body: { tier?: 3|4 }
app.post('/api/_smoke/inject-test-threat', requireSmokeToken, async (req, res) => {
  try {
    const tier = (req.body && (req.body.tier === 4 ? 4 : 3)) || 3;
    const cust = await pool.query(`SELECT id, name, alert_email FROM customers WHERE name = 'Sentinel Dev (test)' LIMIT 1`);
    if (!cust.rowCount) return res.status(400).json({ error: 'dev customer not found — run seed-dev first' });
    const tgt = await pool.query(`SELECT id, name FROM targets WHERE customer_id = $1 LIMIT 1`, [cust.rows[0].id]);
    if (!tgt.rowCount) return res.status(400).json({ error: 'dev target not found' });

    const synthBody = tier === 4
      ? 'I am driving to her event in Concord tomorrow with my rifle. She is not going to walk out of that building alive.'
      : 'She lives at 14 Maple Street in Concord NH. Anyone in the area should pay her a visit and let her know what we think of her family. She wont be safe.';

    const sourceId = 'synth_' + Date.now() + '_t' + tier;
    const ins = await pool.query(`
      INSERT INTO mentions (
        customer_id, target_id, source, source_id, source_url,
        author_handle, posted_at, body_excerpt,
        threat_tier, sentiment, rationale, classifier_v
      ) VALUES (
        $1, $2, 'synth', $3, 'https://example.com/synth',
        'synth_test', NOW(), $4,
        $5, -2, $6, 'tax-v1.2'
      ) RETURNING id
    `, [
      cust.rows[0].id, tgt.rows[0].id, sourceId, synthBody, tier,
      tier === 4 ? 'Synthetic tier-4 test: explicit threat + weapon + time-bound location'
                 : 'Synthetic tier-3 test: doxxing + menacing tone'
    ]);
    const mentionId = ins.rows[0].id;

    await pool.query(`
      INSERT INTO threat_events (mention_id, customer_id, target_id, tier, status)
      VALUES ($1, $2, $3, $4, 'open')
    `, [mentionId, cust.rows[0].id, tgt.rows[0].id, tier]);

    res.json({
      ok: true,
      tier,
      mention_id: mentionId,
      target: tgt.rows[0].name,
      customer: cust.rows[0].name,
      alert_email: cust.rows[0].alert_email,
      next: 'POST /api/_smoke/alert-run to fire the alert email'
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
app.post('/api/_smoke/cleanup-duplicates', requireSmokeToken, async (req, res) => {
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

// Open threat queue.
app.get('/api/_smoke/threats', requireSmokeToken, async (req, res) => {
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
Sentinel is a defensive social-media + threat-monitoring platform for Democratic and Indy-aligned political campaigns.
This page reports operational health only — no customer data is exposed.
</div>
</body></html>`);
});

// ── Customer-facing dashboard + auth routes ────────────────────────
// Mounted at root so routes are at /login, /dashboard, /dashboard/...
app.use(require('./routes/dashboard')(pool));

// ── Internal admin (Basic auth via ADMIN_PASSWORD) ─────────────────
app.use(require('./routes/admin')(pool));

// Root redirects to dashboard (authed) or login (unauthed). The
// dashboard middleware itself handles the redirect by checking the
// session cookie.
app.get('/', (req, res) => res.redirect('/dashboard'));

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
  { name: 'x',       intervalMs:  5 * 60 * 1000,     startupDelayMs: 100 * 1000, run: () => require('./workers/x').runOnce({ pool, log: scheduledLog('x') }) },
  { name: 'digest',  intervalMs: 30 * 60 * 1000,     startupDelayMs: 120 * 1000, run: () => require('./workers/digest').runOnce({ pool, log: scheduledLog('digest') }) },
  { name: 'cleanup', intervalMs: 60 * 60 * 1000,     startupDelayMs: 180 * 1000, run: async () => {
      // Prune worker_runs > 7d so the table doesn't grow unbounded.
      const r = await pool.query(`DELETE FROM worker_runs WHERE started_at < NOW() - INTERVAL '7 days'`);
      return { deleted: r.rowCount };
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

  app.listen(PORT, () => {
    console.log(`[sentinel] listening on :${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
})();

module.exports = { app, pool };
