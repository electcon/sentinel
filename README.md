# Sentinel

Defensive social-media + threat-monitoring platform for Dem and Indy-aligned
political campaigns. Watches Reddit, Bluesky, news (Google News RSS), and X
for mentions of customer-defined targets (candidate, family, staff). Classifies
each mention with Claude against a 4-tier threat rubric. Sends real-time email
alerts on tier 3+, daily email digests of all activity, preserves raw payloads
in S3 for evidence handoff.

**Status:** v1 platform functionally complete (2026-04-27). Target ship: 2026-06-15.

Three friendly beta cohort:
- Jolly for Governor
- Sands for Governor
- Laubacher for U.S. House CO-04

## Architecture summary

```
Render web service (sentinel.parallaxadvisory.llc)
  ├─ Express HTTP server
  ├─ In-process scheduler (setInterval)
  │   ├─ alert worker      (every 1 min — sends tier-3+ emails)
  │   ├─ bluesky worker    (every 5 min — public AT-Proto search)
  │   ├─ x worker          (every 5 min — twitterapi.io REST)
  │   ├─ reddit worker     (every 10 min — public .json search)
  │   ├─ rss worker        (every 15 min — Google News RSS per target)
  │   ├─ digest worker     (every 30 min — sends daily digest if 23h+ since last)
  │   └─ cleanup worker    (every 60 min — prunes worker_runs > 7d)
  ├─ Customer dashboard  (/dashboard, /login, /logout, /dashboard/...)
  ├─ Internal admin      (/admin — Basic auth via ADMIN_PASSWORD)
  └─ Public status       (/status, /status.json)

Render Postgres (sentinel-db) — see ARCHITECTURE.md for schema
AWS S3 (sentinel-evidence, us-east-2) — raw payload archive, 30d→IA, 90d→Glacier
Anthropic API — Claude Haiku 4.5 default, Sonnet 4.6 escalation
Resend — alert + digest email
twitterapi.io — X (Twitter) ingest
OpenRouter — alternate classifier provider (optional, env-gated)
```

## Quick start (local dev)

```bash
npm install
cp .env.example .env  # fill in DATABASE_URL, ANTHROPIC_API_KEY, AWS_*, etc.
node scripts/init-db.js          # idempotent schema bootstrap
node scripts/seed-dev.js         # creates dev customer with login: david@voteroi.com / sentinel-dev-2026
npm start                        # boots web server + scheduler
npm test                         # 29 unit tests via node --test
```

For a prod-shape deploy (single dyno on Render or any Node host):
1. Set env vars (see `.env.example` + sections below)
2. `node scripts/init-db.js` (or rely on `runStartupSequence` to do it on boot)
3. `node server.js` — schedulers auto-start when `NODE_ENV=production`

## Operating

### Provisioning a real beta customer

1. Copy `customers/TEMPLATE.json` to `customers/<campaign-slug>.json`
2. Fill in real values (campaign manager email, alert routing, target list,
   shared password). Do NOT commit — `customers/.gitignore` enforces this.
3. `node scripts/provision-customer.js customers/<slug>.json`
4. Optionally `--send-welcome` to email login creds via Resend
5. Re-running with the same name updates idempotently

### Adding/removing targets

Targets can be edited via the web dashboard at `/dashboard/settings`. Or
re-run `provision-customer.js` with an updated JSON.

### Operating views

- `/` — public marketing landing page + beta-access form (unauthed); auto-redirects to `/dashboard` if session cookie valid
- `/dashboard` — customer view (logged-in)
- `/admin` — David's view (Basic auth via `ADMIN_PASSWORD`):
  - `/admin/customers` (+ `/admin/customers/:id` per-customer detail with hate-crime risk panel)
  - `/admin/provision` web form to onboard new customers
  - `/admin/leads` — beta-access form submissions with status workflow
  - `/admin/audit` — operator action history
  - `/admin/classifier-quality` — reviewer-disposition rollups for drift detection
  - `/admin/telegram-channels` — operator-curated seed list
  - `/admin/workers`, `/admin/errors`, `/admin/threats`
