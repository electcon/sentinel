// workers/cisa.js
// CISA AIS poll. Dormant until DHS onboarding is complete and
// CISA_TAXII_* env vars are set on Render. Once configured: runs hourly,
// pulls new STIX indicators added_after the last poll, persists them
// to cyber_indicators.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { isConfigured, pollCollection, normalizeStixIndicator } = require('../lib/cisa');

const SOURCE = 'cisa_ais';

async function getCursor(pool) {
  const r = await pool.query('SELECT cursor FROM ingest_state WHERE source = $1', [SOURCE]);
  return r.rows[0]?.cursor || null;
}

async function setCursor(pool, cursor) {
  await pool.query(`
    INSERT INTO ingest_state (source, cursor, last_run_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (source) DO UPDATE
    SET cursor = EXCLUDED.cursor, last_run_at = NOW(), updated_at = NOW()
  `, [SOURCE, cursor]);
}

async function runOnce({ pool, log = console.log }) {
  if (!isConfigured()) {
    log('[cisa] not configured (CISA_TAXII_* env vars missing) — skipping');
    return { skipped: true, reason: 'not_configured' };
  }

  // Resume from last seen `added_after` so we only pull new indicators.
  // CISA AIS produces tens of thousands of indicators/day; full reload
  // would be wasteful + expensive.
  const startedAt = new Date();
  const cursorFromDb = await getCursor(pool);
  // Default to last 24h on first poll to bound the initial dump.
  let addedAfter = cursorFromDb || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let pulled = 0; let inserted = 0; let updated = 0; let skipped = 0;
  let pageCount = 0;
  const MAX_PAGES = parseInt(process.env.CISA_MAX_PAGES_PER_RUN, 10) || 10;
  let latestSeen = addedAfter;

  while (pageCount < MAX_PAGES) {
    pageCount++;
    let page;
    try {
      page = await pollCollection({ addedAfter, limit: 100 });
    } catch (e) {
      log(`[cisa] poll failed: ${e.message}`);
      return { ok: false, error: e.message, pulled, inserted, updated };
    }
    pulled += page.objects.length;
    if (page.objects.length === 0) break;

    for (const obj of page.objects) {
      // Track latest object's modified or added time as next cursor.
      const t = obj.modified || obj.created || null;
      if (t && t > latestSeen) latestSeen = t;

      const ind = normalizeStixIndicator(obj);
      if (!ind) { skipped++; continue; }

      try {
        const r = await pool.query(`
          INSERT INTO cyber_indicators (
            source, stix_id, kind, value, pattern, confidence, labels, description,
            valid_from, valid_until, first_seen_at, last_seen_at, raw
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8,
            $9, $10, NOW(), NOW(), $11::jsonb
          )
          ON CONFLICT (source, stix_id) DO UPDATE
          SET last_seen_at = NOW(),
              valid_until = COALESCE(EXCLUDED.valid_until, cyber_indicators.valid_until),
              confidence = COALESCE(EXCLUDED.confidence, cyber_indicators.confidence),
              raw = EXCLUDED.raw
          RETURNING (xmax = 0) AS inserted_new
        `, [
          SOURCE, ind.stix_id, ind.kind, ind.value, ind.pattern, ind.confidence,
          JSON.stringify(ind.labels || []), ind.description,
          ind.valid_from, ind.valid_until, JSON.stringify(obj)
        ]);
        if (r.rows[0].inserted_new) inserted++; else updated++;
      } catch (e) {
        log(`[cisa] insert failed for ${ind.stix_id}: ${e.message}`);
      }
    }

    if (!page.more) break;
    addedAfter = latestSeen;
  }

  await setCursor(pool, latestSeen);

  const ms = Date.now() - startedAt.getTime();
  return { ok: true, pulled, inserted, updated, skipped, pages: pageCount, cursor: latestSeen, ms };
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
    .then(s => { console.log('[cisa] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[cisa] FATAL:', e.message); pool.end(); process.exit(1); });
}
