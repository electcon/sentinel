// lib/welcome.js
// Welcome email — sent to a newly-provisioned customer with their
// login URL + shared password + target list. Used by both the CLI
// (scripts/provision-customer.js) and the /admin/provision web form.
//
// Returns { ok, dryRun?, id?, error? } same shape as alert/digest.
// Dry-run when RESEND_API_KEY unset.

'use strict';

const FROM_EMAIL = process.env.WELCOME_FROM_EMAIL || 'Sentinel <hello@sentinel.parallaxadvisory.llc>';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let _resend = null;
function client() {
  if (_resend === null) {
    if (!process.env.RESEND_API_KEY) { _resend = false; return null; }
    const { Resend } = require('resend');
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend || null;
}

// payload = {
//   to:           string (customer contact email)
//   customerName: string
//   password:     string (plaintext shared password)
//   loginUrl:     string (full https URL to /login)
//   alertEmail:   string
//   digestEmail:  string
//   targets:      [{ name, kind }]
// }
function buildEmail(payload) {
  const subject = `Welcome to Sentinel — ${payload.customerName}`;
  const text = [
    `Welcome to Sentinel.`,
    ``,
    `Your account is provisioned and our ingest workers are now scanning Reddit,`,
    `Bluesky, news, X, and Telegram for mentions of your targets. The first`,
    `mentions usually appear in the dashboard within 15-30 minutes.`,
    ``,
    `Login: ${payload.loginUrl}`,
    `Email: ${payload.to}`,
    `Password: ${payload.password}`,
    ``,
    `(Change the password on first login: Settings -> Change password.)`,
    ``,
    `Alert routing:`,
    `  Tier-3+ real-time alerts -> ${payload.alertEmail}`,
    `  Daily digest -> ${payload.digestEmail}`,
    ``,
    `Targets monitored:`,
    ...((payload.targets || []).map(t => `  - ${t.name} (${t.kind || 'candidate'})`)),
    ``,
    `What you should know:`,
    `  - Tier 1 (noise): visible in /dashboard/mentions, no alerts`,
    `  - Tier 2 (hostile rhetoric): lands in /dashboard/review-queue for human triage`,
    `  - Tier 3+ (credible threat / doxxing / imminent violence): real-time email`,
    `    alert + lands in /dashboard/threats. We aim for under 5 min from post to alert.`,
    ``,
    `If anything looks wrong, reply to this email.`,
    ``,
    `-- David Wheeler`,
    `Sentinel - a product of Parallax Advisory LLC`
  ].join('\n');

  const targetsHtml = (payload.targets || []).map(t =>
    `<li>${escapeHtml(t.name)} <span style="color:#666;font-size:13px">(${escapeHtml(t.kind || 'candidate')})</span></li>`
  ).join('');

  const html = `<!doctype html>
<html><body style="font-family:Inter,system-ui,-apple-system,sans-serif;color:#0a0f1a;max-width:580px;margin:0 auto;padding:24px;line-height:1.5">
  <h1 style="margin:0 0 16px;font-size:22px">Welcome to Sentinel</h1>
  <p>Your account is provisioned and our ingest workers are now scanning Reddit, Bluesky, news, X, and Telegram for mentions of your targets. The first mentions usually appear in the dashboard within 15-30 minutes.</p>

  <div style="background:#f4f6f8;padding:14px 16px;border-radius:6px;margin:16px 0">
    <div style="font-size:12px;color:#5b6573;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Login</div>
    <div style="font-size:16px"><a href="${escapeHtml(payload.loginUrl)}">${escapeHtml(payload.loginUrl)}</a></div>
    <div style="margin-top:8px;font-size:14px">
      <strong>Email:</strong> ${escapeHtml(payload.to)}<br>
      <strong>Password:</strong> <code style="background:#fff;padding:3px 8px;border-radius:3px;font-family:monospace">${escapeHtml(payload.password)}</code>
    </div>
    <div style="font-size:12px;color:#666;margin-top:8px">Change on first login at Settings &rarr; Change password.</div>
  </div>

  <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573;margin-top:24px">Alert routing</h2>
  <ul style="margin:8px 0;padding-left:20px;font-size:14px">
    <li>Tier-3+ real-time alerts &rarr; <code>${escapeHtml(payload.alertEmail)}</code></li>
    <li>Daily digest &rarr; <code>${escapeHtml(payload.digestEmail)}</code></li>
  </ul>

  <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#5b6573;margin-top:24px">Targets monitored</h2>
  <ul style="margin:8px 0;padding-left:20px;font-size:14px">${targetsHtml}</ul>

  <div style="background:#fff7e6;border-left:3px solid #d8902f;padding:12px 14px;font-size:13px;line-height:1.6;margin-top:24px">
    <strong>How tiers work:</strong>
    <ul style="margin:6px 0;padding-left:18px">
      <li><strong>Tier 1</strong> (noise): visible in mentions list, no alerts</li>
      <li><strong>Tier 2</strong> (hostile rhetoric): lands in your <em>review queue</em> for human triage</li>
      <li><strong>Tier 3-4</strong> (credible threat / doxxing / imminent violence): real-time email alert + lands in your <em>threat queue</em>. Target latency: under 5 min from post to alert.</li>
    </ul>
  </div>

  <p style="margin-top:24px;font-size:13px;color:#666">If anything looks wrong, reply to this email.</p>
  <p style="margin-top:8px;font-size:13px;color:#666">&mdash; David Wheeler<br>
  <span style="color:#888;font-size:12px">Sentinel &middot; a product of Parallax Advisory LLC</span></p>
</body></html>`;

  return { subject, text, html };
}

async function sendWelcome(payload) {
  if (!payload.to) return { ok: false, error: 'no recipient' };

  const { subject, text, html } = buildEmail(payload);

  const c = client();
  if (!c) {
    console.log('[welcome] DRY-RUN would send to', payload.to, '|', subject);
    return { ok: true, dryRun: true, to: payload.to, subject };
  }
  try {
    const r = await c.emails.send({ from: FROM_EMAIL, to: payload.to, subject, text, html });
    if (r.error) return { ok: false, error: r.error.message || JSON.stringify(r.error) };
    return { ok: true, id: r.data?.id, to: payload.to, subject };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendWelcome, buildEmail, FROM_EMAIL };