- `/status` — public health page (no PII)
- `/api/health` — JSON health check (used by uptime monitors)

### Smoke tests

Two gating tiers. **Master kill switch:** set `SMOKE_DISABLED=true` on
Render once real customers are onboarded — all `/api/_smoke/*` routes
return 404.

**Low-risk endpoints** (read-only or ingest-only) require just `SMOKE_TOKEN`:

```bash
TOK="$SMOKE_TOKEN"
URL="https://sentinel.parallaxadvisory.llc"
curl -X POST "$URL/api/_smoke/reddit-run" -H "x-smoke-token: $TOK"
curl -X POST "$URL/api/_smoke/bluesky-run" -H "x-smoke-token: $TOK"
curl -X POST "$URL/api/_smoke/rss-run" -H "x-smoke-token: $TOK"
curl -X POST "$URL/api/_smoke/x-run" -H "x-smoke-token: $TOK"
curl -X POST "$URL/api/_smoke/telegram-run" -H "x-smoke-token: $TOK"
curl -X POST "$URL/api/_smoke/truthsocial-run" -H "x-smoke-token: $TOK"
curl -X POST "$URL/api/_smoke/cisa-run" -H "x-smoke-token: $TOK"
curl    -G "$URL/api/_smoke/fbi-state-stats" --data-urlencode "state=NH" -H "x-smoke-token: $TOK"
curl -X POST "$URL/api/_smoke/classify" -H "x-smoke-token: $TOK" \
  -H "content-type: application/json" -d '{"text":"...","target":"..."}'
```

**High-risk endpoints** (sends real email, creates synthetic data,
cross-customer reads) require `SMOKE_TOKEN` + `X-Admin-Password`:

```bash
PW="$ADMIN_PASSWORD"
curl -X POST "$URL/api/_smoke/digest-run" \
  -H "x-smoke-token: $TOK" -H "x-admin-password: $PW" \
  -H "content-type: application/json" -d '{"force":true}'
curl -X POST "$URL/api/_smoke/alert-run"           -H "x-smoke-token: $TOK" -H "x-admin-password: $PW"
curl -X POST "$URL/api/_smoke/inject-test-threat"  -H "x-smoke-token: $TOK" -H "x-admin-password: $PW" \
  -H "content-type: application/json" -d '{"tier":3}'
curl -X POST "$URL/api/_smoke/seed-dev"            -H "x-smoke-token: $TOK" -H "x-admin-password: $PW"
curl -X POST "$URL/api/_smoke/cleanup-duplicates"  -H "x-smoke-token: $TOK" -H "x-admin-password: $PW"
curl    -G "$URL/api/_smoke/mentions" --data-urlencode "limit=10" -H "x-smoke-token: $TOK" -H "x-admin-password: $PW"
curl       "$URL/api/_smoke/threats"               -H "x-smoke-token: $TOK" -H "x-admin-password: $PW"
```

The smoke endpoints are slated for removal once a fuller admin API ships.
Until then, the `/admin` page surfaces a banner showing the smoke state
(enabled / disabled).

## Environment variables

Required:
- `DATABASE_URL` — Render Postgres connection string
- `ANTHROPIC_API_KEY` — for the classifier
- `SMOKE_TOKEN` — gates the `/api/_smoke/*` endpoints (also doubles as
  `SESSION_SECRET` fallback for cookie signing)

