# Sentinel — execution log

Started: 2026-04-26.

## Major scope shift

David decided 2026-04-26 to build solo with Claude doing all coding.
`HIRING.md` is shelved. The 7-week timeline holds.

## Week 1 — scaffolding + week 2 — overnight (2026-04-26 → 2026-04-27)

A continuous build session collapsed week 1 + week 2 into one push.
By morning of 2026-04-27 the v1 platform is functionally complete
end-to-end — only Resend API key + AUP clearance + real beta-customer
target lists remain to start serving real campaigns.

### Done — infra

- [x] `electcon/sentinel` GitHub repo, ~25 commits over the build
- [x] Render Postgres `sentinel-db` (virginia) — schema initialized
- [x] Render web service `sentinel-staging-i3ug.onrender.com` — running
- [x] AWS S3 bucket `sentinel-evidence` (us-east-2) with 30d→Standard-IA,
      90d→Glacier lifecycle. IAM user `sentinel-app` scoped to bucket.
- [x] Anthropic API key (separate billing from VoteROI)
- [x] OpenRouter API key (alternate classifier provider)
- [x] twitterapi.io API key (X ingest)
- [x] Sentinel = both internal codename AND public-facing name (no rebrand)

### Done — code

- [x] `THREAT_TAXONOMY.md` v1.2 — sharpened Tier 1/2 boundary, robust
      against post-JSON markdown
- [x] `classify.js` — Anthropic + OpenRouter pluggable providers,
      JSON-extraction parser with balanced-brace handling
- [x] **Reddit ingest** worker (`workers/reddit.js` + `lib/reddit.js`) —
      anonymous public search, dupe-skip, S3 archive, classify, persist
- [x] **Bluesky ingest** worker (`workers/bluesky.js` + `lib/bluesky.js`) —
      AT-protocol public search
- [x] **RSS ingest** worker (`workers/rss.js` + `lib/rss.js`) — Google
      News RSS per target
- [x] **X (Twitter) ingest** worker (`workers/x.js` + `lib/x-client.js`) —
      twitterapi.io REST, lib-level QPS rate limiting (5.1s gap for
      free-tier compatibility)
- [x] **Alert worker** (`workers/alert.js` + `lib/alert.js`) — sweeps
      open un-alerted tier-3+ events, sends Resend email (or dry-run
      logs if no key set)
- [x] **Daily digest worker** (`workers/digest.js` + `lib/digest.js`) —
      per-customer 24h rollup with tier breakdown + top mentions,
      tracked via `customers.last_digest_at`
- [x] **In-process scheduler** — setInterval-based, runs all workers on
      staggered intervals; per-source error budget (5 consec failures
      pauses 30 min, auto-resume); idempotent dupe-skip
- [x] **Worker run tracking** (`worker_runs` table) — every scheduler
      tick logged with duration, ok/fail, summary, error
- [x] **Customer auth** (`lib/auth.js`) — scrypt password hashing,
      signed-cookie sessions (HMAC-SHA256), 30-day expiry
- [x] **Customer dashboard** (`routes/dashboard.js`):
      `/dashboard` overview (open threats + 24h count + system health
      panel + 14-day SVG mention-volume chart)
      `/dashboard/threats` (filterable queue)
      `/dashboard/threats/:id` with status-update form + audit-trail notes
      `/dashboard/mentions` paginated, with text search + tier/source
      filters; CSV export
      `/dashboard/threats.csv` export
      `/dashboard/settings` — change emails / password / targets CRUD /
      bulk targets import (JSON or one-per-line)
      `/login` + `/logout` with rate-limit (10 attempts / 10 min → lock 30 min)
- [x] **Internal `/admin`** (Basic auth via `ADMIN_PASSWORD`) — overview,
      customers, workers, errors, threats — David's omniscient view
- [x] **Public `/status`** + `/status.json` — uptime + per-worker health,
      no PII (suitable for uptime monitors)
- [x] **Customer provisioning** (`scripts/provision-customer.js`) — JSON-
      driven idempotent customer + targets + password + optional welcome
      email via Resend on `--send-welcome`
- [x] **Security hardening** — strict CSP, X-Frame-Options DENY, HSTS,
      anti-bruteforce login limit, per-customer data isolation, scoped
      AWS IAM, SQL parameterization throughout
- [x] **29 unit tests** (`node --test tests/*.test.js`) covering
      lib/match, lib/auth, classify JSON parser

### Smoke results

Live test mentions ingested across the 4 sources during the build:
~250 mentions in the dev customer DB after first 24 hours of scheduled
runs. Classifier 6/6 correct against synthetic tier rubric (taxonomy
v1.2). Synthetic tier-3 + tier-4 threats correctly trigger
`threat_events` rows + alert worker (dry-run).

## Blocked on you (David) — week 2 pickup

- [ ] **Resend API key** for Sentinel — without this, alerts and digests
      log "DRY-RUN" instead of sending. Either reuse VoteROI's Resend
      account or create a separate one. Add as `RESEND_API_KEY` env on
      Render.
- [ ] **`ADMIN_PASSWORD` on Render** — sets up `/admin` (currently 404
      without it). Pick a strong 16+ char password, paste to Render env.
- [ ] **`OPENROUTER_API_KEY` credit funding** — key is wired but the
      account has no credits. Visit https://openrouter.ai/settings/credits.
- [ ] **twitterapi.io AUP clearance** — email support@twitterapi.io to
      confirm political-defensive-monitoring use case is allowed BEFORE
      onboarding any beta customer.
- [ ] **Beta-pitch email forwards** — three emails to Jolly, Sands,
      Laubacher campaign managers. Use `BETA_PITCH.md`. Goal: meetings
      booked by Friday May 2.
- [ ] **Beta target intake forms** — once managers respond, get them to
      fill in the `customers/TEMPLATE.json` shape (or send via secure
      channel as a list). Then run
      `node scripts/provision-customer.js customers/<slug>.json`.
- [ ] **Custom domain decision** — `sentinel-staging-i3ug.onrender.com`
      is a Render subdomain. Phase 2: register `sentinelhq.com` or
      similar and CNAME to Render.
- [ ] **Rotate the leaked tokens in chat transcript** — GH PAT, Render
      API key, AWS access key, OpenRouter key, twitterapi.io key.

## What's next (Phase 2 / post-MVP candidates)

Captured for later, NOT shipping in v1:

- TruthSocial ingest (Mastodon API; needs service account + token)
- Real-time Bluesky firehose (Jetstream WebSocket; lower latency than
  5-min polling)
- Per-customer custom RSS feeds (today: only Google News per target)
- Custom domain + TLS
- SSO via Google Workspace / Microsoft 365 (instead of shared password)
- Self-serve signup with screening
- Mobile alerts (SMS via Twilio, push via OneSignal)
- Provider abstraction completion: swap twitterapi.io → Apify if needed


## Risks I'm watching

- **Founder time slip** (your 30% commitment). If VoteROI demands
  100% for any week, week 1 + 2 of Sentinel slips. Hard to recover
  in a 7-week plan.
- **Engineer hire timing** — if no qualified candidate accepts by
  May 5, contractor onboards May 8 instead of May 1, meaning ingest
  workers slip from week 2 to week 3. Cascades.
- **X firehose pressure** — when betas see no Twitter coverage, they
  may push hard for it. Hold the line: "Phase 2." If they pay for
  Phase 2, X gets added.
- **Threat-classification false negatives** — biggest product risk.
  Conservative bias in the classifier (confidence < 0.7 → bump tier)
  is the first defense. Human review on tier 2+ is the second. We
  budget reviewer time as part of customer success cost.
