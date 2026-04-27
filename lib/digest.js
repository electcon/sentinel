// lib/digest.js
// Daily digest email. One per customer, gathers last-24h mention
// activity, groups by source + tier, lists top 10 by tier descending.
//
// Dry-run when RESEND_API_KEY unset (logs would-send + returns
// {ok:true, dryRun:true}). Same pattern as lib/alert.js.

'use strict';

const FROM_EMAIL = process.env.DIGEST_FROM_EMAIL || 'Sentinel <digest@voteroi.com>';

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

// Build digest body from a 24-hour mention rollup.
// data = {
//   customer:      { id, name },
//   windowHours:   24,
//   totalMentions: 0,
//   byTier:        { 1:0, 2:0, 3:0, 4:0 },
//   bySource:      { reddit:0, bluesky:0, rss:0, ... },
//   openThreats:   N,
//   topMentions:   [ {tier, target, source, source_url, body_excerpt, posted_at} ]
// }
function buildEmail(data) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const subject = data.openThreats > 0
    ? `[${data.openThreats} open threat${data.openThreats === 1 ? '' : 's'}] Sentinel digest — ${dateStr}`
    : `Sentinel digest — ${dateStr} — ${data.totalMentions} mentions`;

  const text = [
    `Sentinel daily digest — ${data.customer.name}`,
    `Last ${data.windowHours} hours`,
    '',
    `Total mentions: ${data.totalMentions}`,
    `Open threat events: ${data.openThreats}`,
    '',
    'By tier:',
    `  Tier 4 — imminent violence:        ${data.byTier[4] || 0}`,
    `  Tier 3 — credible threat / doxx:   ${data.byTier[3] || 0}`,
    `  Tier 2 — hostile rhetoric:         ${data.byTier[2] || 0}`,
    `  Tier 1 — noise:                    ${data.byTier[1] || 0}`,
    '',
    'By source:',
    ...Object.entries(data.bySource).map(([k, v]) => `  ${k.padEnd(10)} ${v}`),
    '',
    'Top mentions:',
    ...(data.topMentions.length ? data.topMentions.map(m => [
      `  [T${m.tier}] ${m.target} (${m.source})`,
      `       ${m.source_url}`,
      `       ${(m.body_excerpt || '').slice(0, 200)}`,
      ''
    ].join('\n')) : ['  (none)']),
    '',
    'Open the dashboard to triage tier 2+ events:',
    `  ${process.env.DASHBOARD_BASE_URL || 'https://sentinel-staging-i3ug.onrender.com'}/dashboard`,
    '',
    '— Sentinel'
  ].join('\n');

  const tierRow = (tier, label, count) => `
<tr>
  <td style="padding:6px 12px;color:#5b6573;font-size:13px;width:200px">Tier ${tier} — ${escapeHtml(label)}</td>
  <td style="padding:6px 12px;font-weight:600;font-size:14px;width:60px;text-align:right">${count}</td>
</tr>`;

  const sourceRow = (k, v) => `
<tr><td style="padding:4px 12px;color:#5b6573;font-size:13px">${escapeHtml(k)}</td>
<td style="padding:4px 12px;font-weight:600;text-align:right;font-size:14px">${v}</td></tr>`;

  const topMentionItem = (m) => `
<div style="border-left:3px solid ${m.tier >= 4 ? '#7a1019' : m.tier === 3 ? '#7a4a0a' : m.tier === 2 ? '#a07f1a' : '#7c8694'};padding:8px 12px;margin:8px 0;background:#f4f6f8">
  <div style="font-size:12px;color:#5b6573;text-transform:uppercase;letter-spacing:.05em">[T${m.tier}] ${escapeHtml(m.target)} · ${escapeHtml(m.source)}</div>
  <div style="font-size:14px;margin:4px 0;white-space:pre-wrap">${escapeHtml((m.body_excerpt || '').slice(0, 240))}</div>
  <div style="font-size:12px"><a href="${escapeHtml(m.source_url)}">${escapeHtml(m.source_url)}</a></div>
</div>`;

  const html = `<!doctype html>
<html><body style="font-family:Inter,system-ui,-apple-system,sans-serif;color:#0a0f1a;max-width:680px;margin:0 auto;padding:24px">
<h1 style="margin:0 0 4px;font-size:22px">Sentinel daily digest</h1>
<div style="color:#5b6573;font-size:13px;margin-bottom:18px">${escapeHtml(data.customer.name)} · last ${data.windowHours} hours</div>

${data.openThreats > 0 ? `<div style="background:#fff5f5;border-left:3px solid #7a1019;padding:12px 14px;margin-bottom:18px;font-size:14px">
<strong>${data.openThreats} open threat event${data.openThreats === 1 ? '' : 's'}</strong> in your queue. Triage in the dashboard.
</div>` : ''}

<table style="width:100%;border-collapse:collapse;margin-bottom:18px;background:#f4f6f8;border-radius:6px">
${tierRow(4, 'imminent violence', data.byTier[4] || 0)}
${tierRow(3, 'credible threat / doxxing', data.byTier[3] || 0)}
${tierRow(2, 'hostile rhetoric', data.byTier[2] || 0)}
${tierRow(1, 'noise', data.byTier[1] || 0)}
</table>

<div style="font-size:13px;color:#5b6573;text-transform:uppercase;letter-spacing:.05em;margin-top:18px;margin-bottom:8px">By source</div>
<table style="border-collapse:collapse;font-size:14px">
${Object.entries(data.bySource).map(([k, v]) => sourceRow(k, v)).join('')}
</table>

<div style="font-size:13px;color:#5b6573;text-transform:uppercase;letter-spacing:.05em;margin-top:24px;margin-bottom:8px">Top mentions</div>
${data.topMentions.length ? data.topMentions.map(topMentionItem).join('') : '<div style="color:#7c8694;font-size:13px">No mentions in window.</div>'}

<div style="font-size:11px;color:#7c8694;border-top:1px solid #e3e7ec;padding-top:12px;margin-top:24px">
Sentinel is a monitoring tool, not a security service. Best-effort
classification can miss credible threats. Customers maintain
responsibility for security posture and law-enforcement coordination.
</div>
</body></html>`;

  return { subject, text, html };
}

async function sendDigest({ customer, to, data }) {
  if (!to) return { ok: false, error: 'no digest email' };
  const { subject, text, html } = buildEmail({ customer, ...data });
  const c = client();
  if (!c) {
    console.log('[digest] DRY-RUN would send to', to, '|', subject);
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

module.exports = { sendDigest, buildEmail };
