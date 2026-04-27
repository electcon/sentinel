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
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

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
      channel       TEXT NOT NULL,        -- 'email' | 'sms' (later) | 'webhook'
      destination   TEXT NOT NULL,
      min_tier      SMALLINT NOT NULL DEFAULT 3,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
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
