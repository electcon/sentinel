// workers/x.js
// X (Twitter) ingest via twitterapi.io. Same shape as Reddit/Bluesky
// workers — fan-out per (customer × target × query). Runs every 5 min.
//
// twitterapi.io's per-request cap is ~20 tweets and pagination is
// flagged broken; we use a 6-hour rolling time window via since_time
// to stay current without missing volume during news events.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { search } = require('../lib/x-client');
const { processOne, loadActiveTargets } = require('../lib/ingest');

const MAX_QUERIES_PER_TARGET = parseInt(process.env.X_MAX_QUERIES_PER_TARGET, 10) || 2;
const WINDOW_HOURS = parseInt(process.env.X_WINDOW_HOURS, 10) || 6;

function buildQueriesForTarget(target) {
  // Same restraint as other workers: multi-word canonical names + explicit
  // search_terms. Aliases stay for body-match only.
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

function isoSinceWindow() {
  const d = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
  // twitterapi.io accepts ISO-like strings; we'll send 'YYYY-MM-DD HH:MM:SS_UTC'
  // format if that's what they expect, but ISO 8601 should work.
  return d.toISOString();
}

async function runOnce({ pool, log = console.log }) {
  const groups = await loadActiveTargets(pool);
  let totalQueries = 0;
  let totalHits = 0;
  let totalNew = 0;
  let totalSkipped = 0;
  let tier3Plus = 0;
  let errors = 0;

  const sinceTime = isoSinceWindow();

  for (const { customer, targets } of groups) {
    log(`[x] customer ${customer.name} (${customer.id}) — ${targets.length} targets`);
    for (const target of targets) {
      const queries = buildQueriesForTarget(target);
      for (const q of queries) {
        totalQueries++;
        let results = [];
        try {
          results = await search(q, { sort: 'latest', sinceTime });
        } catch (e) {
          errors++;
          log(`[x] query failed: ${q} — ${e.message}`);
          continue;
        }
        for (const r of results) {
          totalHits++;
          const item = {
            source: 'x',
            source_id: r.id,
            source_url: r.permalink,
            author_handle: r.author,
            posted_at: r.created_at,
            body: r.text,
            raw: r.raw
          };
          try {
            const out = await processOne({ pool, customer, targets, item });
            if (out.skipped) totalSkipped++; else totalNew++;
            if (!out.skipped && out.threat_tier >= 3) tier3Plus++;
          } catch (e) {
            log(`[x] processOne failed for ${item.source_id}: ${e.message}`);
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
    tier3_plus: tier3Plus,
    errors
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
    .then(s => { console.log('[x] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[x] FATAL:', e.message); pool.end(); process.exit(1); });
}
