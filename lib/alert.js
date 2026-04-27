// lib/alert.js
// Tier 3+ alert sender. Resend-backed email. Dry-run when
// RESEND_API_KEY is unset (logs the would-send and returns ok=true,
// dryRun=true) so the worker is safe to run in any env.
//
// Email template is intentionally text-heavy and conservative — this
// is an alert that may wake someone at 3am. Lead with target, tier,
// source URL. Don't bury the lede.

'use strict';

const FROM_EMAIL = process.env.ALERT_FROM_EMAIL || 'Sentinel <alerts@voteroi.com>';

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

function tierLabel(tier) {
  if (tier === 4) return 'TIER 4 — Imminent violence';
  if (tier === 3) return 'TIER 3 — Credible threat / doxxing';
  return `TIER ${tier}`;
}

// Build the email subject + html + text from a threat-event payload.
// payload = {
//   tier:       3 | 4
//   target:     { name, kind }
//   customer:   { name }
//   mention:    { source, source_url, body_excerpt, posted_at, author_handle, s3_key }
//   rationale:  short string from classifier
// }
function buildEmail(p) {
  const tag = tierLabel(p.tier);
  const subject = `[${tag}] ${p.target?.name || 'unknown target'} — Sentinel alert`;

  const body = String(p.mention?.body_excerpt || '').slice(0, 1000);
  const url = p.mention?.source_url || '';
  const author = p.mention?.author_handle || 'unknown';
  const posted = p.mention?.posted_at ? new Date(p.mention.posted_at).toISOString() : 'unknown';
  const s3 = p.mention?.s3_key || '(not archived)';

  const text = [
    `${tag}`,
    `Target: ${p.target?.name || 'unknown'} (${p.target?.kind || 'unknown'})`,
    `Customer: ${p.customer?.name || 'unknown'}`,
    '',
    `Source: ${p.mention?.source || 'unknown'}`,
    `Author: ${author}`,
    `Posted: ${posted}`,
    `URL: ${url}`,
    '',
    'Content:',
    body,
    '',
    `Classifier rationale: ${p.rationale || '—'}`,
    '',
    'Suggested next steps:',
    '  1. Review the source post via the URL above.',
    '  2. If credible: report to the platform; document for law enforcement.',
    '  3. Notify candidate protection / chief of staff / spouse per your alert plan.',
    '  4. Mark the case in the Sentinel dashboard once disposition is decided.',
    '',
    `Evidence archive key: ${s3}`,
    '',
    '— Sentinel',
    'This alert was triggered by an automated classifier. Sentinel is a',
    'monitoring tool, not a security service. You retain responsibility',
    'for your security posture and law-enforcement coordination.'
  ].join('\n');

  const html = `<!doctype html>
<html><body style="font-family:Inter,system-ui,-apple-system,sans-serif;color:#0a0f1a;max-width:640px;margin:0 auto;padding:24px">
<div style="background:${p.tier===4?'#7a1019':'#7a4a0a'};color:#fff;padding:14px 18px;border-radius:6px;font-weight:600;letter-spacing:.02em">
${escapeHtml(tag)}
</div>
<h2 style="margin:18px 0 6px">${escapeHtml(p.target?.name || 'unknown target')}</h2>
<div style="color:#5b6573;font-size:14px;margin-bottom:18px">
target kind: ${escapeHtml(p.target?.kind || 'unknown')} · customer: ${escapeHtml(p.customer?.name || 'unknown')}
</div>
<table style="width:100%;font-size:14px;border-collapse:collapse;margin-bottom:18px">
<tr><td style="color:#5b6573;padding:4px 8px 4px 0;width:120px">source</td><td>${escapeHtml(p.mention?.source || 'unknown')}</td></tr>
<tr><td style="color:#5b6573;padding:4px 8px 4px 0">author</td><td>${escapeHtml(author)}</td></tr>
<tr><td style="color:#5b6573;padding:4px 8px 4px 0">posted</td><td>${escapeHtml(posted)}</td></tr>
<tr><td style="color:#5b6573;padding:4px 8px 4px 0">url</td><td><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></td></tr>
</table>
<div style="background:#f4f6f8;padding:14px 16px;border-radius:6px;margin-bottom:18px">
<div style="font-size:12px;color:#5b6573;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Content</div>
<div style="white-space:pre-wrap;font-size:14px">${escapeHtml(body)}</div>
</div>
<div style="font-size:13px;color:#5b6573;margin-bottom:18px">
<strong>Classifier rationale:</strong> ${escapeHtml(p.rationale || '—')}
</div>
<div style="background:#fff7e6;border-left:3px solid #d8902f;padding:12px 14px;font-size:13px;line-height:1.5;margin-bottom:18px">
<strong>Suggested next steps</strong>
<ol style="margin:6px 0 0 18px;padding:0">
<li>Review the source post.</li>
<li>If credible: report to platform + document for law enforcement.</li>
<li>Notify candidate protection per your alert plan.</li>
<li>Mark case disposition in the Sentinel dashboard.</li>
</ol>
</div>
<div style="font-size:11px;color:#7c8694;border-top:1px solid #e3e7ec;padding-top:12px">
Evidence archive key: <code>${escapeHtml(s3)}</code><br>
Sentinel is a monitoring tool, not a security service. Best-effort
classification can miss credible threats. You retain responsibility
for security posture and law-enforcement coordination.
</div>
</body></html>`;

  return { subject, text, html };
}

// sendThreatAlert(payload) → { ok, id?, dryRun?, error? }
async function sendThreatAlert(payload) {
  const to = payload.alertEmail;
  if (!to) return { ok: false, error: 'no alert email' };

  const { subject, text, html } = buildEmail(payload);
  const c = client();
  if (!c) {
    console.log('[alert] DRY-RUN would send to', to, '|', subject);
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

module.exports = { sendThreatAlert, buildEmail, FROM_EMAIL };
