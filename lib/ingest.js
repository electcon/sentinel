// lib/ingest.js
// Source-agnostic ingest orchestrator. Each ingest worker (reddit,
// bluesky, rss, fb_pages) collects raw items and calls processOne()
// per item. processOne handles dupe-skip, target resolution,
// classification, S3 archive, and DB writes in one transaction-ish
// flow. Idempotent on retry — UNIQUE(customer_id, source, source_id)
// prevents double-inserts within a customer; cross-customer the same
// post can be persisted once per customer (intended). Dupe-skip
// bypasses the LLM cost.

'use strict';

const { matchTargets } = require('./match');
const { putEvidence } = require('./s3');
const { classify } = require('../classify');
const { computeCost } = require('./classifier-cost');

// processOne(item) where item = {
//   source:        'reddit' | 'bluesky' | 'rss' | 'fb_pages'
//   source_id:     platform-native id (for dupe detection)
//   source_url:    permalink for human review
//   author_handle: post author (optional)
//   posted_at:     ISO 8601 or epoch (will be coerced)
//   body:          full text used for matching + classification
//   raw:           full raw payload object — archived to S3 verbatim
// }
// customer = { id, name, ... }
// targets  = [{ id, name, aliases, ... }] — pre-loaded for this customer
// pool     = pg.Pool
//
// Returns { skipped: bool, reason?, mention_id?, threat_tier?, confidence? }.
async function processOne({ pool, customer, targets, item }) {
  if (!item || !item.source || !item.source_id) {
    return { skipped: true, reason: 'invalid item' };
  }

  // 1. Dupe skip — saves the LLM call cost on cron retries.
  // Per-customer uniqueness (since 2026-04-28 migration): the same
  // external post can be persisted once per customer when their targets
  // overlap. So scope the dupe check to this customer.
  const dupe = await pool.query(
    'SELECT id FROM mentions WHERE customer_id = $1 AND source = $2 AND source_id = $3 LIMIT 1',
    [customer.id, item.source, item.source_id]
  );
  if (dupe.rowCount > 0) {
    return { skipped: true, reason: 'duplicate', mention_id: dupe.rows[0].id };
  }

  // 2. Target resolution. If nothing matches, skip — the platform's
  // search returned this because of a stray substring or rate-limit
  // false positive. We don't classify random content.
  const text = ((item.body || '') + ' ' + (item.title || '')).trim();
  const hits = matchTargets(text, targets);
  if (!hits.length) {
    return { skipped: true, reason: 'no target match' };
  }
  const matchedTarget = hits[0].target;

  // 3. Classify via Claude.
  let cls;
  try {
    cls = await classify({
      targetName: matchedTarget.name,
      body: text,
      source: item.source,
      authorHandle: item.author_handle,
      postedAt: item.posted_at
    });
  } catch (e) {
    // Classifier failure → write the mention with no tier; daily reviewer
    // queue picks it up. Don't drop the row.
    cls = { tier: null, confidence: null, sentiment: null, rationale: 'classifier error: ' + e.message, model: 'unknown', prompt_v: 'unknown' };
  }

  // 4. S3 archive of the raw payload. Best-effort — if S3 is down we
  // still persist the mention so the digest sees it.
  let s3Key = null;
  try {
    s3Key = await putEvidence({
      customerId: customer.id,
      source: item.source,
      sourceId: item.source_id,
      payload: { item, classification: cls, archived_at: new Date().toISOString() },
      when: item.posted_at
    });
  } catch (e) {
    console.error('[ingest] S3 archive failed:', e.message);
  }

  // 4b. Author-watch: if this author has produced REPEAT_OFFENDER_THRESHOLD
  // (default 3) tier-2+ mentions for THIS customer in the last
  // REPEAT_OFFENDER_WINDOW_DAYS (default 30), bump the current tier by 1
  // (capped at 4). This is the "we know this person — they're a known
  // bad actor for this customer" intelligence layer on top of the
  // single-post classifier. Skipped when:
  //   - author_handle is empty (firehose without resolved handle)
  //   - classifier returned tier 0/null
  //   - tier is already 4
  //   - classifier returned a parse_error fallback (don't compound)
  const REPEAT_THRESHOLD = parseInt(process.env.REPEAT_OFFENDER_THRESHOLD, 10) || 3;
  const REPEAT_WINDOW_DAYS = parseInt(process.env.REPEAT_OFFENDER_WINDOW_DAYS, 10) || 30;
  let originalTier = cls.tier;
  let tierBumped = false;
  let bumpReason = null;
  if (item.author_handle && cls.tier >= 1 && cls.tier < 4 && !cls.parse_error) {
    try {
      const r = await pool.query(`
        SELECT COUNT(*)::int AS n
        FROM mentions
        WHERE customer_id = $1
          AND author_handle = $2
          AND threat_tier >= 2
          AND ingested_at > NOW() - ($3 || ' days')::interval
      `, [customer.id, item.author_handle, REPEAT_WINDOW_DAYS]);
      const priorBadCount = r.rows[0]?.n || 0;
      if (priorBadCount >= REPEAT_THRESHOLD) {
        cls.tier = Math.min(4, cls.tier + 1);
        tierBumped = true;
        bumpReason = `repeat_offender:${priorBadCount}_t2plus_in_${REPEAT_WINDOW_DAYS}d`;
      }
    } catch (e) {
      // Don't fail the ingest on a stats lookup; just skip the bump.
      console.error('[ingest] repeat-offender lookup failed:', e.message);
    }
  }

  // 5. INSERT mention. UNIQUE(customer_id, source, source_id) is the
  // safety net for races between cron ticks; ON CONFLICT DO NOTHING +
  // returning id tells us whether we won the race. Tier-2 mentions
  // enter the human review queue (review_status='pending') per
  // THREAT_TAXONOMY rubric.
  const reviewStatus = cls.tier === 2 ? 'pending' : null;
  const ins = await pool.query(`
    INSERT INTO mentions (
      customer_id, target_id, source, source_id, source_url,
      author_handle, posted_at, body_excerpt, s3_key,
      threat_tier, sentiment, rationale, classifier_v, review_status,
      tier_bumped, original_tier, bump_reason
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13, $14,
      $15, $16, $17
    )
    ON CONFLICT (customer_id, source, source_id) DO NOTHING
    RETURNING id
  `, [
    customer.id,
    matchedTarget.id,
    item.source,
    item.source_id,
    item.source_url || null,
    item.author_handle || null,
    coerceTs(item.posted_at) || new Date(),
    (text || '').slice(0, 500),
    s3Key,
    cls.tier,
    cls.sentiment,
    (cls.rationale || '').slice(0, 1000),
    cls.prompt_v || null,
    reviewStatus,
    tierBumped,
    tierBumped ? originalTier : null,
    bumpReason
  ]);

  if (ins.rowCount === 0) {
    return { skipped: true, reason: 'duplicate (race)', target_id: matchedTarget.id };
  }
  const mentionId = ins.rows[0].id;

  // 6. Audit row in classifications. Includes per-call token usage +
  // cost in micro-USD when the classifier returned a usage block. cls.usage
  // is null on legacy/non-instrumented paths; the row still goes through.
  const usage = cls.usage || null;
  const cost = usage ? computeCost({ model: cls.model, ...usage }) : { cost_usd_micro: null };
  await pool.query(`
    INSERT INTO classifications (
      mention_id, customer_id, prompt_v, model, tier, confidence, raw_response,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd_micro
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12
    )
  `, [
    mentionId,
    customer.id,
    cls.prompt_v || 'unknown',
    cls.model || 'unknown',
    cls.tier || 0,
    cls.confidence ?? null,
    cls.raw ? JSON.stringify(cls.raw) : JSON.stringify({ note: 'no raw' }),
    usage?.input_tokens ?? null,
    usage?.output_tokens ?? null,
    usage?.cache_read ?? null,
    usage?.cache_creation ?? null,
    cost.cost_usd_micro ?? null
  ]);

  // 7. If tier ≥ 3, queue a threat_event. Real-time alert send happens
  // in a separate path (workers/alert.js — wired in next).
  if (cls.tier >= 3) {
    await pool.query(`
      INSERT INTO threat_events (mention_id, customer_id, target_id, tier, status)
      VALUES ($1, $2, $3, $4, 'open')
    `, [mentionId, customer.id, matchedTarget.id, cls.tier]);
  }

  return {
    skipped: false,
    mention_id: mentionId,
    threat_tier: cls.tier,
    confidence: cls.confidence,
    target_id: matchedTarget.id,
    target_name: matchedTarget.name,
    s3_key: s3Key
  };
}

function coerceTs(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);   // epoch s vs ms
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Load all (customer, targets) pairs for ingest fan-out. Inactive
// customers (status='paused' etc.) are skipped — only 'beta' and
// 'active' status feed the workers.
async function loadActiveTargets(pool) {
  const r = await pool.query(`
    SELECT c.id AS customer_id, c.name AS customer_name, c.status AS customer_status,
           t.id AS target_id, t.name AS target_name, t.aliases, t.search_terms, t.kind
    FROM customers c
    JOIN targets t ON t.customer_id = c.id
    WHERE c.status IN ('beta', 'active')
    ORDER BY c.id, t.id
  `);
  const byCustomer = new Map();
  for (const row of r.rows) {
    let bucket = byCustomer.get(row.customer_id);
    if (!bucket) {
      bucket = { customer: { id: row.customer_id, name: row.customer_name, status: row.customer_status }, targets: [] };
      byCustomer.set(row.customer_id, bucket);
    }
    bucket.targets.push({
      id: row.target_id,
      name: row.target_name,
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      search_terms: Array.isArray(row.search_terms) ? row.search_terms : [],
      kind: row.kind
    });
  }
  return Array.from(byCustomer.values());
}

module.exports = { processOne, loadActiveTargets };
