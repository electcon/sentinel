// workers/cost-anomaly.js
// Daily classifier-spend anomaly detector. For each customer with
// non-zero classifier activity in the last 24h, compute their 24h
// cost and the median of their prior 30 days (excluding the most
// recent 24h window). If the detection rule fires, record a
// cost_anomalies row + email the operator (David) once per anomaly.
//
// Idempotent: skips inserting a duplicate anomaly when an open one
// already exists for the same customer detected within the last 6h.
// (Operators acknowledge to silence; auto-resolution would mask
// recurring problems.)
//
// Hooked into the in-process scheduler (server.js) at hourly cadence.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { detect, median } = require('../lib/cost-anomaly');
const { formatMicroUsd } = require('../lib/classifier-cost');

const DUPE_WINDOW_HOURS = 6;
const NOTIFY_EMAIL = process.env.COST_ANOMALY_NOTIFY_EMAIL || process.env.OPS_NOTIFY_EMAIL || 'david@parallaxadvisory.llc';
const FROM_EMAIL = process.env.COST_ANOMALY_FROM_EMAIL || 'Sentinel <ops@sentinel.parallaxadvisory.llc>';

async function loadCandidates(pool) {
  // Customers with any classifier activity in the last 24h. We don't
  // bother with customers who haven't been touched — anomaly is by
  // definition relative to recent activity.
  const r = await pool.query(`
    SELECT c.id, c.name, c.contact_email
    FROM customers c
    WHERE EXISTS (
      SELECT 1 FROM classifications cl
      WHERE cl.customer_id = c.id
        AND cl.created_at > NOW() - INTERVAL '24 hours'
        AND cl.cost_usd_micro IS NOT NULL
    )
  `);
  return r.rows;
}

async function customerStats(pool, customerId) {
  // last 24h cost
  const r24 = await pool.query(`
    SELECT COALESCE(SUM(cost_usd_micro), 0)::bigint AS cost
    FROM classifications
    WHERE customer_id = $1
      AND created_at > NOW() - INTERVAL '24 hours'
      AND cost_usd_micro IS NOT NULL
  `, [customerId]);
  const cost24 = Number(r24.rows[0].cost) || 0;

  // 30 prior days, EXCLUDING the most recent 24h window.
  const rDays = await pool.query(`
    SELECT (DATE_TRUNC('day', created_at AT TIME ZONE 'UTC'))::date AS day,
           SUM(cost_usd_micro)::bigint AS cost
    FROM classifications
    WHERE customer_id = $1
      AND created_at >  NOW() - INTERVAL '31 days'
      AND created_at <= NOW() - INTERVAL '24 hours'
      AND cost_usd_micro IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `, [customerId]);
  const dailyValues = rDays.rows.map(r => Number(r.cost) || 0);
  // Pad with zeros for any days with no activity, so the median reflects
  // "typical day" not "typical busy day".
  while (dailyValues.length < 30) dailyValues.push(0);
  const med = median(dailyValues);
  return { cost24, median30: med, dailyCount: rDays.rowCount };
}

async function existingOpen(pool, customerId) {
  const r = await pool.query(`
    SELECT id FROM cost_anomalies
    WHERE customer_id = $1 AND status = 'open'
      AND detected_at > NOW() - ($2 || ' hours')::interval
    LIMIT 1
  `, [customerId, DUPE_WINDOW_HOURS]);
  return r.rowCount > 0;
}

async function notifyOperator({ customer, cost24, median30, ratio, jump, reason }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[cost-anomaly] DRY-RUN would email ${NOTIFY_EMAIL} re ${customer.name}`);
    return { ok: true, dryRun: true };
  }
  const ratioLabel = isFinite(ratio) ? ratio.toFixed(1) + '×' : '∞×';
  const dashboardBase = process.env.DASHBOARD_BASE_URL || 'https://sentinel.parallaxadvisory.llc';
  const subject = `[Sentinel ops] ${customer.name} classifier spend anomaly — ${formatMicroUsd(cost24)} in 24h (${ratioLabel} median)`;
  const text = [
    `Classifier spend anomaly detected.`,
    ``,
    `Customer:           ${customer.name} (${customer.id})`,
    `Contact:            ${customer.contact_email || '—'}`,
    ``,
    `Last 24h cost:      ${formatMicroUsd(cost24)}`,
    `30-day median/day:  ${formatMicroUsd(median30)}`,
    `Ratio vs median:    ${ratioLabel}`,
    `Absolute jump:      ${formatMicroUsd(jump)}`,
    `Trigger:            ${reason}`,
    ``,
    `Possible causes:`,
    `  - Hostile flood / coordinated harassment campaign hitting this customer's targets`,
    `  - Worker bug ingesting more posts than usual`,
    `  - Pricing rate change`,
    `  - Test traffic / synthetic data`,
    ``,
    `Drill-down: ${dashboardBase}/admin/customers/${customer.id}`,
    `Acknowledge: ${dashboardBase}/admin/cost-anomalies`,
    ``,
    `— Sentinel ops`
  ].join('\n');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to:   [NOTIFY_EMAIL],
        subject, text
      })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, error: `resend ${r.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function runOnce({ pool, log = console.log }) {
  const candidates = await loadCandidates(pool);
  let scanned = 0, detected = 0, skippedDupe = 0, notified = 0;
  for (const c of candidates) {
    scanned++;
    const stats = await customerStats(pool, c.id);
    const verdict = detect({ cost_24h: stats.cost24, median_daily_30d: stats.median30 });
    if (!verdict.is_anomaly) continue;

    if (await existingOpen(pool, c.id)) { skippedDupe++; continue; }

    const ratioForDb = isFinite(verdict.ratio) ? verdict.ratio : null;
    const ins = await pool.query(`
      INSERT INTO cost_anomalies (customer_id, cost_24h_micro, median_30d_micro, ratio, jump_micro, reason)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [c.id, stats.cost24, stats.median30, ratioForDb, verdict.jump_micro, verdict.reason]);
    const anomalyId = ins.rows[0].id;
    detected++;

    const nr = await notifyOperator({
      customer: c, cost24: stats.cost24, median30: stats.median30,
      ratio: verdict.ratio, jump: verdict.jump_micro, reason: verdict.reason
    });
    if (nr.ok) {
      await pool.query('UPDATE cost_anomalies SET notified_at = NOW() WHERE id = $1', [anomalyId]);
      notified++;
      log(`[cost-anomaly] ${c.name}: ${verdict.reason} ratio=${verdict.ratio} jump=${verdict.jump_micro}μ — notified${nr.dryRun ? ' (dry-run)' : ''}`);
    } else {
      log(`[cost-anomaly] ${c.name}: detected but notify FAILED: ${nr.error}`);
    }
  }
  return { scanned, detected, skipped_dupe: skippedDupe, notified };
}

module.exports = { runOnce };

if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(2); }
  const useSSL = /render\.com/.test(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : false, max: 3 });
  runOnce({ pool })
    .then(s => { console.log('[cost-anomaly] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[cost-anomaly] FATAL:', e.message); pool.end(); process.exit(1); });
}
