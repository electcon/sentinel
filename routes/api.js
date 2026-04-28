// routes/api.js
// Customer-facing public API v1. Bearer-token auth via /lib/api-key.
// All routes scoped to the customer who owns the key — a customer can
// never see another customer's data.
//
// Pagination: cursor-based via ?cursor=<id>&limit=N. Returns next_cursor
// in the response when more results exist. limit clamped to 200.
//
// Rate limit: 60 req/min per key, in-memory bucket.

'use strict';

const express = require('express');
const { requireApiKey } = require('../lib/api-key');

const _rateBuckets = new Map();   // apiKeyId → { tokens, last }

function rateLimit(req, res, next) {
  const id = req.apiKey?.id;
  if (!id) return next();
  const now = Date.now();
  const PER_MIN = 60;
  const REFILL_PER_MS = PER_MIN / 60000;
  let b = _rateBuckets.get(id);
  if (!b) { b = { tokens: PER_MIN, last: now }; _rateBuckets.set(id, b); }
  // Refill since last touch.
  const elapsed = now - b.last;
  b.tokens = Math.min(PER_MIN, b.tokens + elapsed * REFILL_PER_MS);
  b.last = now;
  if (b.tokens < 1) {
    res.set('Retry-After', '5');
    return res.status(429).json({ error: 'rate limit exceeded — 60 req/min/key' });
  }
  b.tokens--;
  next();
}

// Periodic prune.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of _rateBuckets.entries()) {
    if (v.last < cutoff) _rateBuckets.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

