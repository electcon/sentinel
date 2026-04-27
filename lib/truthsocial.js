// lib/truthsocial.js
// TruthSocial search client. TruthSocial is a Mastodon fork — the
// public-facing API is largely Mastodon-compatible at /api/v1 and /api/v2.
// Search requires authentication (a logged-in service account's bearer
// token). Public timeline endpoints exist but don't support keyword
// search reliably.
//
// AUTHENTICATION:
//   1. Sign up a service account at truthsocial.com (any email; this
//      account never posts, only reads)
//   2. Log in via API once to mint an access token:
//        POST https://truthsocial.com/oauth/token
//        body: { grant_type: 'password', username, password,
//                client_id, client_secret, scope: 'read' }
//      OR sign in via the website and copy the bearer from devtools.
//   3. Set TRUTHSOCIAL_ACCESS_TOKEN on Render.
//
// AUP NOTE: TruthSocial's TOS technically prohibits programmatic
// scraping. We use only the same public-search endpoints their own web
// client uses, with a low query rate (matching customer cadence) and
// no impersonation. This is similar gray-zone to twitterapi.io for X.
// Document the policy in customer onboarding before adding TruthSocial
// to a beta customer's monitoring.

'use strict';

const BASE = process.env.TRUTHSOCIAL_BASE_URL || 'https://truthsocial.com';
const UA = 'Sentinel/0.1 (defensive monitoring; contact: david@parallaxadvisory.llc)';

function isConfigured() {
  return !!process.env.TRUTHSOCIAL_ACCESS_TOKEN;
}

function authHeaders() {
  const token = process.env.TRUTHSOCIAL_ACCESS_TOKEN;
  if (!token) throw new Error('TRUTHSOCIAL_ACCESS_TOKEN not set');
  return { Authorization: `Bearer ${token}`, 'User-Agent': UA, Accept: 'application/json' };
}

// Mastodon /api/v2/search returns { accounts, statuses, hashtags }.
// We only care about statuses for keyword matching against target names.
async function search(query, opts) {
  const o = opts || {};
  const params = new URLSearchParams({
    q: query,
    type: 'statuses',
    limit: String(Math.min(o.limit || 20, 40))
  });
  if (o.resolve) params.set('resolve', 'true');
  const url = `${BASE}/api/v2/search?${params.toString()}`;
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`truthsocial search ${r.status}: ${body.slice(0, 200)}`);
  }
  const j = await r.json();
  const statuses = j?.statuses || [];
  return statuses.map(s => normalizeStatus(s));
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function normalizeStatus(s) {
  return {
    id: String(s.id || s.uri || ''),
    text: stripHtml(s.content || ''),
    author_handle: s.account?.acct || s.account?.username || '',
    permalink: s.url || s.uri || '',
    created_at: s.created_at ? new Date(s.created_at) : null,
    raw: s
  };
}

module.exports = { search, isConfigured, BASE, UA };
