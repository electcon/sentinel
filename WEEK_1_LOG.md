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

## Blocked on you (David)

- [ ] **Sentinel GitHub org** created — I need org name + admin access
      to push the `sentinel/` directory as the initial commit there.
- [ ] **Sentinel Render account** + Postgres provisioned — I need the
      `DATABASE_URL` so I can run schema init on the real DB before
      the contractor onboards.
- [ ] **Sentinel Stripe account** opened (separate from AMII PAC's
      VoteROI Stripe per your decision).
- [ ] **Anthropic API key** for Sentinel (separate from VoteROI's,
      different billing). Needed so the classifier smoke-test works
      against real DB.
- [ ] **AWS S3 bucket** `sentinel-evidence` created in us-east-1 with
      lifecycle policy: STANDARD → STANDARD_IA at 30d → GLACIER at
      90d → no expiration. IAM credentials with PutObject + GetObject
      scoped to that bucket.
- [ ] **Beta-pitch email forwards** — three emails to Jolly, Sands,
      Laubacher campaign managers. Use the `BETA_PITCH.md` 1-paragraph
      body. Goal: meetings booked by Friday May 2.
- [ ] **Engineer sourcing** — paste / forward the templates in
      `HIRING.md`. Higher Ground Labs Slack first; YC May-1 thread; 5
      personal DMs. I review the inbound replies and run the screening
      Q&A.
- [ ] **Codename / public-name decision** — Sentinel for internal use
      is fine. Public-facing name decision needed before week 5
      (dashboard ships with copy that names the product).

## What I'm doing next (week 2 of execution, week 1 with contractor)

Once the contractor is onboard and the env-var blockers above are
unblocked:

1. Reddit ingest worker — implements the stub at workers/reddit.js per
   the embedded task list
2. Bluesky ingest worker — same shape
3. RSS worker + per-customer feed configuration UI (admin-only screen)
4. End-to-end: ingest one real Reddit post → classify → DB write → S3
   archive. Demo via local cli that writes one mention end-to-end.

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