Strongly recommended:
- `ADMIN_PASSWORD` — gates `/admin`. Without it, `/admin` returns 404.
- `RESEND_API_KEY` — without it, alerts/digests log "DRY-RUN" instead of sending.
  **Important:** the FROM domain must be verified in the Resend account
  attached to this key (see https://resend.com/domains). Defaults are
  `alerts@sentinel.parallaxadvisory.llc` and `digest@sentinel.parallaxadvisory.llc`;
  override via `ALERT_FROM_EMAIL` / `DIGEST_FROM_EMAIL` if your verified
  domain differs.
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` —
  evidence archive (sentinel-evidence in us-east-2)

Optional / per-source:
- `DASHBOARD_BASE_URL` — full https URL of dashboard (used in email links).
  Defaults to `https://sentinel.parallaxadvisory.llc` when unset.
- `TWITTERAPI_API_KEY` — X ingest via twitterapi.io
- `FBI_CDE_API_KEY` — FBI Crime Data Explorer (free key from api.data.gov)
- `CISA_TAXII_*` — see `CISA_AIS_ONBOARDING.md`; worker dormant until set
- `OPENROUTER_API_KEY` + `CLASSIFIER_PROVIDER=openrouter` + `OPENROUTER_MODEL` —
  use OpenRouter instead of direct Anthropic
- `SESSION_SECRET` — cookie signing (falls back to SMOKE_TOKEN if unset)
- `SCHEDULER_ENABLED=true` — force-enable scheduler in non-prod
- `WORKER_FAIL_THRESHOLD` (default 5), `WORKER_PAUSE_DURATION_MS` (default 30 min)
- `X_QPS_GAP_MS` (default 5100ms — twitterapi.io free-tier rate limit)
- `TELEGRAM_STALE_THRESHOLD` (default 5 — auto-pause channel after N empty/error fetches)
- `SMOKE_DISABLED=true` — kill switch: all `/api/_smoke/*` routes return 404. Set once real customers are onboarded.
- `TRUTHSOCIAL_ACCESS_TOKEN` — see `TRUTHSOCIAL_ONBOARDING.md`; worker dormant until set
- `STRIPE_SECRET_KEY` — `sk_live_...` or `sk_test_...`. Without it, all Stripe features 503 / hide.
- `STRIPE_PUBLISHABLE_KEY` — `pk_live_...` or `pk_test_...`. Currently unused server-side (Checkout is server-driven), but recommended for future client-side flows.
- `STRIPE_WEBHOOK_SECRET` — `whsec_...`. Required for `/api/stripe-webhook` signature verification. Get this from Stripe dashboard when you create the webhook endpoint.
- `STRIPE_BETA_PRICE_USD` (default 500), `STRIPE_BETA_PRICE_INTERVAL` ('month' default; 'year' valid) — controls the auto-created Sentinel Beta product/price.
- `BLUESKY_FIREHOSE_ENABLED=true` — turn on the real-time Jetstream WebSocket subscription. Adds <60s latency (vs. 5-min poll). Polling worker keeps running as a backstop. Stats: `/api/_smoke/bluesky-firehose-stats`.

## Tests

```bash
npm test
```

Covers `lib/match` (alias regex matching edge cases), `lib/auth` (scrypt +
session signing), and `classify` (JSON-extraction parser robust against
LLM markdown wrapping). 29 tests; run in <1s.

## Reference docs

- `THREAT_TAXONOMY.md` — the 4-tier rubric the classifier reads as system prompt
- `ARCHITECTURE.md` — system shape, full Postgres schema, S3 layout, cost model
- `BETA_PITCH.md` — what David sends to campaign managers + 1-page beta agreement
- `WEEK_1_LOG.md` — running execution log
- `HIRING.md` — **shelved** (David is building solo with Claude — no contractor)

## v1 scope (locked)

In:
- Reddit + Bluesky + RSS + X ingest
- Per-customer target registry with bulk-import + CRUD
- Claude-driven 4-tier threat classifier (Anthropic direct or OpenRouter)
- Web dashboard with threat queue, mentions list/search, mention volume chart,
  CSV export, settings UI, audit-trail notes on threat actions
- Daily digest email + real-time tier-3+ alerts
- Internal `/admin` page for ops visibility
- Public `/status` page

Out (Phase 2 candidates):
- TruthSocial / Mastodon ingest
- Real-time Bluesky firehose (Jetstream)
- SSO (Google Workspace / Microsoft 365)
- Self-serve signup
- Mobile alerts (SMS, push)
- Custom domain + TLS
