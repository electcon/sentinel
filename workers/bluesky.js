// workers/bluesky.js
// Bluesky ingest — runs as a Render cron job every 5 min. Same shape
// as workers/reddit.js: per-customer fan-out, processOne handles
// dupe-skip + match + classify + S3 archive + DB write + threat event.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { search } = require('../lib/bluesky');
const { processOne, loadActiveTargets } = require('../lib/ingest');

const LIMIT_PER_QUERY = parseInt(process.env.BSKY_LIMIT_PER_QUERY, 10) || 25;
const MAX_QUERIES_PER_TARGET = parseInt(process.env.BSKY_MAX_QUERIES_PER_TARGET, 10) || 3;

function buildQueriesForTarget(target) {
  // Same logic as Reddit: only canonical full names + explicit search_terms.
  // No bare aliases — they produce too much noise on every platform.
  const candidates = [target.name, ...(target.search_terms || [])]
    .filter(Boolean)
    .map(s => String(s).trim())
    .filter(s => s.length >= 5 && /\s/.test(s));
  const queries = [];
  for (const c of candidates) {
    const q = `"${c.replace(/"/g, '')}"`;
    if (!queries.includes(q)) queries.push(q);
    if (queries.length >= MAX_QUERIES_PER_TARGET) break;
  }
  return queries;
}

async function runOnce({ pool, log = console.log }) {
  const groups = await loadActiveTargets(pool);
  let totalQueries = 0;
  let totalHits = 0;
  let totalNew = 0;
  let totalSkipped = 0;
  let tier3Plus = 0;

  for (const { customer, targets } of groups) {
    log(`[bluesky] customer ${customer.name} (${customer.id}) — ${targets.length} targets`);
    for (const target of targets) {
      const queries = buildQueriesForTarget(target);
      for (const q of queries) {
        totalQueries++;
        let results = [];
        try {
          results = await search(q, { sort: 'latest', limit: LIMIT_PER_QUERY });
        } catch (e) {
          log(`[bluesky] query failed: ${q} — ${e.message}`);
          continue;
        }
        for (const r of results) {
          totalHits++;
          const item = {
            source: 'bluesky',
            source_id: r.id,                              // at:// URI
            source_url: r.permalink,
            author_handle: r.author_handle,
            posted_at: r.created_at,
            body: r.text,
            raw: r.raw
          };
          try {
            const out = await processOne({ pool, customer, targets, item });
            if (out.skipped) totalSkipped++; else totalNew++;
            if (!out.skipped && out.threat_tier >= 3) tier3Plus++;
          } catch (e) {
            log(`[bluesky] processOne failed for ${item.source_id}: ${e.message}`);
          }
        }
      }
    }
  }

  return {
    customers: groups.length,
    queries: totalQueries,
    hits_returned: totalHits,
    new_mentions: totalNew,
    skipped: totalSkipped,
    tier3_plus: tier3Plus
  };
}

module.exports = { runOnce };

if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(2); }
  const useSSL = /render\.com/.test(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 3
  });
  runOnce({ pool })
    .then(s => { console.log('[bluesky] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[bluesky] FATAL:', e.message); pool.end(); process.exit(1); });
}
