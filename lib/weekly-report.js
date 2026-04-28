// lib/weekly-report.js
// Weekly customer activity report. Sent every Sunday 7am UTC.
// Different vibe from the daily digest: focuses on customer ENGAGEMENT
// (what their team did) not just activity. Sticky factor for retention.
//
// Dry-run when RESEND_API_KEY unset (logs the would-send and returns
// {ok:true, dryRun:true}). Same pattern as lib/alert.js + lib/digest.js.

'use strict';

const FROM_EMAIL = process.env.WEEKLY_REPORT_FROM_EMAIL || 'Sentinel <weekly@sentinel.parallaxadvisory.llc>';

let _resend = null;
function client() {
  if (_resend === null) {
    if (!process.env.RESEND_API_KEY) { _resend = false; return null; }
    const { Resend } = require('resend');
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend || null;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// data = {
//   customer:        { id, name },
//   week_start:      Date (Sunday 00:00 UTC, 7d before sent),
//   week_end:        Date (Saturday 23:59 UTC, the just-completed week),
//   mentions:        { total, by_tier: {1:n,2:n,3:n,4:n}, by_source: {reddit:n, ...} },
//   prev_week:       { total }  // for week-over-week %
//   threats:         { raised, currently_open, resolved }
//   reviews:         { total, dismissed, escalated, ongoing_campaign }  // counted from classifier_feedback
//   top_targets:     [ { name, count } ]      // top 5 by mention count
// }
function buildEmail(data) {
  const dateStr = data.week_end.toISOString().slice(0, 10);
  const subject = `Sentinel weekly — ${escapeHtml(data.customer.name)} — week of ${data.week_start.toISOString().slice(0, 10)}`;

  const trend = (() => {
    const cur = data.mentions.total || 0;
    const prev = data.prev_week?.total || 0;
    if (!prev) return cur > 0 ? '↑ first full week of data' : '— no activity';
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (Math.abs(pct) < 5) return '~ flat week-over-week';
    return pct > 0 ? `↑ ${pct}% vs previous week` : `↓ ${Math.abs(pct)}% vs previous week`;
  })();

  const dashboardUrl = process.env.DASHBOARD_BASE_URL || 'https://sentinel.parallaxadvisory.llc';
  const text = [
    `Sentinel weekly report — ${data.customer.name}`,
    `Week of ${data.week_start.toISOString().slice(0, 10)} → ${data.week_end.toISOString().slice(0, 10)}`,
    '',
    `Mentions: ${data.mentions.total} (${trend})`,
    `  Tier 4: ${data.mentions.by_tier[4] || 0}`,
    `  Tier 3: ${data.mentions.by_tier[3] || 0}`,
    `  Tier 2: ${data.mentions.by_tier[2] || 0}`,
    `  Tier 1: ${data.mentions.by_tier[1] || 0}`,
    '',
    `Threats raised: ${data.threats.raised}`,
    `  currently open: ${data.threats.currently_open}`,
    `  resolved this week: ${data.threats.resolved}`,
    '',
    `Your team's review activity:`,
    `  total reviews:     ${data.reviews.total}`,
    `  dismissed:         ${data.reviews.dismissed}`,
    `  escalated to T3:   ${data.reviews.escalated}`,
    `  ongoing-campaign:  ${data.reviews.ongoing_campaign}`,
    '',
    'By source:',
    ...Object.entries(data.mentions.by_source).map(([k, v]) => `  ${k.padEnd(12)} ${v}`),
    '',
    'Top targets by mention volume:',
    ...(data.top_targets.length ? data.top_targets.map((t, i) => `  ${i + 1}. ${t.name} — ${t.count}`) : ['  (no targets had mentions)']),
    '',
    `Open the dashboard: ${dashboardUrl}/dashboard`,
    '',
    '— Sentinel · Parallax Advisory LLC'
  ].join('\n');

  const tierRow = (tier, label, count, color) => `
    <tr>
      <td style="padding:6px 12px;color:#5b6573;font-size:13px;width:200px">Tier ${tier} — ${escapeHtml(label)}</td>
      <td style="padding:6px 12px;font-weight:600;font-size:14px;width:60px;text-align:right;color:${color}">${count}</td>
    </tr>`;

  const topTargetItem = (t, i) => `
    <div style="display:flex;align-items:center;padding:8px 12px;background:#f4f6f8;border-radius:4px;margin-bottom:6px">
      <span style="color:#5b6573;font-size:12px;width:18px">${i + 1}.</span>
      <strong style="flex:1">${escapeHtml(t.name)}</strong>
      <span style="font-weight:600;font-size:14px">${t.count}</span>
    </div>`;

  const html = `<!doctype html>
<html><body style="font-family:Inter,system-ui,-apple-system,sans-serif;color:#0a0f1a;max-width:680px;margin:0 auto;padding:24px">
  <h1 style="margin:0 0 4px;font-size:22px">Weekly report</h1>
  <div style="color:#5b6573;font-size:13px;margin-bottom:18px">${escapeHtml(data.customer.name)} · week of ${data.week_start.toISOString().slice(0, 10)}</div>

  <div style="background:#f4f6f8;padding:16px 18px;border-radius:6px;margin-bottom:18px">
    <div style="font-size:32px;font-weight:700;line-height:1">${data.mentions.total}</div>
    <div style="color:#5b6573;font-size:13px;margin-top:4px">mentions ingested · <em>${escapeHtml(trend)}</em></div>
  </div>

  <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573;margin:24px 0 8px">By tier</h2>
  <table style="width:100%;border-collapse:collapse;background:#f4f6f8;border-radius:6px">
    ${tierRow(4, 'imminent violence', data.mentions.by_tier[4] || 0, '#7a1019')}
    ${tierRow(3, 'credible threat / doxxing', data.mentions.by_tier[3] || 0, '#a04400')}
    ${tierRow(2, 'hostile rhetoric', data.mentions.by_tier[2] || 0, '#7a4a0a')}
    ${tierRow(1, 'noise', data.mentions.by_tier[1] || 0, '#5b6573')}
  </table>

  <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573;margin:24px 0 8px">Threats this week</h2>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
    <div style="background:#fff5f5;border-radius:6px;padding:14px;text-align:center">
      <div style="font-size:24px;font-weight:700;color:#7a1019">${data.threats.raised}</div>
      <div style="color:#5b6573;font-size:12px;margin-top:4px">raised</div>
    </div>
    <div style="background:#fff7e6;border-radius:6px;padding:14px;text-align:center">
      <div style="font-size:24px;font-weight:700;color:#a04400">${data.threats.currently_open}</div>
      <div style="color:#5b6573;font-size:12px;margin-top:4px">still open</div>
    </div>
    <div style="background:#f0f9f0;border-radius:6px;padding:14px;text-align:center">
      <div style="font-size:24px;font-weight:700;color:#3a7a3a">${data.threats.resolved}</div>
      <div style="color:#5b6573;font-size:12px;margin-top:4px">resolved</div>
    </div>
  </div>

  <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573;margin:24px 0 8px">Your team's reviews</h2>
  <div style="background:#f4f6f8;padding:14px 18px;border-radius:6px">
    <div style="font-size:14px;margin-bottom:6px"><strong>${data.reviews.total}</strong> reviewer dispositions this week</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:13px;color:#5b6573;margin-top:10px">
      <div><strong style="color:#0a0f1a">${data.reviews.dismissed}</strong> dismissed</div>
      <div><strong style="color:#0a0f1a">${data.reviews.escalated}</strong> escalated to T3</div>
      <div><strong style="color:#0a0f1a">${data.reviews.ongoing_campaign}</strong> ongoing-campaign</div>
    </div>
  </div>

  <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573;margin:24px 0 8px">Top targets by mention volume</h2>
  ${data.top_targets.length ? data.top_targets.map(topTargetItem).join('') : '<div style="color:#7c8694;font-size:13px;padding:14px;background:#f4f6f8;border-radius:6px">No targets had mentions this week.</div>'}

  <div style="margin-top:32px;text-align:center">
    <a href="${escapeHtml(dashboardUrl)}/dashboard" style="display:inline-block;background:#4f9af0;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;font-weight:500">Open the dashboard</a>
  </div>

  <div style="font-size:11px;color:#7c8694;border-top:1px solid #e3e7ec;padding-top:12px;margin-top:32px;text-align:center">
    Sentinel · a product of Parallax Advisory LLC<br>
    Monitoring tool, not a security service. Best-effort classification can miss credible threats.
  </div>
</body></html>`;

  return { subject, text, html };
}

async function sendWeeklyReport({ customer, to, data }) {
  if (!to) return { ok: false, error: 'no digest email' };
  const { subject, text, html } = buildEmail({ customer, ...data });
  const c = client();
  if (!c) {
    console.log('[weekly] DRY-RUN would send to', to, '|', subject);
    return { ok: true, dryRun: true, to, subject };
  }
  try {
    const r = await c.emails.send({ from: FROM_EMAIL, to, subject, text, html });
    if (r.error) return { ok: false, error: r.error.message || JSON.stringify(r.error) };
    return { ok: true, id: r.data?.id, to, subject };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendWeeklyReport, buildEmail };
