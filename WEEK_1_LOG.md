# Week 1 — execution log

Started: 2026-04-26.

## Done

- [x] `sentinel/` workspace scaffolded in the VoteROI repo (will move
      to a separate Sentinel GitHub org once provisioned)
- [x] `README.md` — what Sentinel is, scope cuts for v1, dev quick-start
- [x] `THREAT_TAXONOMY.md` — 4-tier rubric with concrete examples per tier;
      this is the spec the LLM classifier reads
- [x] `ARCHITECTURE.md` — system shape, Postgres schema, S3 layout, tech
      stack rationale, cost model
- [x] `package.json` — Node 20, deps for Anthropic SDK, AWS S3, Postgres,
      Resend, Express
- [x] `.env.example` — every env var documented, including OAuth setup
      pointers for Reddit / Bluesky / Facebook
- [x] `server.js` — minimal Express boot with `/api/health` and a
      placeholder dashboard route. Idempotent schema init on startup.
- [x] `scripts/init-db.js` — full schema: customers, targets, mentions,
      threat_events, classifications, alert_routes
- [x] `classify.js` — Claude classifier integration. Reads the taxonomy
      doc as system prompt. Returns structured `{tier, confidence,
      sentiment, rationale}`. CLI smoke-test built in.
- [x] `workers/{reddit,bluesky,rss}.js` — stubs with detailed contractor
      task lists embedded as comments. Each stub explains exactly what
      week-2 implementation looks like.
- [x] `HIRING.md` — hire-pack with job spec, Slack post copy, YC
      template, personal-referral DM template, screening questions,
      interview-loop runbook, decision criteria
- [x] `BETA_PITCH.md` — 1-paragraph email body, 5-slide demo outline,
      1-page beta agreement template, talking-point script
- [x] `WEEK_1_LOG.md` (this file)

## Status update (end of week 1)

**Major scope shift, 2026-04-26:** David decided to build Sentinel solo
with Claude doing all engineering. No contractor hire. `HIRING.md` is
shelved. All week-2+ ingest / dashboard / alert work falls on Claude.

## Done (week 1)

- [x] GitHub repo `electcon/sentinel` provisioned, scaffold pushed
- [x] Render service `sentinel-staging-i3ug.onrender.com` deployed,
      `/api/health` returns 200, DB ping <50ms
- [x] Postgres `sentinel-db` (Render, virginia-postgres) — 6 tables
      initialized and verified
- [x] AWS S3 `sentinel-evidence` (us-east-2) provisioned with
      lifecycle: STANDARD → STANDARD-IA at 30d → GLACIER at 90d.
      IAM user `sentinel-app` scoped to bucket. PutObject/GetObject
      round-trip verified.
- [x] `ANTHROPIC_API_KEY` provisioned for Sentinel (separate from
      VoteROI billing)
- [x] Classifier live end-to-end. 6/6 tier-classification cases pass
      under taxonomy v1.2. `/api/_smoke/classify` token-gated for
      ongoing eval runs.
- [x] Codename/public-name decision: **Sentinel** is both. No rebrand.

## Blocked on you (David) — unchanged or new

- [ ] **Beta-pitch email forwards** — three emails to Jolly, Sands,
      Laubacher campaign managers. Use the `BETA_PITCH.md` 1-paragraph
      body. Goal: meetings booked by Friday May 2.
- [ ] **Reddit API credentials** (week 2) — register a Reddit app at
      https://www.reddit.com/prefs/apps as "script" type. I need
      `client_id`, `client_secret`, and a service account username +
      password. App-only OAuth is fine for our read-only search needs.
- [ ] **Bluesky API credentials** (week 2) — Bluesky uses an
      app-password flow. Create one at bsky.app → Settings → App
      Passwords. I need the handle + app password.
- [ ] **Rotate leaked tokens** — GH PAT, Render API key, AWS access
      key all exist in chat transcript. Rotate after week 2 if you
      haven't already.

## What I'm doing next (week 2)

Solo build kickoff:

1. **Reddit ingest worker** — full implementation of `workers/reddit.js`.
   Per-customer search-term fan-out, idempotent inserts via
   `mentions(source, source_id)` unique constraint, S3 archive of
   raw payload, classifier pass on every match, `classifications`
   audit row written.
2. **Bluesky ingest worker** — same shape, AT-protocol search.
3. **RSS worker** — per-customer feed config table + ingest loop.
4. **End-to-end demo** — a real public Reddit post about a real
   target lands in DB, gets classified, gets archived to S3.
5. **Cron / scheduler** — Render cron service runs each worker on a
   short interval (Reddit/Bluesky every 5 min, RSS every 15 min).
6. **Daily digest** — cron that gathers each customer's last-24h
   activity and emails it via Resend.

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
