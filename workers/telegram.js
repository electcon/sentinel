// workers/telegram.js
// Telegram public-channel ingest. Different shape from Reddit/Bluesky:
// channels are SHARED across customers (e.g. a Patriot Front channel
// produces threats relevant to every Sentinel customer). So we fetch
// each channel ONCE per tick and cross-product against every active
// customer's targets.
//
// Seed channels are hardcoded for v1 — sourced from DFRLab and ISD
// academic research on US far-right Telegram. Per-customer custom
// channels are a v2 concern (add via /dashboard/settings later).

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { fetchChannelPosts } = require('../lib/telegram');
const { processOne, loadActiveTargets } = require('../lib/ingest');

// Bootstrap seed (pre-DB). Used when monitored_channels table is empty.
// Once channels are added via /admin/telegram-channels, this list is
// IGNORED (DB takes precedence).
const SEED_CHANNELS = [];

async function loadActiveChannels(pool) {
  const r = await pool.query(`
    SELECT id, channel_id, category, label, consecutive_empty_runs
    FROM monitored_channels
    WHERE source = 'telegram' AND active = TRUE
    ORDER BY channel_id
  `);
  if (r.rowCount > 0) return r.rows;
  // Fallback to hardcoded SEED_CHANNELS for backwards compat / first run.
  return SEED_CHANNELS.map(c => ({ id: null, channel_id: c, category: null, label: null, consecutive_empty_runs: 0 }));
}

// On a 0-post fetch (or error) we increment consecutive_empty_runs.
// Once it crosses STALE_THRESHOLD, flip active=false and stamp
// auto_paused_at + reason so the admin UI can show "auto-paused" badge.
async function markChannelEmpty(pool, channelRow, reason, log) {
  if (!channelRow.id) return;
  const newCount = (channelRow.consecutive_empty_runs || 0) + 1;
  if (newCount >= STALE_THRESHOLD) {
    await pool.query(`
      UPDATE monitored_channels
      SET consecutive_empty_runs = $2,
          active = FALSE,
          auto_paused_at = NOW(),
          auto_paused_reason = $3
      WHERE id = $1
    `, [channelRow.id, newCount, reason.slice(0, 200)]);
    log(`[telegram] auto-paused channel ${channelRow.channel_id} after ${newCount} consecutive ${reason}`);
  } else {
    await pool.query(`UPDATE monitored_channels SET consecutive_empty_runs = $2 WHERE id = $1`, [channelRow.id, newCount]);
  }
}

async function markChannelHealthy(pool, channelRow) {
  if (!channelRow.id) return;
  if (!channelRow.consecutive_empty_runs) return;          // already 0
  await pool.query(`
    UPDATE monitored_channels
    SET consecutive_empty_runs = 0,
        auto_paused_at = NULL,
        auto_paused_reason = NULL
    WHERE id = $1
  `, [channelRow.id]);
}

const MAX_POSTS_PER_CHANNEL = parseInt(process.env.TELEGRAM_MAX_POSTS, 10) || 20;
const FETCH_GAP_MS = parseInt(process.env.TELEGRAM_FETCH_GAP_MS, 10) || 1500;
const STALE_THRESHOLD = parseInt(process.env.TELEGRAM_STALE_THRESHOLD, 10) || 5;

async function runOnce({ pool, log = console.log }) {
  const groups = await loadActiveTargets(pool);
  let totalChannels = 0;
  let totalHits = 0;
  let totalNew = 0;
  let totalSkipped = 0;
  let tier3Plus = 0;
  let errors = 0;
  const errorDetails = [];

  if (groups.length === 0) {
    log('[telegram] no active customers — skipping');
    return { customers: 0, channels: 0, hits_returned: 0, new_mentions: 0, skipped: 0, tier3_plus: 0, errors: 0 };
  }

  const channels = await loadActiveChannels(pool);

  if (channels.length === 0) {
    log('[telegram] no active channels in monitored_channels — populate via /admin/telegram-channels');
    return { customers: groups.length, channels: 0, hits_returned: 0, new_mentions: 0, skipped: 0, tier3_plus: 0, errors: 0, error_details: [], note: 'no active channels' };
  }

  for (const ch of channels) {
    const channel = ch.channel_id;
    totalChannels++;
    let posts = [];
    try {
      posts = await fetchChannelPosts(channel, { maxPosts: MAX_POSTS_PER_CHANNEL });
      if (ch.id) {
        await pool.query('UPDATE monitored_channels SET last_run_at = NOW(), last_post_count = $2, last_error = NULL WHERE id = $1', [ch.id, posts.length]).catch(() => {});
      }
      if (posts.length === 0) {
        await markChannelEmpty(pool, ch, 'empty_runs', log).catch(() => {});
      } else {
        await markChannelHealthy(pool, ch).catch(() => {});
      }
    } catch (e) {
      errors++;
      errorDetails.push({ channel, error: e.message.slice(0, 200) });
      log(`[telegram] channel ${channel} failed: ${e.message}`);
      if (ch.id) {
        await pool.query('UPDATE monitored_channels SET last_run_at = NOW(), last_error = $2 WHERE id = $1', [ch.id, e.message.slice(0, 500)]).catch(() => {});
        await markChannelEmpty(pool, ch, 'fetch_errors', log).catch(() => {});
      }
      // Polite gap even on failure — t.me throttles aggressive callers
      await new Promise(r => setTimeout(r, FETCH_GAP_MS));
      continue;
    }
    log(`[telegram] channel ${channel} → ${posts.length} posts`);

    // Cross-product: each post against each (customer, targets) group.
    for (const post of posts) {
      // Skip posts with empty text — can't match
      if (!post.text || post.text.length < 5) continue;
      const item = {
        source: 'telegram',
        // source_id includes channel to ensure global uniqueness across
        // customers when the same post matches multiple targets.
        source_id: 'tg_' + post.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
        source_url: post.permalink,
        author_handle: post.author,
        posted_at: post.created_at,
        body: post.text,
        raw: post.raw
      };
      for (const { customer, targets } of groups) {
        totalHits++;
        try {
          // processOne will dedupe via UNIQUE(source, source_id) so the
          // same post matched against multiple customers will only INSERT
          // for the FIRST customer's match. To handle multi-customer
          // properly we'd need a join table; v1 acceptable trade-off.
          const out = await processOne({ pool, customer, targets, item });
          if (out.skipped) totalSkipped++; else totalNew++;
          if (!out.skipped && out.threat_tier >= 3) tier3Plus++;
        } catch (e) {
          log(`[telegram] processOne failed ${item.source_id} for ${customer.name}: ${e.message}`);
        }
      }
    }
    await new Promise(r => setTimeout(r, FETCH_GAP_MS));
  }

  return {
    customers: groups.length,
    channels: totalChannels,
    hits_returned: totalHits,
    new_mentions: totalNew,
    skipped: totalSkipped,
    tier3_plus: tier3Plus,
    errors,
    error_details: errorDetails.slice(0, 5)
  };
}

module.exports = { runOnce, SEED_CHANNELS };

if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(2); }
  const useSSL = /render\.com/.test(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 3
  });
  runOnce({ pool })
    .then(s => { console.log('[telegram] done:', JSON.stringify(s)); pool.end(); })
    .catch(e => { console.error('[telegram] FATAL:', e.message); pool.end(); process.exit(1); });
}
