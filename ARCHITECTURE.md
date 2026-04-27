# Sentinel architecture v1

## System shape

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          INGEST WORKERS (cron)                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│  │  Reddit    │  │  Bluesky   │  │ RSS / news │  │ FB Pages   │         │
│  │  worker    │  │  worker    │  │  worker    │  │  worker    │         │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘         │
│        │ raw payload   │ raw payload   │ raw payload   │ raw payload    │
└────────┼───────────────┼───────────────┼───────────────┼────────────────┘
         │               │               │               │
         └───────────────┴───────────────┴───────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        ENRICH PIPELINE                                  │
│  1. NER + entity-resolve mention → target (regex first, LLM fallback)  │
│  2. Drop if no target match                                             │
│  3. Claude-classify: tier (1-4), sentiment, rationale                   │
│  4. Write mention row + raw S3 payload + threat_event row if tier ≥ 3   │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          POSTGRES + S3                                  │
│   targets         (per-customer registry — people, accounts, terms)    │
│   mentions        (every classified mention, with tier + sentiment)    │
│   threat_events   (tier 3+ only, with case-management state)            │
│   customers       (account, billing tier, alert routing)                │
│   alert_routes    (where tier 3+ alerts go — email, future SMS)         │
│   classifications (audit trail of every LLM call for retraining)        │
│                                                                          │
│   S3 bucket: sentinel-evidence/{customer_id}/{date}/{mention_id}.json   │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       NOTIFY + RENDER                                   │
│   Daily digest (7am ET cron, per customer)                             │
│   Real-time alert (tier 3+ trigger, < 5 min latency)                   │
│   Web dashboard (mentions chart, threat queue, case management)        │
└─────────────────────────────────────────────────────────────────────────┘
```

## Storage

### Postgres tables (v1)

```sql
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  alert_email   TEXT NOT NULL,        -- where tier 3+ alerts go
  digest_email  TEXT NOT NULL,        -- where daily digest goes
  status        TEXT NOT NULL DEFAULT 'beta',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE targets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  kind          TEXT NOT NULL,        -- 'candidate' | 'family' | 'staff' | 'surrogate'
  name          TEXT NOT NULL,        -- canonical display name
  aliases       JSONB DEFAULT '[]',   -- ["Eileen", "RA Laubacher", ...]
  handles       JSONB DEFAULT '[]',   -- [{platform:'reddit', user:'EileenLaubacher'}, ...]
  search_terms  JSONB DEFAULT '[]',   -- explicit phrases to search ingest streams for
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE mentions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  target_id     UUID REFERENCES targets(id),  -- null if unresolved
  source        TEXT NOT NULL,         -- 'reddit' | 'bluesky' | 'rss' | 'fb_pages'
  source_id     TEXT NOT NULL,         -- platform-native id
  source_url    TEXT,
  author_handle TEXT,
  posted_at     TIMESTAMPTZ NOT NULL,
  ingested_at   TIMESTAMPTZ DEFAULT NOW(),
  body_excerpt  TEXT,                   -- ~500 char preview
  s3_key        TEXT,                   -- raw payload archive
  threat_tier   SMALLINT,               -- 1-4
  sentiment     SMALLINT,               -- -2..+2
  rationale     TEXT,                   -- LLM short explanation
  classifier_v  TEXT,                   -- prompt version
  UNIQUE (source, source_id)
);

CREATE INDEX mentions_customer_time ON mentions (customer_id, posted_at DESC);
CREATE INDEX mentions_target_tier ON mentions (target_id, threat_tier) WHERE threat_tier >= 2;

CREATE TABLE threat_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mention_id    UUID NOT NULL REFERENCES mentions(id),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  target_id     UUID REFERENCES targets(id),
  tier          SMALLINT NOT NULL,      -- denormalized for fast queue queries
  status        TEXT NOT NULL DEFAULT 'open',
                                         -- 'open' | 'reviewing' | 'reported_platform' |
                                         -- 'reported_law_enf' | 'dismissed' | 'monitoring'
  assignee      TEXT,                    -- email of reviewer
  notes         TEXT,
  alerted_at    TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX threat_events_open ON threat_events (customer_id, tier DESC, created_at DESC)
  WHERE status NOT IN ('dismissed', 'reported_law_enf', 'monitoring');

CREATE TABLE classifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mention_id    UUID NOT NULL REFERENCES mentions(id),
  prompt_v      TEXT NOT NULL,
  model         TEXT NOT NULL,
  tier          SMALLINT NOT NULL,
  confidence    NUMERIC,
  raw_response  JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### S3 layout

```
sentinel-evidence/
  customer_id={uuid}/
    date=2026-04-26/
      reddit_t3_abc123.json    (raw payload + screenshot)
      bluesky_at_xyz.json
      ...
```

Evidence is preservation-grade. Never auto-delete. Lifecycle policy: move
to Glacier at 90 days, never expire. Important for law-enforcement
referrals.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Server | Node 20 + Express | Same stack as VoteROI; contractor pool is large |
| DB | Postgres on Render | Same as VoteROI ops practice; `gen_random_uuid()` needs `pgcrypto` extension |
| Search | OpenSearch when scale demands; Postgres FTS for v1 | Avoid premature complexity |
| Object store | AWS S3 | Cheap, durable, easy lifecycle |
| LLM | Claude Haiku 4.5 (claude-haiku-4-5-20251001) | Cheap per-call, fast, good at structured classification. Sonnet 4.6 fallback for hard cases. |
| Email | Resend | Same as VoteROI |
| Scheduler | Render cron (or GitHub Actions cron) | No K8s |
| Hosting | Render Web Service + Render Postgres | Founder already operates Render |

## Deploy environments

- `sentinel-staging-{slug}.onrender.com` — autodeploy from `staging` branch
- `sentinel-prod-{slug}.onrender.com` — autodeploy from `main` branch
- Public domain (TBD post-MVP) CNAMEs to prod

## Auth

- v1: HTTP basic auth or single shared password per customer (manual provisioning, 3 customers, friendly betas).
- v2: SSO with Google Workspace / Microsoft 365. Most campaigns are on one of these.
- No self-serve signup ever. Every account is manually approved by founder.
- AUP enforcement: contract clauses + monthly account review + automated flags on suspicious query patterns (e.g., a customer searching for civilians not in their target list).

## Cost model (per-customer, per-month, at v1 scale)

- Render Web + Postgres + cron: ~$50/mo amortized
- S3 evidence: ~$2-5/mo (low GB at v1 scale)
- Claude API: ~$30-80/mo (depends on mention volume; Reddit + Bluesky for one campaign yields maybe 5-50K classifiable mentions/mo)
- Resend: $0 (within free tier at this volume)
- Total infra-attributable: ~$80-130/customer/month

At $500/customer/month beta pricing → 75-85% gross margin. Sustainable.

At Phase 2 (X firehose, podcast Whisper) costs jump to ~$500/customer/month
amortized. Pricing must move to $2-3K/customer/month then. Still fine for
serious campaigns.
