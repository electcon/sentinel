// scripts/init-db.js
// Idempotent schema init. Run on every server boot. Mirrors the
// VoteROI pattern of CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD
// COLUMN IF NOT EXISTS so adding a column means dropping a single
// `ALTER TABLE` line here and it auto-applies on next deploy. No
// migration tool needed at this scale.
//
// Schema mirrors ARCHITECTURE.md. Update both together.

'use strict';

async function initSchema(pool) {
  // pgcrypto for gen_random_uuid()
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      alert_email   TEXT NOT NULL,
      digest_email  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'beta',
      password_hash TEXT,
      state         CHAR(2),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS state CHAR(2)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS targets (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id   UUID NOT NULL REFERENCES customers(id),
      kind          TEXT NOT NULL,
      name          TEXT NOT NULL,
      aliases       JSONB NOT NULL DEFAULT '[]',
      handles       JSONB NOT NULL DEFAULT '[]',
      search_terms  JSONB NOT NULL DEFAULT '[]',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS targets_customer ON targets (customer_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mentions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id   UUID NOT NULL REFERENCES customers(id),
      target_id     UUID REFERENCES targets(id),
      source        TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      source_url    TEXT,
      author_handle TEXT,
      posted_at     TIMESTAMPTZ NOT NULL,
      ingested_at   TIMESTAMPTZ DEFAULT NOW(),
      body_excerpt  TEXT,
      s3_key        TEXT,
      threat_tier   SMALLINT,
      sentiment     SMALLINT,
      rationale     TEXT,
      classifier_v  TEXT,
      UNIQUE (source, source_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS mentions_customer_time ON mentions (customer_id, posted_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS mentions_target_tier ON mentions (target_id, threat_tier) WHERE threat_tier >= 2`);

  // Tier-2 human review queue. Tier 1 = noise (no action), Tier 2 =
  // pending human review per THREAT_TAXONOMY rubric, Tier 3+ = handled
  // via threat_events. review_status is NULL for non-Tier-2 mentions.
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS review_status TEXT`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS reviewed_by TEXT`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS review_notes TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS mentions_review_pending ON mentions (customer_id, ingested_at DESC) WHERE review_status = 'pending'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS threat_events (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mention_id    UUID NOT NULL REFERENCES mentions(id),
      customer_id   UUID NOT NULL REFERENCES customers(id),
      target_id     UUID REFERENCES targets(id),
      tier          SMALLINT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      assignee      TEXT,
      notes         TEXT,
      alerted_at    TIMESTAMPTZ,
      resolved_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS threat_events_open ON threat_events (customer_id, tier DESC, created_at DESC) WHERE status NOT IN ('dismissed', 'reported_law_enf', 'monitoring')`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS classifications (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mention_id    UUID NOT NULL REFERENCES mentions(id),
      prompt_v      TEXT NOT NULL,
      model         TEXT NOT NULL,
      tier          SMALLINT NOT NULL,
      confidence    NUMERIC,
      raw_response  JSONB,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Classifier feedback. Every reviewer disposition (Tier-2 review queue
  // action OR Tier-3+ threat_event status change) is captured here as
  // ground-truth for drift detection + future prompt tuning.
  // reviewer_action vocabulary:
  //   - 'dismissed'         (review-queue OR threats: false positive in our judgment)
  //   - 'escalated'         (review-queue: bumped Tier-2 → 3)
  //   - 'ongoing_campaign'  (review-queue: real but trend-tracked, not actionable)
  //   - 'reviewing'         (threats: human is investigating)
  //   - 'reported_platform' (threats: confirmed, reported to platform)
  //   - 'reported_law_enf'  (threats: confirmed, escalated to LE)
  //   - 'monitoring'        (threats: confirmed but not acting on yet)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classifier_feedback (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mention_id            UUID NOT NULL REFERENCES mentions(id),
      customer_id           UUID NOT NULL REFERENCES customers(id),
      original_tier         SMALLINT,
      original_confidence   NUMERIC,
      original_model        TEXT,
      original_prompt_v     TEXT,
      reviewer_action       TEXT NOT NULL,
      reviewer_actor        TEXT,
      reviewer_note         TEXT,
      source                TEXT,
      target_kind           TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS classifier_feedback_recent ON classifier_feedback (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS classifier_feedback_source_action ON classifier_feedback (source, reviewer_action, created_at DESC)`);

  // Cyber indicators ingested from CISA AIS (TAXII 2.1) or other future
  // threat-intel sources. Used for cross-referencing URLs / domains in
  // mention bodies. v1 just stores; cross-ref is Phase 2.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cyber_indicators (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source          TEXT NOT NULL,         -- 'cisa_ais' | future...
      stix_id         TEXT,                  -- STIX object id (deduped against this)
      kind            TEXT NOT NULL,         -- 'domain' | 'ipv4' | 'sha256' | 'url' | etc.
      value           TEXT NOT NULL,
      pattern         TEXT,
      confidence      INTEGER,
      labels          JSONB DEFAULT '[]',
      description     TEXT,
      valid_from      TIMESTAMPTZ,
      valid_until     TIMESTAMPTZ,
      first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
      raw             JSONB,
      UNIQUE (source, stix_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS cyber_indicators_kind_value ON cyber_indicators (kind, value)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cyber_indicators_recent ON cyber_indicators (last_seen_at DESC)`);

  // Track per-source poll cursor (TAXII added_after etc.) for incremental ingest.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingest_state (
      source        TEXT PRIMARY KEY,
      cursor        TEXT,
      last_run_at   TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Operator-curated channels for sources where the upstream is a
  // discrete list (Telegram channels for now; Discord servers /
  // Mastodon instances later) rather than a general search API.
  // SHARED across all customers (a channel is monitored once; cross-
  // product against every active customer's targets via processOne).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitored_channels (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source          TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      category        TEXT,
      label           TEXT,
      notes           TEXT,
      citation        TEXT,
      est_subscribers INTEGER,
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      last_run_at     TIMESTAMPTZ,
      last_post_count INTEGER,
      last_error      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (source, channel_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS monitored_channels_active ON monitored_channels (source, active) WHERE active = TRUE`);
  await pool.query(`ALTER TABLE monitored_channels ADD COLUMN IF NOT EXISTS consecutive_empty_runs INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE monitored_channels ADD COLUMN IF NOT EXISTS auto_paused_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE monitored_channels ADD COLUMN IF NOT EXISTS auto_paused_reason TEXT`);

  // Per-tick worker run log. Lets the dashboard show "last ran X
  // minutes ago, processed N items, errored Y times." Old rows
  // pruned by a periodic VACUUM-style cleanup; for now we keep ~7d.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_runs (
      id            BIGSERIAL PRIMARY KEY,
      worker_name   TEXT NOT NULL,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at   TIMESTAMPTZ,
      duration_ms   INTEGER,
      ok            BOOLEAN,
      summary       JSONB,
      error         TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS worker_runs_recent ON worker_runs (worker_name, started_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_routes (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id   UUID NOT NULL REFERENCES customers(id),
      channel       TEXT NOT NULL,        -- 'email' | 'webhook' | 'sms' (later)
      destination   TEXT NOT NULL,        -- email addr OR webhook URL
      min_tier      SMALLINT NOT NULL DEFAULT 3,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      label         TEXT,                  -- human-readable name ("Slack #threats")
      secret        TEXT,                  -- HMAC key for webhook signing (NULL for email)
      last_sent_at  TIMESTAMPTZ,
      last_error    TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE alert_routes ADD COLUMN IF NOT EXISTS label TEXT`);
  await pool.query(`ALTER TABLE alert_routes ADD COLUMN IF NOT EXISTS secret TEXT`);
  await pool.query(`ALTER TABLE alert_routes ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE alert_routes ADD COLUMN IF NOT EXISTS last_error TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS alert_routes_active ON alert_routes (customer_id, active) WHERE active = TRUE`);
}

module.exports = initSchema;

// Allow `node scripts/init-db.js` for one-off CLI invocation.
if (require.main === module) {
  try { require('dotenv').config(); } catch (_) {}
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(2); }
  const { Pool } = require('pg');
  // Render Postgres requires SSL even from external hosts; rejectUnauthorized:false
  // is the standard pattern (Render uses a self-signed-ish cert chain).
  const useSSL = /render\.com/.test(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false
  });
  initSchema(pool)
    .then(() => { console.log('[init-db] OK'); pool.end(); })
    .catch(e => { console.error('[init-db] FAIL:', e.message); process.exit(1); });
}
