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

const fs = require('fs');
const path = require('path');
const express = require('express');
const { requireApiKey } = require('../lib/api-key');

// API.md is loaded once at boot. The docs route serves it as text/plain
// so the URL advertised in the v1 descriptor is actually navigable.
let _apiDocs = '';
try {
  _apiDocs = fs.readFileSync(path.join(__dirname, '..', 'API.md'), 'utf8');
} catch (_) {
  _apiDocs = '# Sentinel API v1\n\nSee https://github.com/electcon/donor-accountability-index/blob/main/sentinel/API.md\n';
}

const _rateBuckets = new Map();   // apiKeyId → { tokens, last }

const PER_MIN = 60;
const REFILL_PER_MS = PER_MIN / 60000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CSV_MAX_ROWS = 5000;

// RFC 4180 field escape. If the value contains a comma, double-quote,
// CR, or LF, wrap in double quotes and double any internal quotes.
function csvField(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvRow(arr) { return arr.map(csvField).join(',') + '\r\n'; }

// Pure bucket-step. Mutates `bucket` in place AND returns the headers
// + allow/deny decision. Extracted so rateLimit can be unit-tested
// without an express req/res.
//
// Returns:
//   { allowed: bool, remaining: int, reset: epochSec, retryAfter?: sec }
function applyBucket(bucket, now, perMin = PER_MIN) {
  const refill = perMin / 60000;
  const elapsed = now - bucket.last;
  bucket.tokens = Math.min(perMin, bucket.tokens + elapsed * refill);
  bucket.last = now;
  const msToFull = (perMin - bucket.tokens) / refill;
  const reset = Math.ceil((now + msToFull) / 1000);
  if (bucket.tokens < 1) {
    const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / refill / 1000));
    return { allowed: false, remaining: 0, reset, retryAfter };
  }
  bucket.tokens--;
  return { allowed: true, remaining: Math.floor(bucket.tokens), reset };
}

