// lib/bluesky-jetstream.js
// Real-time Bluesky firehose via Jetstream — Bluesky's filtered/JSON
// version of the AT Protocol relay. Subscribes once, receives every
// new post / like / follow / etc. on the network as they happen.
//
// We filter to `app.bsky.feed.post` server-side via the
// `wantedCollections` query param so we don't pay decode/match cost
// for non-post events.
//
// Throughput note: even filtered to posts, Jetstream delivers
// ~100-300 posts/second at peak. We do a CHEAP regex match against
// in-memory target aliases first; only matched posts hit the LLM
// classifier. At v1 scale (3 customers × ~10 targets) the alias
// list is small enough to scan per-message without measurable cost.

'use strict';

const WebSocket = require('ws');
const { matchTargets } = require('./match');
const { processOne, loadActiveTargets } = require('./ingest');

const JETSTREAM_URL = process.env.BLUESKY_JETSTREAM_URL ||
  'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const RELOAD_TARGETS_MS = 60 * 1000;        // re-pull active targets each minute

class JetstreamClient {
  constructor({ pool, log = console.log }) {
    this.pool = pool;
    this.log = log;
    this.ws = null;
    this.reconnectMs = RECONNECT_BASE_MS;
    this.shouldRun = false;
    this.reloadTimer = null;
    this.groups = [];                       // [{customer, targets}]
    this.stats = { connected_at: null, posts_seen: 0, posts_matched: 0, processed: 0, errors: 0, last_error: null };
  }

  async start() {
    this.shouldRun = true;
    await this._loadGroups();
    this.reloadTimer = setInterval(() => this._loadGroups().catch(() => {}), RELOAD_TARGETS_MS).unref?.();
    this._connect();
  }

  stop() {
    this.shouldRun = false;
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    if (this.ws) try { this.ws.close(); } catch (_) {}
  }

  async _loadGroups() {
    try {
      this.groups = await loadActiveTargets(this.pool);
    } catch (e) {
      this.log(`[jetstream] target reload failed: ${e.message}`);
    }
  }

  _connect() {
    if (!this.shouldRun) return;
    this.log(`[jetstream] connecting → ${JETSTREAM_URL}`);
    const ws = new WebSocket(JETSTREAM_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.stats.connected_at = new Date().toISOString();
      this.reconnectMs = RECONNECT_BASE_MS;
      this.log('[jetstream] connected');
    });

    ws.on('message', (raw) => {
      this._onMessage(raw).catch(e => {
        this.stats.errors++;
        this.stats.last_error = e.message;
      });
    });

    ws.on('close', (code, reason) => {
      this.stats.connected_at = null;
      this.log(`[jetstream] closed code=${code} reason=${reason || 'none'}`);
      if (this.shouldRun) this._scheduleReconnect();
    });

    ws.on('error', (e) => {
      this.log(`[jetstream] socket error: ${e.message}`);
      this.stats.last_error = e.message;
    });
  }

  _scheduleReconnect() {
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.log(`[jetstream] reconnecting in ${wait}ms`);
    setTimeout(() => this._connect(), wait);
  }

  async _onMessage(raw) {
    let event;
    try { event = JSON.parse(raw.toString()); } catch (_) { return; }
    // Only commit events with create operations on posts are interesting.
    if (event.kind !== 'commit') return;
    const commit = event.commit;
    if (!commit || commit.collection !== 'app.bsky.feed.post' || commit.operation !== 'create') return;

    this.stats.posts_seen++;

    const text = commit.record?.text || '';
    if (!text || text.length < 5) return;

    // Match against ALL groups' targets in one pass (one regex set,
    // one scan). We need to know which group(s) had a match for the
    // cross-product persist below.
    const matchedGroups = [];
    for (const g of this.groups) {
      const hits = matchTargets(text, g.targets);
      if (hits.length) matchedGroups.push({ group: g, target: hits[0].target });
    }
    if (matchedGroups.length === 0) return;

    this.stats.posts_matched++;

    const did = event.did || '';
    const rkey = commit.rkey || '';
    const sourceId = `at://${did}/app.bsky.feed.post/${rkey}`;
    const permalink = `https://bsky.app/profile/${did}/post/${rkey}`;
    const item = {
      source: 'bluesky',
      source_id: sourceId,
      source_url: permalink,
      author_handle: did,                    // we don't have the handle in firehose; did is the canonical id
      posted_at: commit.record?.createdAt ? new Date(commit.record.createdAt) : null,
      body: text,
      raw: commit.record
    };

    for (const m of matchedGroups) {
      try {
        const out = await processOne({ pool: this.pool, customer: m.group.customer, targets: m.group.targets, item });
        if (!out.skipped) this.stats.processed++;
      } catch (e) {
        this.stats.errors++;
        this.stats.last_error = e.message;
        this.log(`[jetstream] processOne failed: ${e.message}`);
      }
    }
  }

  getStats() {
    return { ...this.stats, groups: this.groups.length };
  }
}

module.exports = { JetstreamClient, JETSTREAM_URL };
