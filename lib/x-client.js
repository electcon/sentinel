// lib/x-client.js
// X (Twitter) search via twitterapi.io. Provider abstraction so we
// can swap in Apify or another reseller in a day if twitterapi.io
// flakes — same risk pattern as any third-party scraper.
//
// API: https://api.twitterapi.io/twitter/tweet/advanced_search
//   - GET, X-API-Key header
//   - params: query (string), queryType ('Latest' | 'Top'), optional
//     since_time / until_time as ISO-ish strings
//   - returns ~20 tweets per request; pagination is broken per their
//     own docs, so use time windows instead
//
// Requires AUP confirmation from twitterapi.io support before use:
// our defensive-monitoring use case is allowed but the AUP language
// is broad. See sentinel_x_ingest_options memory for context.

'use strict';

const PROVIDER = process.env.X_PROVIDER || 'twitterapi.io';
const ENDPOINT_TWITTERAPI = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

async function search(query, opts) {
  if (PROVIDER !== 'twitterapi.io') {
    throw new Error(`X_PROVIDER ${PROVIDER} not implemented yet`);
  }
  return _searchTwitterApiIo(query, opts || {});
}

async function _searchTwitterApiIo(query, opts) {
  const apiKey = process.env.TWITTERAPI_API_KEY;
  if (!apiKey) throw new Error('TWITTERAPI_API_KEY not set');

  const params = new URLSearchParams({
    query: query,
    queryType: opts.sort === 'top' ? 'Top' : 'Latest'
  });
  if (opts.sinceTime) params.set('since_time', opts.sinceTime);
  if (opts.untilTime) params.set('until_time', opts.untilTime);

  const url = `${ENDPOINT_TWITTERAPI}?${params.toString()}`;
  const r = await fetch(url, {
    headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`twitterapi.io ${r.status}: ${body.slice(0, 300)}`);
  }
  const j = await r.json();

  // Response shape — based on docs the tweets array is at the top
  // level under `tweets` or `data`. Be defensive about the wrapper:
  // some examples nest under data.tweets.
  const tweets = j?.tweets || j?.data?.tweets || j?.data || [];
  const list = Array.isArray(tweets) ? tweets : [];
  return list.map(t => normalizeTweet(t));
}

function normalizeTweet(t) {
  const id = String(t.id || t.id_str || '');
  const author = t.author?.userName || t.author?.username || t.user?.screen_name || '';
  const url = t.url || (id && author ? `https://x.com/${author}/status/${id}` : '');
  const created = t.createdAt || t.created_at || null;
  return {
    id,
    text: String(t.text || t.full_text || ''),
    author,
    permalink: url,
    created_at: created ? new Date(created) : null,
    raw: t
  };
}

module.exports = { search, PROVIDER };
