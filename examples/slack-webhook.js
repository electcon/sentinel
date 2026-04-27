// examples/slack-webhook.js
// Reference receiver: takes a Sentinel webhook alert + posts to Slack.
// Run on any Node-capable host (Vercel, Render, Cloudflare Workers,
// AWS Lambda + API Gateway, etc.). Verifies the HMAC-SHA256 signature
// against the per-route secret you copied from Sentinel's
// /dashboard/settings page when you created the alert route.
//
// FOR THE CUSTOMER SIDE — NOT A SENTINEL DEPENDENCY.
//
// Environment:
//   SENTINEL_WEBHOOK_SECRET       The secret shown in Sentinel's
//                                 alert-route management UI. Rotate
//                                 it via the "Rotate secret" button
//                                 and update this env var to match.
//   SLACK_WEBHOOK_URL             Your Slack incoming-webhook URL
//                                 (https://hooks.slack.com/services/...)
//                                 — create one in your Slack workspace
//                                 at https://api.slack.com/apps
//
// Drop this onto any Node host. Example minimal Express receiver below.
//
// Tier color mapping (Slack attachment 'color' field):
//   Tier 4 (imminent violence)  → #7a1019  (deep red)
//   Tier 3 (credible threat)    → #d8902f  (amber)
//
// Sentinel webhook envelope (what arrives in req.body):
//   {
//     type: 'threat_alert.v1',
//     sent_at: '2026-04-27T...',
//     tier: 3,
//     customer: { id, name },
//     target:  { name, kind },
//     mention: { source, source_url, author_handle, posted_at,
//                body_excerpt, s3_key },
//     rationale: '...',
//     threat_event_id: '<uuid>',
//     dashboard_url: 'https://sentinel.parallaxadvisory.llc/dashboard'
//   }
//
// Headers Sentinel sends:
//   X-Sentinel-Tier:       '3' or '4'
//   X-Sentinel-Customer:   '<customer uuid>'
//   X-Sentinel-Event-Id:   '<threat_event uuid>'
//   X-Sentinel-Signature:  'sha256=<hex hmac of raw body>'
//
// Verification: compute HMAC-SHA256 of the RAW request body using your
// SENTINEL_WEBHOOK_SECRET and compare to the X-Sentinel-Signature
// header (after stripping the 'sha256=' prefix).

'use strict';

const crypto = require('crypto');
const express = require('express');

const SENTINEL_WEBHOOK_SECRET = process.env.SENTINEL_WEBHOOK_SECRET;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!SENTINEL_WEBHOOK_SECRET) { console.error('SENTINEL_WEBHOOK_SECRET not set'); process.exit(2); }
if (!SLACK_WEBHOOK_URL) { console.error('SLACK_WEBHOOK_URL not set'); process.exit(2); }

const app = express();

// IMPORTANT: capture the raw body for signature verification. If you
// use express.json() before signature check, the parsed object's
// stringified representation will not match the original bytes.
app.use('/sentinel-alert', express.raw({ type: 'application/json', limit: '256kb' }));

app.post('/sentinel-alert', async (req, res) => {
  const sig = req.get('x-sentinel-signature') || '';
  if (!verifySignature(req.body, sig)) {
    return res.status(401).json({ error: 'bad signature' });
  }
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); }
  catch (_) { return res.status(400).json({ error: 'invalid JSON' }); }

  // Don't ack a webhook that fails to post to Slack — Sentinel will
  // retry on the next sweep tick if status code is non-2xx (currently
  // it doesn't retry, but it logs the error in alert_routes.last_error).
  try {
    await postToSlack(payload);
    res.json({ ok: true });
  } catch (e) {
    console.error('[slack post]', e.message);
    res.status(500).json({ error: 'slack post failed: ' + e.message });
  }
});

function verifySignature(rawBody, sigHeader) {
  const expected = 'sha256=' + crypto.createHmac('sha256', SENTINEL_WEBHOOK_SECRET).update(rawBody).digest('hex');
  if (sigHeader.length !== expected.length) return false;
  // Constant-time compare.
  return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
}

async function postToSlack(payload) {
  const tier = payload.tier;
  const color = tier === 4 ? '#7a1019' : tier === 3 ? '#d8902f' : '#999999';
  const tierLabel = tier === 4 ? 'TIER 4 — Imminent violence' : tier === 3 ? 'TIER 3 — Credible threat' : `Tier ${tier}`;

  const slackMessage = {
    attachments: [{
      color,
      title: `${tierLabel} — ${payload.target?.name || 'unknown target'}`,
      title_link: payload.mention?.source_url,
      text: (payload.mention?.body_excerpt || '').slice(0, 1500),
      fields: [
        { title: 'Source', value: payload.mention?.source || 'unknown', short: true },
        { title: 'Author', value: payload.mention?.author_handle || 'unknown', short: true },
        { title: 'Customer', value: payload.customer?.name || 'unknown', short: true },
        { title: 'Posted', value: payload.mention?.posted_at || 'unknown', short: true }
      ],
      footer: payload.rationale ? `Classifier: ${payload.rationale}` : 'Sentinel',
      ts: Math.floor(new Date(payload.sent_at).getTime() / 1000),
      actions: [{
        type: 'button',
        text: 'Open in Sentinel',
        url: `${payload.dashboard_url}/threats/${payload.threat_event_id}`,
        style: 'primary'
      }]
    }]
  };

  const r = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slackMessage)
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`slack ${r.status}: ${body.slice(0, 200)}`);
  }
}

const PORT = parseInt(process.env.PORT, 10) || 3010;
app.listen(PORT, () => console.log(`[slack-bridge] listening on :${PORT}`));
