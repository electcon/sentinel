// workers/weekly.js
// Weekly customer activity report. Runs every 6 hours; only fires
// for customers whose last_weekly_at is null or > 6 days ago AND
// the current UTC day is Sunday (0). Idempotent in the same way as
// digest worker.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { sendWeeklyReport } = require('../lib/weekly-report');

async function ensureColumn(pool) {
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_weekly_at TIMESTAMPTZ`);
}

async function rollupForCustomer(pool, customerId) {
  // Week window: most recent completed Sunday-Saturday window in UTC.
  // Today is Sunday means "last week" was Sun..Sat that just ended.
  const now = new Date();
  const dayOfWeek = now.getUTCDay();                       // 0=Sun .. 6=Sat
  const endOfPrev = new Date(now);
  endOfPrev.setUTCHours(0, 0, 0, 0);
  endOfPrev.setUTCDate(endOfPrev.getUTCDate() - dayOfWeek); // last Sunday 00:00
  const weekEnd = new Date(endOfPrev);                      // last Sunday 00:00 = end of prev Sat 23:59
  const weekStart = new Date(endOfPrev);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);         // prev Sunday 00:00
  const prevWeekStart = new Date(weekStart);
  prevWeekStart.setUTCDate(prevWeekStart.getUTCDate() - 7);

  const [mentions, prevMentions, threats, reviews, topTargets] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE threat_tier = 4)::int AS t4,
             COUNT(*) FILTER (WHERE threat_tier = 3)::int AS t3,
             COUNT(*) FILTER (WHERE threat_tier = 2)::int AS t2,
             COUNT(*) FILTER (WHERE threat_tier = 1)::int AS t1
      FROM mentions WHERE customer_id = $1 AND ingested_at >= $2 AND ingested_at < $3
    `, [customerId, weekStart, weekEnd]),
    pool.query(`SELECT COUNT(*)::int AS total FROM mentions WHERE customer_id = $1 AND ingested_at >= $2 AND ingested_at < $3`,
      [customerId, prevWeekStart, weekStart]),
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM threat_events WHERE customer_id = $1 AND created_at >= $2 AND created_at < $3) AS raised,
        (SELECT COUNT(*)::int FROM threat_events WHERE customer_id = $1 AND status IN ('open', 'reviewing')) AS currently_open,
        (SELECT COUNT(*)::int FROM threat_events WHERE customer_id = $1 AND resolved_at >= $2 AND resolved_at < $3) AS resolved
    `, [customerId, weekStart, weekEnd]),
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE reviewer_action = 'dismissed')::int AS dismissed,
        COUNT(*) FILTER (WHERE reviewer_action = 'escalated')::int AS escalated,
        COUNT(*) FILTER (WHERE reviewer_action = 'ongoing_campaign')::int AS ongoing_campaign
      FROM classifier_feedback
      WHERE customer_id = $1 AND created_at >= $2 AND created_at < $3
    `, [customerId, weekStart, weekEnd]),
    pool.query(`
      SELECT t.name, COUNT(*)::int AS count
      FROM mentions m
      JOIN targets t ON t.id = m.target_id
      WHERE m.customer_id = $1 AND m.ingested_at >= $2 AND m.ingested_at < $3
      GROUP BY t.name
      ORDER BY count DESC LIMIT 5
    `, [customerId, weekStart, weekEnd])
  ]);

  const sourceQ = await pool.query(`
    SELECT source, COUNT(*)::int AS n FROM mentions
    WHERE customer_id = $1 AND ingested_at >= $2 AND ingested_at < $3
    GROUP BY source
  `, [customerId, weekStart, weekEnd]);
  const bySource = {};
  for (const r of sourceQ.rows) bySource[r.source] = r.n;

  const m = mentions.rows[0];
  const t = threats.rows[0];
  const r = reviews.rows[0];
  return {
    week_start: weekStart,
    week_end: new Date(weekEnd.getTime() - 1000),     // visually "Saturday 23:59"
    mentions: { total: m.total, by_tier: { 1: m.t1, 2: m.t2, 3: m.t3, 4: m.t4 }, by_source: bySource },
    prev_week: { total: prevMentions.rows[0].total },
    threats: { raised: t.raised, currently_open: t.currently_open, resolved: t.resolved },
    reviews: { total: r.total, dismissed: r.dismissed, escalated: r.escalated, ongoing_campaign: r.ongoing_campaign },
    top_targets: topTargets.rows.map(t => ({ name: t.name, count: t.count }))
  };
}

async function runOnce({ pool, log = console.log, force = false }) {
  await ensureColumn(pool);

  // Only run when the current UTC day is Sunday (when force=false) — so we
  // dispatch once per week. Force lets the smoke endpoint test any day.
  const dow = new Date().getUTCDay();
  if (!force && dow !== 0) {
    return { skipped: true, reason: 'not_sunday', utc_day: dow };
  }

  // Customers due for weekly: 6+ days since last_weekly_at OR never sent.
  const due = await pool.query(`
    SELECT id, name, digest_email
    FROM customers
    WHERE status IN ('beta', 'active')
      AND digest_email IS NOT NULL
      AND ($1::boolean OR last_weekly_at IS NULL OR last_weekly_at < NOW() - INTERVAL '6 days')
  `, [force]);

  let sent = 0; let dryRun = 0; let failed = 0; let skipped = 0;
  const errorDetails = [];
  for (const c of due.rows) {
    const data = await rollupForCustomer(pool, c.id);
    if (data.mentions.total === 0 && data.threats.raised === 0 && data.reviews.total === 0 && !force) {
      log(`[weekly] skip ${c.name} — nothing to report`);
      skipped++;
      await pool.query('UPDATE customers SET last_weekly_at = NOW() WHERE id = $1', [c.id]);
      continue;
    }
    const out = await sendWeeklyReport({ customer: { id: c.id, name: c.name }, to: c.digest_email, data: { customer: { id: c.id, name: c.name }, ...data } });
    if (out.dryRun) dryRun++;
    if (!out.ok) {
      failed++;
      errorDetails.push({ customer: c.name, error: (out.error || 'unknown').slice(0, 300) });
      log(`[weekly] FAILED for ${c.name}: ${out.error}`);
      continue;
    }
    log(`[weekly] sent → ${c.digest_email}${out.dryRun ? ' (dry-run)' : ''}`);
    sent++;
    await pool.query('UPDATE customers SET last_weekly_at = NOW() WHERE id = $1', [c.id]);
  }

  return { evaluated: due.rowCount, sent, dry_run: dryRun, failed, no_activity: skipped, error_details: errorDetails.slice(0, 5) };
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
    .then(s => { console.log('[weekly] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[weekly] FATAL:', e.message); pool.end(); process.exit(1); });
}
