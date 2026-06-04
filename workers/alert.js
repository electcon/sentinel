// workers/alert.js
// Alert sweep worker. Finds open threat_events that haven't been
// alerted yet and sends a Resend email per event. Runs as a Render
// cron job every 1 minute (latency target: tier 3+ within 5 min of
// classification).
//
// Idempotency: SET alerted_at = NOW() AFTER successful send. If we
// crash between send and update we may double-send — acceptable for
// tier 3+ where false positives are tolerable.
//
// Customer alert routing: prefer alert_routes table (per-customer
// destinations + per-channel min_tier). Fall back to customers.alert_email
// for backward compat.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { sendThreatAlert } = require('../lib/alert');

const MAX_PER_RUN = parseInt(process.env.ALERT_MAX_PER_RUN, 10) || 25;

async function loadRoutes(pool, customerId, tier) {
  // Channel-aware: email + webhook + future SMS.
  const r = await pool.query(`
    SELECT id, channel, destination, secret, label FROM alert_routes
    WHERE customer_id = $1 AND active = TRUE AND min_tier <= $2 AND channel IN ('email', 'webhook', 'slack')
  `, [customerId, tier]);
  if (r.rowCount > 0) return r.rows;
  // Fall back to customer.alert_email as a single email route.
  const c = await pool.query('SELECT alert_email FROM customers WHERE id = $1', [customerId]);
  if (c.rows[0]?.alert_email) return [{ id: null, channel: 'email', destination: c.rows[0].alert_email, secret: null, label: '(default)' }];
  return [];
}

async function runOnce({ pool, log = console.log }) {
  // Pull pending threat events. JOIN through to assemble the email payload
  // in one round-trip. Lock-FOR-UPDATE-SKIP-LOCKED would be nice once we
  // have multiple worker instances; for v1 (single cron) it's unnecessary.
  const r = await pool.query(`
    SELECT te.id          AS event_id,
           te.tier        AS tier,
           te.created_at  AS event_created_at,
           m.id           AS mention_id,
           m.source       AS source,
           m.source_url   AS source_url,
           m.body_excerpt AS body_excerpt,
           m.posted_at    AS posted_at,
           m.author_handle AS author_handle,
           m.s3_key       AS s3_key,
           m.rationale    AS rationale,
           c.id           AS customer_id,
           c.name         AS customer_name,
           t.id           AS target_id,
           t.name         AS target_name,
           t.kind         AS target_kind
    FROM threat_events te
    JOIN mentions m ON m.id = te.mention_id
    JOIN customers c ON c.id = te.customer_id
    LEFT JOIN targets t ON t.id = te.target_id
    WHERE te.alerted_at IS NULL
      AND te.status NOT IN ('dismissed')
    ORDER BY te.tier DESC, te.created_at ASC
    LIMIT $1
  `, [MAX_PER_RUN]);

  let sent = 0;
  let failed = 0;
  let dryRun = 0;
  for (const row of r.rows) {
    const routes = await loadRoutes(pool, row.customer_id, row.tier);
    if (!routes.length) {
      log(`[alert] no routes for customer ${row.customer_id} — skipping event ${row.event_id}`);
      continue;
    }

    let allOk = true;
    for (const route of routes) {
      const out = await sendThreatAlert({
        channel: route.channel,
        destination: route.destination,
        secret: route.secret,
        customerId: row.customer_id,
        eventId: row.event_id,
        tier: row.tier,
        target: { name: row.target_name, kind: row.target_kind },
        customer: { name: row.customer_name },
        mention: {
          source: row.source,
          source_url: row.source_url,
          body_excerpt: row.body_excerpt,
          posted_at: row.posted_at,
          author_handle: row.author_handle,
          s3_key: row.s3_key
        },
        rationale: row.rationale
      });
      if (out.dryRun) dryRun++;
      if (!out.ok) {
        allOk = false;
        log(`[alert] send FAILED via ${route.channel} to ${route.destination}: ${out.error}`);
        if (route.id) await pool.query('UPDATE alert_routes SET last_error = $2 WHERE id = $1', [route.id, out.error.slice(0, 500)]).catch(() => {});
      } else {
        log(`[alert] sent T${row.tier} via ${route.channel} → ${route.destination}${out.dryRun ? ' (dry-run)' : ''}`);
        if (route.id) await pool.query('UPDATE alert_routes SET last_sent_at = NOW(), last_error = NULL WHERE id = $1', [route.id]).catch(() => {});
      }
    }

    if (allOk) {
      await pool.query('UPDATE threat_events SET alerted_at = NOW(), status = CASE WHEN status = $2 THEN $3 ELSE status END WHERE id = $1', [
        row.event_id, 'open', 'reviewing'
      ]);
      sent++;
    } else {
      failed++;
    }
  }

  return { processed: r.rowCount, sent, failed, dry_run: dryRun };
}

module.exports = { runOnce };

if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(2); }
  const useSSL = /render\.com/.test(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 3
  });
  runOnce({ pool })
    .then(s => { console.log('[alert] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[alert] FATAL:', e.message); pool.end(); process.exit(1); });
}