function rateLimit(req, res, next) {
  const id = req.apiKey?.id;
  if (!id) return next();
  const now = Date.now();
  let b = _rateBuckets.get(id);
  if (!b) { b = { tokens: PER_MIN, last: now }; _rateBuckets.set(id, b); }
  const verdict = applyBucket(b, now, PER_MIN);
  res.set('X-RateLimit-Limit', String(PER_MIN));
  res.set('X-RateLimit-Remaining', String(verdict.remaining));
  res.set('X-RateLimit-Reset', String(verdict.reset));
  if (!verdict.allowed) {
    res.set('Retry-After', String(verdict.retryAfter));
    return res.status(429).json({ error: 'rate limit exceeded — 60 req/min/key' });
  }
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

  // GET /api/v1/docs — serve API.md as text/plain. No auth — it's
  // documentation. Defined BEFORE the descriptor so the precise path
  // wins over any future wildcard.
  r.get('/api/v1/docs', (_req, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(_apiDocs);
  });

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
        'GET /api/v1/mentions.csv',
        'GET /api/v1/mentions/:id',
        'GET /api/v1/threats',
        'GET /api/v1/threats.csv',
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
    if (req.query.cursor) {
      if (!UUID_RE.test(req.query.cursor)) return res.status(400).json({ error: 'cursor must be a UUID' });
      args.push(req.query.cursor); wheres.push(`m.id < $${args.length}`);
    }
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

  // CSV export — same filters as GET /api/v1/mentions but no pagination,
  // capped at CSV_MAX_ROWS. Streams text/csv with a header row. Common
  // compliance / SIEM-import use case.
  r.get('/api/v1/mentions.csv', auth, rateLimit, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || CSV_MAX_ROWS, CSV_MAX_ROWS);
    const tier = req.query.tier;
    const source = req.query.source;
    const since = req.query.since;
    const args = [req.customer.id];
    const wheres = [];
    if (tier && /^[1-4]$/.test(tier)) { args.push(parseInt(tier, 10)); wheres.push(`m.threat_tier = $${args.length}`); }
    if (source && /^[a-z_]+$/i.test(source)) { args.push(source); wheres.push(`m.source = $${args.length}`); }
    if (since && !isNaN(Date.parse(since))) { args.push(new Date(since)); wheres.push(`m.ingested_at >= $${args.length}`); }
    args.push(limit);
    const whereClause = wheres.length ? 'AND ' + wheres.join(' AND ') : '';
    const q = await pool.query(`
      SELECT m.id, m.threat_tier, m.original_tier, m.tier_bumped, m.bump_reason,
             m.source, m.source_id, m.source_url, m.author_handle,
             m.posted_at, m.ingested_at, m.body_excerpt, m.rationale,
             m.classifier_v, m.review_status, m.reviewed_at, m.reviewed_by,
             t.name AS target_name, t.kind AS target_kind
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.customer_id = $1 ${whereClause}
      ORDER BY m.id DESC
      LIMIT $${args.length}
    `, args);
    const filename = `sentinel-mentions-${new Date().toISOString().slice(0, 10)}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    const headers = ['id','tier','original_tier','tier_bumped','bump_reason','source','source_id','source_url','author_handle','posted_at','ingested_at','target_name','target_kind','body_excerpt','rationale','classifier_v','review_status','reviewed_at','reviewed_by'];
    res.write(csvRow(headers));
    for (const m of q.rows) {
      res.write(csvRow([
        m.id, m.threat_tier, m.original_tier, m.tier_bumped, m.bump_reason,
        m.source, m.source_id, m.source_url, m.author_handle,
        m.posted_at, m.ingested_at, m.target_name, m.target_kind,
        m.body_excerpt, m.rationale, m.classifier_v,
        m.review_status, m.reviewed_at, m.reviewed_by
      ]));
    }
    res.end();
  });

  r.get('/api/v1/threats.csv', auth, rateLimit, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || CSV_MAX_ROWS, CSV_MAX_ROWS);
    const status = req.query.status;
    const args = [req.customer.id];
    const wheres = [];
    if (status && /^[a-z_]+$/.test(status)) { args.push(status); wheres.push(`te.status = $${args.length}`); }
    args.push(limit);
    const whereClause = wheres.length ? 'AND ' + wheres.join(' AND ') : '';
    const q = await pool.query(`
      SELECT te.id, te.tier, te.status, te.created_at, te.alerted_at, te.resolved_at,
             te.notes, te.mention_id,
             m.body_excerpt, m.source, m.source_url, m.author_handle, m.posted_at,
             t.name AS target_name, t.kind AS target_kind
      FROM threat_events te
      JOIN mentions m ON m.id = te.mention_id
      LEFT JOIN targets t ON t.id = te.target_id
      WHERE te.customer_id = $1 ${whereClause}
      ORDER BY te.id DESC
      LIMIT $${args.length}
    `, args);
    const filename = `sentinel-threats-${new Date().toISOString().slice(0, 10)}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    const headers = ['id','tier','status','created_at','alerted_at','resolved_at','target_name','target_kind','source','source_url','author_handle','posted_at','body_excerpt','mention_id','notes'];
    res.write(csvRow(headers));
    for (const te of q.rows) {
      res.write(csvRow([
        te.id, te.tier, te.status, te.created_at, te.alerted_at, te.resolved_at,
        te.target_name, te.target_kind, te.source, te.source_url,
        te.author_handle, te.posted_at, te.body_excerpt, te.mention_id, te.notes
      ]));
    }
    res.end();
  });

  r.get('/api/v1/mentions/:id', auth, rateLimit, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id must be a UUID' });
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
    if (req.query.cursor) {
      if (!UUID_RE.test(req.query.cursor)) return res.status(400).json({ error: 'cursor must be a UUID' });
      args.push(req.query.cursor); wheres.push(`id < $${args.length}`);
    }
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
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id must be a UUID' });
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
module.exports.applyBucket = applyBucket;
module.exports.PER_MIN = PER_MIN;
module.exports.csvField = csvField;
module.exports.csvRow = csvRow;
