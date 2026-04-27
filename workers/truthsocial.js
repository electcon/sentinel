// workers/truthsocial.js
// TruthSocial ingest. Same shape as Bluesky / X workers — fan out
// per (customer × target × query). Dormant when
// TRUTHSOCIAL_ACCESS_TOKEN is unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { search, isConfigured } = require('../lib/truthsocial');
const { processOne, loadActiveTargets } = require('../lib/ingest');

const LIMIT_PER_QUERY = parseInt(process.env.TRUTHSOCIAL_LIMIT_PER_QUERY, 10) || 20;
const MAX_QUERIES_PER_TARGET = parseInt(process.env.TRUTHSOCIAL_MAX_QUERIES_PER_TARGET, 10) || 2;
const QPS_GAP_MS = parseInt(process.env.TRUTHSOCIAL_QPS_GAP_MS, 10) || 2000;

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

async function runOnce({ pool, log = console.log }) {
  if (!isConfigured()) {
    log('[truthsocial] not configured (TRUTHSOCIAL_ACCESS_TOKEN missing) — skipping');
    return { skipped: true, reason: 'not_configured' };
  }

  const groups = await loadActiveTargets(pool);
  let totalQueries = 0;
  let totalHits = 0;
  let totalNew = 0;
  let totalSkipped = 0;
  let tier3Plus = 0;
  let errors = 0;
  const errorDetails = [];

  for (const { customer, targets } of groups) {
    log(`[truthsocial] customer ${customer.name} (${customer.id}) — ${targets.length} targets`);
    for (const target of targets) {
      const queries = buildQueriesForTarget(target);
      for (const q of queries) {
        totalQueries++;
        let results = [];
        try {
          results = await search(q, { limit: LIMIT_PER_QUERY });
        } catch (e) {
          errors++;
          errorDetails.push({ query: q, error: e.message.slice(0, 200) });
          log(`[truthsocial] query failed: ${q} — ${e.message}`);
          continue;
        }
        for (const r of results) {
          totalHits++;
          const item = {
            source: 'truthsocial',
            source_id: 'ts_' + r.id,
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
            log(`[truthsocial] processOne failed for ${item.source_id}: ${e.message}`);
          }
        }
        // Polite gap between queries.
        await new Promise(r => setTimeout(r, QPS_GAP_MS));
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
    errors,
    error_details: errorDetails.slice(0, 5)
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
    .then(s => { console.log('[truthsocial] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[truthsocial] FATAL:', e.message); pool.end(); process.exit(1); });
}