function build(pool) {
  const r = express.Router();
  const auth = requireApiKey(pool);

  // GET /api/v1 — service descriptor (no auth, useful for sanity checks).
  // Lists endpoints + version + rate-limit info.
  r.get('/api/v1', (req, res) => {
    res.json({
      service: 'sentinel',
      version: 'v1',
      docs: 'https://sentinel.parallaxadvisory.llc/api/v1/docs',
      endpoints: [
        'GET /api/v1/customer',
        'GET /api/v1/targets',
        'GET /api/v1/mentions',
        'GET /api/v1/mentions/:id',
        'GET /api/v1/threats',
        'GET /api/v1/threats/:id',
        'GET /api/v1/authors/:handle/mentions'
      ],
      auth: 'Bearer sk_...',
      rate_limit: '60 req/min per API key'
    });
  });

  // Read-only descriptor — your customer info.
  r.get('/api/v1/customer', auth, rateLimit, (req, res) => {
    res.json({
      id: req.customer.id,
      name: req.customer.name,
      status: req.customer.status
    });
  });

  // Targets.
  r.get('/api/v1/targets', auth, rateLimit, async (req, res) => {
    const q = await pool.query(`
      SELECT id, kind, name, aliases, search_terms, created_at
      FROM targets WHERE customer_id = $1
      ORDER BY name
    `, [req.customer.id]);
    res.json({ targets: q.rows });
  });

  // Mentions — paginated, filterable.
  r.get('/api/v1/mentions', auth, rateLimit, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const tier = req.query.tier;
    const source = req.query.source;
    const since = req.query.since;     // ISO datetime
    const args = [req.customer.id];
    const wheres = [];
    if (tier && /^[1-4]$/.test(tier)) { args.push(parseInt(tier, 10)); wheres.push(`m.threat_tier = $${args.length}`); }
    if (source && /^[a-z_]+$/i.test(source)) { args.push(source); wheres.push(`m.source = $${args.length}`); }
    if (since && !isNaN(Date.parse(since))) { args.push(new Date(since)); wheres.push(`m.ingested_at >= $${args.length}`); }
    if (req.query.cursor) { args.push(req.query.cursor); wheres.push(`m.id < $${args.length}`); }
    args.push(limit + 1);   // +1 to detect "more available"
    const whereClause = wheres.length ? 'AND ' + wheres.join(' AND ') : '';
    const q = await pool.query(`
      SELECT m.id, m.threat_tier, m.original_tier, m.tier_bumped, m.bump_reason,
             m.source, m.source_id, m.source_url, m.author_handle,
             m.posted_at, m.ingested_at, m.body_excerpt, m.rationale,
             m.classifier_v, m.s3_key, m.review_status, m.reviewed_at, m.reviewed_by,
             t.id AS target_id, t.name AS target_name, t.kind AS target_kind
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.customer_id = $1 ${whereClause}
      ORDER BY m.id DESC
      LIMIT $${args.length}
    `, args);
    const hasMore = q.rowCount > limit;
    const rows = hasMore ? q.rows.slice(0, limit) : q.rows;
    res.json({
      mentions: rows.map(m => ({
        id: m.id,
        tier: m.threat_tier,
        original_tier: m.original_tier,
        tier_bumped: m.tier_bumped,
        bump_reason: m.bump_reason,
        source: m.source,
        source_id: m.source_id,
        source_url: m.source_url,
        author_handle: m.author_handle,
        posted_at: m.posted_at,
        ingested_at: m.ingested_at,
        body_excerpt: m.body_excerpt,
        rationale: m.rationale,
        classifier_v: m.classifier_v,
        s3_key: m.s3_key,
        review_status: m.review_status,
        reviewed_at: m.reviewed_at,
        reviewed_by: m.reviewed_by,
        target: m.target_id ? { id: m.target_id, name: m.target_name, kind: m.target_kind } : null
      })),
      next_cursor: hasMore ? rows[rows.length - 1].id : null
    });
  });

  r.get('/api/v1/mentions/:id', auth, rateLimit, async (req, res) => {
    const q = await pool.query(`
      SELECT m.*, t.name AS target_name, t.kind AS target_kind
      FROM mentions m LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.id = $1 AND m.customer_id = $2
    `, [req.params.id, req.customer.id]);
    if (!q.rowCount) return res.status(404).json({ error: 'not found' });
    res.json(q.rows[0]);
  });

  // Threats.
  r.get('/api/v1/threats', auth, rateLimit, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const status = req.query.status;
    const args = [req.customer.id];
    const wheres = [];
    if (status && /^[a-z_]+$/.test(status)) { args.push(status); wheres.push(`status = $${args.length}`); }
    if (req.query.cursor) { args.push(req.query.cursor); wheres.push(`id < $${args.length}`); }
    args.push(limit + 1);
    const whereClause = wheres.length ? 'AND ' + wheres.join(' AND ') : '';
    const q = await pool.query(`
      SELECT te.id, te.tier, te.status, te.created_at, te.alerted_at, te.resolved_at, te.notes,
             te.assignee_ip, te.mention_id,
             m.body_excerpt, m.source, m.source_url, m.author_handle, m.s3_key,
             t.id AS target_id, t.name AS target_name, t.kind AS target_kind
      FROM threat_events te
      JOIN mentions m ON m.id = te.mention_id
      LEFT JOIN targets t ON t.id = te.target_id
      WHERE te.customer_id = $1 ${whereClause}
      ORDER BY te.id DESC
      LIMIT $${args.length}
    `, args);
    const hasMore = q.rowCount > limit;
    const rows = hasMore ? q.rows.slice(0, limit) : q.rows;
    res.json({
      threats: rows,
      next_cursor: hasMore ? rows[rows.length - 1].id : null
    });
  });

  r.get('/api/v1/threats/:id', auth, rateLimit, async (req, res) => {
    const q = await pool.query(`
      SELECT te.*, m.body_excerpt, m.source, m.source_url, m.author_handle, m.s3_key,
             t.name AS target_name, t.kind AS target_kind
      FROM threat_events te
      JOIN mentions m ON m.id = te.mention_id
      LEFT JOIN targets t ON t.id = te.target_id
      WHERE te.id = $1 AND te.customer_id = $2
    `, [req.params.id, req.customer.id]);
    if (!q.rowCount) return res.status(404).json({ error: 'not found' });
    res.json(q.rows[0]);
  });

  // Author history.
  r.get('/api/v1/authors/:handle/mentions', auth, rateLimit, async (req, res) => {
    const handle = decodeURIComponent(req.params.handle);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const q = await pool.query(`
      SELECT m.id, m.threat_tier, m.tier_bumped, m.source, m.source_url, m.posted_at, m.body_excerpt,
             t.name AS target_name
      FROM mentions m LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.customer_id = $1 AND m.author_handle = $2
      ORDER BY m.ingested_at DESC LIMIT $3
    `, [req.customer.id, handle, limit]);
    res.json({ author: handle, mentions: q.rows });
  });

  return r;
}

module.exports = build;
