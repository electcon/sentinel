// workers/digest.js
// Daily digest sweep. Runs every 30 min on the in-process scheduler.
// Each tick: find customers whose last_digest_at is null OR > 23h ago
// AND current local hour is in the configured window (default 7-9am
// in their timezone — for v1 we use UTC and assume customers are OK
// with morning UTC delivery; per-customer timezone is v2).
//
// Idempotency: SET last_digest_at = NOW() AFTER successful send.
// If we crash between send and update we may double-send — annoying
// but not catastrophic.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { sendDigest } = require('../lib/digest');

const WINDOW_HOURS = parseInt(process.env.DIGEST_WINDOW_HOURS, 10) || 24;
const MIN_GAP_HOURS = parseInt(process.env.DIGEST_MIN_GAP_HOURS, 10) || 23;
const SEND_HOUR_UTC = parseInt(process.env.DIGEST_SEND_HOUR_UTC, 10);   // null = send anytime gap met

async function ensureLastDigestColumn(pool) {
  // Idempotent column add — first deploy of this worker creates the column.
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_digest_at TIMESTAMPTZ`);
}

async function runOnce({ pool, log = console.log, force = false }) {
  await ensureLastDigestColumn(pool);

  const nowHour = new Date().getUTCHours();
  if (!force && Number.isFinite(SEND_HOUR_UTC) && nowHour !== SEND_HOUR_UTC) {
    log(`[digest] skipped — current UTC hour ${nowHour} != target ${SEND_HOUR_UTC}`);
    return { skipped_reason: 'wrong hour', current_utc_hour: nowHour };
  }

  // Customers due for digest.
  const due = await pool.query(`
    SELECT id, name, digest_email
    FROM customers
    WHERE status IN ('beta', 'active')
      AND digest_email IS NOT NULL
      AND ($1::boolean OR last_digest_at IS NULL OR last_digest_at < NOW() - ($2::int || ' hours')::interval)
  `, [force, MIN_GAP_HOURS]);

  let sent = 0; let dryRun = 0; let failed = 0; let skipped = 0;
  const errorDetails = [];
  for (const c of due.rows) {
    const data = await rollupForCustomer(pool, c.id);
    if (data.totalMentions === 0 && data.openThreats === 0 && data.reviewQueue.pending === 0 && !force) {
      log(`[digest] skip ${c.name} — nothing in window`);
      skipped++;
      // Still set last_digest_at so we don't re-check every 30 min
      await pool.query('UPDATE customers SET last_digest_at = NOW() WHERE id = $1', [c.id]);
      continue;
    }

    const out = await sendDigest({ customer: { id: c.id, name: c.name }, to: c.digest_email, data: { customer: { id: c.id, name: c.name }, ...data } });
    if (out.dryRun) dryRun++;
    if (!out.ok) {
      failed++;
      errorDetails.push({ customer: c.name, error: (out.error || 'unknown').slice(0, 300) });
      log(`[digest] FAILED for ${c.name}: ${out.error}`);
      continue;
    }
    log(`[digest] sent → ${c.digest_email}${out.dryRun ? ' (dry-run)' : ''}`);
    sent++;
    await pool.query('UPDATE customers SET last_digest_at = NOW() WHERE id = $1', [c.id]);
  }

  return { evaluated: due.rowCount, sent, dry_run: dryRun, failed, no_activity: skipped, error_details: errorDetails.slice(0, 5) };
}

async function rollupForCustomer(pool, customerId) {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

  const totals = await pool.query(`
    SELECT threat_tier, source, COUNT(*)::int AS n
    FROM mentions
    WHERE customer_id = $1 AND ingested_at >= $2
    GROUP BY threat_tier, source
  `, [customerId, since]);

  const byTier = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const bySource = {};
  let totalMentions = 0;
  for (const r of totals.rows) {
    const tier = r.threat_tier || 1;
    byTier[tier] = (byTier[tier] || 0) + r.n;
    bySource[r.source] = (bySource[r.source] || 0) + r.n;
    totalMentions += r.n;
  }

  const top = await pool.query(`
    SELECT m.threat_tier AS tier, m.source, m.source_url, m.body_excerpt, m.posted_at, t.name AS target
    FROM mentions m
    LEFT JOIN targets t ON t.id = m.target_id
    WHERE m.customer_id = $1 AND m.ingested_at >= $2
    ORDER BY COALESCE(m.threat_tier, 0) DESC, m.posted_at DESC NULLS LAST
    LIMIT 10
  `, [customerId, since]);

  const openThreats = await pool.query(`
    SELECT COUNT(*)::int AS n FROM threat_events
    WHERE customer_id = $1 AND status NOT IN ('dismissed', 'reported_law_enf', 'monitoring')
  `, [customerId]);

  // Tier-2 review queue: count pending + 3 oldest as samples for the digest.
  const reviewQueueCount = await pool.query(`
    SELECT COUNT(*)::int AS n FROM mentions WHERE customer_id = $1 AND review_status = 'pending'
  `, [customerId]);
  const reviewQueueSamples = await pool.query(`
    SELECT m.id, m.source, m.source_url, m.body_excerpt, m.posted_at, t.name AS target
    FROM mentions m
    LEFT JOIN targets t ON t.id = m.target_id
    WHERE m.customer_id = $1 AND m.review_status = 'pending'
    ORDER BY m.ingested_at ASC
    LIMIT 3
  `, [customerId]);

  return {
    windowHours: WINDOW_HOURS,
    totalMentions,
    byTier,
    bySource,
    openThreats: openThreats.rows[0].n,
    topMentions: top.rows.map(r => ({ tier: r.tier || 1, source: r.source, source_url: r.source_url, body_excerpt: r.body_excerpt, posted_at: r.posted_at, target: r.target || 'unknown' })),
    reviewQueue: {
      pending: reviewQueueCount.rows[0].n,
      oldest: reviewQueueSamples.rows.map(r => ({ id: r.id, source: r.source, source_url: r.source_url, body_excerpt: r.body_excerpt, posted_at: r.posted_at, target: r.target || 'unknown' }))
    }
  };
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
  const force = process.argv.includes('--force');
  runOnce({ pool, force })
    .then(s => { console.log('[digest] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[digest] FATAL:', e.message); pool.end(); process.exit(1); });
}
