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
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0`);
  // Billing — schema ready for Stripe Sprint 3. No real charges in v1;
  // billing_status is operator-managed via /admin/customers/:id.
  // Status vocab: free_beta | trialing | active | past_due | canceled
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'free_beta'`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_amount_cents INTEGER`);
  // billing_period: 'monthly' | 'annual'
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_period TEXT`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_starts_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_notes TEXT`);
  // Force first-login password change. Set on provision; cleared on
  // first successful self-set in /dashboard/settings/password.
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE`);

  // Customer API keys. Bearer-token auth for /api/v1/* routes. Hashed
  // at rest (SHA-256 since these aren't user-chosen passwords; the
  // entropy comes from us). The full key is shown ONCE on generation
  // and never again — customer copies + stores it themselves.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      key_prefix      CHAR(12) NOT NULL,         -- first 12 chars (for identification + display)
      key_hash        TEXT NOT NULL,              -- SHA-256 of the full key
      label           TEXT,
      scopes          TEXT[] NOT NULL DEFAULT ARRAY['read'],
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      last_used_at    TIMESTAMPTZ,
      use_count       INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      revoked_at      TIMESTAMPTZ,
      UNIQUE (key_prefix)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS api_keys_customer ON api_keys (customer_id, active) WHERE active = TRUE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS api_keys_hash ON api_keys (key_hash) WHERE active = TRUE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS customers_billing_status ON customers (billing_status) WHERE billing_status NOT IN ('free_beta', 'canceled')`);

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

  // Mention uniqueness migration. Originally UNIQUE(source, source_id)
  // — global. Problem: when Customer A and B both monitor "Trump" and
  // a post matches both, only A gets the row (whoever's worker hits
  // first); B is silently skipped. Migrate to UNIQUE per customer so
  // each customer owns their own row for the same external post.
  // Safe: existing data already satisfies the new constraint (any
  // (source, source_id) was unique, therefore (customer_id, source,
  // source_id) is also unique). Idempotent: new index first, then
  // drop the old constraint by its auto-generated Postgres name.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS mentions_customer_source_id ON mentions (customer_id, source, source_id)`);
  // Drop the old global UNIQUE — Postgres auto-named it on table creation.
  await pool.query(`ALTER TABLE mentions DROP CONSTRAINT IF EXISTS mentions_source_source_id_key`);

  // Tier-2 human review queue. Tier 1 = noise (no action), Tier 2 =
  // pending human review per THREAT_TAXONOMY rubric, Tier 3+ = handled
  // via threat_events. review_status is NULL for non-Tier-2 mentions.
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS review_status TEXT`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS reviewed_by TEXT`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS review_notes TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS mentions_review_pending ON mentions (customer_id, ingested_at DESC) WHERE review_status = 'pending'`);

  // Author-watch (repeat-offender) tracking. When an author has 3+
  // Tier-2+ mentions for a customer in the last 30 days, the next
  // mention from that author gets its tier bumped by 1. tier_bumped
  // marks that this happened; original_tier preserves the classifier's
  // pre-bump output for audit.
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS tier_bumped BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS original_tier SMALLINT`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS bump_reason TEXT`);
  // Index for "find recent T2+ mentions by author" lookup. Used in the
  // repeat-offender heuristic on every ingest.
  await pool.query(`CREATE INDEX IF NOT EXISTS mentions_author_recent_bad ON mentions (customer_id, author_handle, ingested_at DESC) WHERE threat_tier >= 2`);

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
  await pool.query(`ALTER TABLE threat_events ADD COLUMN IF NOT EXISTS assignee_ip TEXT`);
  await pool.query(`ALTER TABLE threat_events ADD COLUMN IF NOT EXISTS assignee_taken_at TIMESTAMPTZ`);
  // Cross-customer SOC index — open + reviewing across everything,
  // sorted by tier desc.
  await pool.query(`CREATE INDEX IF NOT EXISTS threat_events_soc ON threat_events (tier DESC, created_at DESC) WHERE status IN ('open', 'reviewing')`);

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
  // Per-call token usage + cost tracking. Cost in micro-USD (1e-6 USD)
  // for stable integer math across thousands of rows. customer_id is
  // denormalized off mentions.customer_id so cost rollups skip the join.
  await pool.query(`ALTER TABLE classifications ADD COLUMN IF NOT EXISTS input_tokens INTEGER`);
  await pool.query(`ALTER TABLE classifications ADD COLUMN IF NOT EXISTS output_tokens INTEGER`);
  await pool.query(`ALTER TABLE classifications ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER`);
  await pool.query(`ALTER TABLE classifications ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER`);
  await pool.query(`ALTER TABLE classifications ADD COLUMN IF NOT EXISTS cost_usd_micro INTEGER`);
  await pool.query(`ALTER TABLE classifications ADD COLUMN IF NOT EXISTS customer_id UUID`);
  // Cost rollup index — most queries filter customer_id + created_at range.
  await pool.query(`CREATE INDEX IF NOT EXISTS classifications_cost_rollup ON classifications (customer_id, created_at DESC) WHERE cost_usd_micro IS NOT NULL`);

  // Detected classifier-spend anomalies. Worker writes one row per
  // detection; status moves open → acknowledged when an operator
  // visits the row in /admin/cost-anomalies.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cost_anomalies (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id        UUID NOT NULL REFERENCES customers(id),
      detected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cost_24h_micro     BIGINT NOT NULL,
      median_30d_micro   BIGINT NOT NULL,
      ratio              NUMERIC,           -- nullable when median was 0
      jump_micro         BIGINT NOT NULL,
      reason             TEXT NOT NULL,     -- 'ratio' | 'abs_jump'
      notified_at        TIMESTAMPTZ,
      status             TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'acknowledged' | 'dismissed'
      acknowledged_by    TEXT,
      acknowledged_at    TIMESTAMPTZ,
      notes              TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS cost_anomalies_open ON cost_anomalies (detected_at DESC) WHERE status = 'open'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cost_anomalies_customer ON cost_anomalies (customer_id, detected_at DESC)`);

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

  // Operator audit log. Every write action via /admin (or via the
  // CLI scripts) appends a row here. Compliance + customer trust.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS operator_audit (
      id            BIGSERIAL PRIMARY KEY,
      actor         TEXT NOT NULL,
      action        TEXT NOT NULL,
      target_type   TEXT,
      target_id     TEXT,
      details       JSONB,
      ip            TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS operator_audit_recent ON operator_audit (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS operator_audit_target ON operator_audit (target_type, target_id, created_at DESC)`);

  // Multi-operator auth. Replaces single-shared ADMIN_PASSWORD as the
  // canonical operator identity. ADMIN_PASSWORD Basic auth remains as
  // a bootstrap-only fallback in routes/admin.js so the user isn't
  // locked out before creating their first operator account.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS operators (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email           TEXT UNIQUE NOT NULL,
      name            TEXT NOT NULL,
      password_hash   TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'analyst',  -- 'admin' | 'analyst' | 'viewer'
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at   TIMESTAMPTZ,
      login_count     INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS operators_active_email ON operators (email) WHERE active = TRUE`);

  // Wire operator identity into existing tables (best-effort, idempotent).
  await pool.query(`ALTER TABLE operator_audit ADD COLUMN IF NOT EXISTS operator_id UUID REFERENCES operators(id)`);
  await pool.query(`ALTER TABLE threat_events ADD COLUMN IF NOT EXISTS assignee_operator_id UUID REFERENCES operators(id)`);

  // Beta-access lead form (public landing-page submissions). Operator
  // contacts these manually to qualify and provision via /admin/provision.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS beta_leads (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_name   TEXT NOT NULL,
      contact_name    TEXT,
      contact_email   TEXT NOT NULL,
      role            TEXT,
      state           CHAR(2),
      message         TEXT,
      ip              TEXT,
      user_agent      TEXT,
      status          TEXT NOT NULL DEFAULT 'new',
      contacted_at    TIMESTAMPTZ,
      provisioned_customer_id UUID REFERENCES customers(id),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS beta_leads_recent ON beta_leads (status, created_at DESC)`);

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
