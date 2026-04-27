// lib/reddit.js
// Reddit search client. v1 uses anonymous .json endpoints — Reddit
// allows ~60 req/min unauthenticated as long as User-Agent is set.
// At 3 beta customers × 5-10 targets × 1 query per 10-min tick we
// stay well under that. Switch to OAuth when we add a 4th customer
// or if Reddit starts blocking.
//
// API surface kept tiny on purpose. One function: search(query, opts).
// Returns the raw `children` array of post objects from Reddit's
// listing API. Caller does its own filtering / target resolution.

'use strict';

const UA = 'Sentinel/0.1 (defensive monitoring for political campaigns; contact: david@voteroi.com)';

// Reddit's listing endpoints return `{kind:'Listing', data:{children:[{kind:'t3', data:{...}}]}}`.
// We unwrap to a flat array of post-objects with the platform's t3_xxx id
// promoted to the top level for convenience.
async function search(query, opts) {
  const o = opts || {};
  const params = new URLSearchParams({
    q: query,
    sort: o.sort || 'new',
    t: o.timeWindow || 'day',           // 'hour' | 'day' | 'week' | 'month' | 'year' | 'all'
    limit: String(o.limit || 25),
    type: 'link',
    restrict_sr: 'false'
  });
  if (o.after) params.set('after', o.after);
  const url = `https://www.reddit.com/search.json?${params.toString()}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`reddit search ${r.status}: ${body.slice(0, 200)}`);
  }
  const j = await r.json();
  const children = (j && j.data && j.data.children) || [];
  return children
    .filter(c => c && c.data)
    .map(c => ({
      id: c.data.name,                        // 't3_abc123'
      title: c.data.title || '',
      body: c.data.selftext || '',
      author: c.data.author || '',
      subreddit: c.data.subreddit || '',
      permalink: c.data.permalink ? `https://reddit.com${c.data.permalink}` : '',
      url: c.data.url || '',
      created_utc: c.data.created_utc || null,
      score: c.data.score || 0,
      num_comments: c.data.num_comments || 0,
      raw: c.data
    }));
}

module.exports = { search, UA };
