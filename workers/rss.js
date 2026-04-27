// workers/rss.js
// RSS / news ingest. Runs as Render cron every 15 min. v1: one
// Google News RSS query per target. Future v2 adds per-customer
// custom feeds (state papers, candidate blogs, etc.) via an
// rss_feeds(customer_id, url) table.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { fetchGoogleNews } = require('../lib/rss');
const { processOne, loadActiveTargets } = require('../lib/ingest');

async function runOnce({ pool, log = console.log }) {
  const groups = await loadActiveTargets(pool);
  let totalQueries = 0;
  let totalHits = 0;
  let totalNew = 0;
  let totalSkipped = 0;
  let tier3Plus = 0;

  for (const { customer, targets } of groups) {
    log(`[rss] customer ${customer.name} (${customer.id}) — ${targets.length} targets`);
    for (const target of targets) {
      // Same query construction as Reddit/Bluesky: only multi-word
      // canonical names + explicit search_terms. Single-word aliases
      // explode the false-positive rate on Google News.
      const queries = [target.name, ...(target.search_terms || [])]
        .filter(Boolean)
        .map(s => String(s).trim())
        .filter(s => s.length >= 5 && /\s/.test(s));
      const seen = new Set();
      for (const q of queries) {
        if (seen.has(q)) continue;
        seen.add(q);
        totalQueries++;
        let items = [];
        try {
          items = await fetchGoogleNews(`"${q.replace(/"/g, '')}"`);
        } catch (e) {
          log(`[rss] query failed: ${q} — ${e.message}`);
          continue;
        }
        for (const r of items) {
          totalHits++;
          const item = {
            source: 'rss',
            source_id: r.id,
            source_url: r.link,
            author_handle: r.source_publisher,
            posted_at: r.pub_date,
            title: r.title,
            body: r.body,
            raw: r.raw
          };
          try {
            const out = await processOne({ pool, customer, targets, item });
            if (out.skipped) totalSkipped++; else totalNew++;
            if (!out.skipped && out.threat_tier >= 3) tier3Plus++;
          } catch (e) {
            log(`[rss] processOne failed for ${item.source_id}: ${e.message}`);
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
    .then(s => { console.log('[rss] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[rss] FATAL:', e.message); pool.end(); process.exit(1); });
}
