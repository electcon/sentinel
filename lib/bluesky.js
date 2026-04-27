// lib/bluesky.js
// Bluesky search client. Uses the public AT Protocol gateway
// (public.api.bsky.app) which serves search-by-keyword without auth
// for low-volume use. Switch to authenticated app-password flow
// (https://bsky.social/xrpc/com.atproto.server.createSession) when
// we need higher quotas.
//
// API surface mirrors lib/reddit.js: search(query, opts) returns a
// flat array of post objects.

'use strict';

const UA = 'Sentinel/0.1 (defensive monitoring for political campaigns; contact: david@parallaxadvisory.llc)';

// Bluesky `searchPosts` returns `{posts:[{uri, cid, author:{handle,did,displayName}, record:{text, createdAt}, indexedAt}]}`.
// We unwrap to source_id = uri (canonical, immutable per-post).
async function search(query, opts) {
  const o = opts || {};
  const params = new URLSearchParams({
    q: query,
    sort: o.sort || 'latest',           // 'latest' | 'top'
    limit: String(Math.min(o.limit || 25, 100))
  });
  if (o.cursor) params.set('cursor', o.cursor);
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?${params.toString()}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`bluesky search ${r.status}: ${body.slice(0, 200)}`);
  }
  const j = await r.json();
  const posts = (j && j.posts) || [];
  return posts.map(p => ({
    id: p.uri,                           // 'at://did:plc:.../app.bsky.feed.post/3lj...'
    text: (p.record && p.record.text) || '',
    author_handle: (p.author && p.author.handle) || '',
    author_did: (p.author && p.author.did) || '',
    permalink: bskyPermalink(p),
    indexed_at: p.indexedAt || null,
    created_at: (p.record && p.record.createdAt) || p.indexedAt || null,
    raw: p
  }));
}

// Map an at://… URI to the public bsky.app permalink format:
//   at://did:plc:abc/app.bsky.feed.post/3lj... → https://bsky.app/profile/<handle>/post/3lj...
function bskyPermalink(p) {
  try {
    const handle = p.author && p.author.handle;
    const uri = p.uri || '';
    const m = uri.match(/\/app\.bsky\.feed\.post\/([^/]+)$/);
    if (handle && m) return `https://bsky.app/profile/${handle}/post/${m[1]}`;
  } catch (_) {}
  return '';
}

module.exports = { search, UA };
