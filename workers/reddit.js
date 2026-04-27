// workers/reddit.js
// Reddit ingest — runs on Render cron every 10 min.
//
// For each active customer, for each target, we build queries from
// (target.name, target.aliases, target.search_terms) and hit Reddit's
// public search. Each hit goes through ingest.processOne, which
// handles dupe-skip, classify, S3 archive, DB write, and tier-3+
// threat_event queue.
//
// Bounded by:
//   - REDDIT_TIME_WINDOW (default 'day') — how far back to search per tick
//   - REDDIT_LIMIT_PER_QUERY (default 25) — page size per query
//   - REDDIT_MAX_QUERIES_PER_TARGET (default 3) — cap fan-out
// At 3 customers × ~6 targets × 3 queries per tick = ~54 req/run, well
// under Reddit's 60/min anonymous quota when run every 10 min.
//
// Designed to be safe to invoke from CLI (`node workers/reddit.js`) for
// manual debugging or from a Render cron job. Always exits cleanly
// (success even if individual queries fail) so cron doesn't keep
// retrying broken state.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { search } = require('../lib/reddit');
const { processOne, loadActiveTargets } = require('../lib/ingest');

const TIME_WINDOW = process.env.REDDIT_TIME_WINDOW || 'day';
const LIMIT_PER_QUERY = parseInt(process.env.REDDIT_LIMIT_PER_QUERY, 10) || 25;
const MAX_QUERIES_PER_TARGET = parseInt(process.env.REDDIT_MAX_QUERIES_PER_TARGET, 10) || 3;

function buildQueriesForTarget(target) {
  // Reddit search supports quoted phrases. We use ONLY the canonical
  // full name plus explicit `search_terms`. Aliases (often bare
  // surnames or first names) are deliberately excluded from search
  // queries because single-word aliases produce massive false-positive
  // volume (e.g. "Crist" hits Catalan religious text + unrelated
  // comedians). Aliases still apply at body-match time via
  // lib/match.matchTargets, where we're already inside content that
  // mentioned a stronger term.
  const candidates = [target.name, ...(target.search_terms || [])]
    .filter(Boolean)
    .map(s => String(s).trim())
    .filter(s => s.length >= 5 && /\s/.test(s));   // multi-word only
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
    log(`[reddit] customer ${customer.name} (${customer.id}) — ${targets.length} targets`);
    for (const target of targets) {
      const queries = buildQueriesForTarget(target);
      for (const q of queries) {
        totalQueries++;
        let results = [];
        try {
          results = await search(q, { sort: 'new', timeWindow: TIME_WINDOW, limit: LIMIT_PER_QUERY });
        } catch (e) {
          log(`[reddit] query failed: ${q} — ${e.message}`);
          continue;
        }
        for (const r of results) {
          totalHits++;
          const item = {
            source: 'reddit',
            source_id: r.id,                                  // 't3_xxx'
            source_url: r.permalink || r.url,
            author_handle: r.author,
            posted_at: r.created_utc ? new Date(r.created_utc * 1000) : null,
            title: r.title,
            body: r.body,
            raw: r.raw
          };
          try {
            const out = await processOne({ pool, customer, targets, item });
            if (out.skipped) totalSkipped++; else totalNew++;
            if (!out.skipped && out.threat_tier >= 3) tier3Plus++;
          } catch (e) {
            log(`[reddit] processOne failed for ${item.source_id}: ${e.message}`);
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
    .then(s => { console.log('[reddit] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[reddit] FATAL:', e.message); pool.end(); process.exit(1); });
}
