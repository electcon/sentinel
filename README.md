# Sentinel — internal codename

Defensive social-media + threat-monitoring platform for Dem and Indy-aligned
campaigns. Codename only; public name TBD.

**Status:** week 1 of 7-week defensive MVP. Target ship: 2026-06-15.
Three friendly betas: Jolly for Governor, Sands for Governor,
Laubacher for U.S. House CO-04.

**Strict separation from VoteROI.** This codebase will move to its own
GitHub org + Render service + Postgres + domain once those accounts are
provisioned. No DB connections to the VoteROI Postgres, no shared
auth, no cross-product UI references.

## v1 scope (June 15)

In:
- Reddit + Bluesky + RSS-news + public-Facebook ingest
- Per-customer target registry (people, accounts, search terms)
- Claude-driven 4-tier threat classifier
- Web dashboard (mention volume, threat queue, case management)
- Daily 7am ET email digest per customer
- Real-time email alert on tier 3+ threats

Out:
- X/Twitter ingest (firehose cost prohibitive at MVP budget)
- Podcast / TV transcript ingestion
- Offensive product (opponent monitoring, contradiction detection,
  public-record aggregation) — Phase 2
- Coordinated-inauthenticity detection
- SMS / Slack / mobile

See `THREAT_TAXONOMY.md` for the 4-tier classification rubric.
See `ARCHITECTURE.md` for the system shape.

## Local dev

(To be filled in by the contractor in week 1.)

```
npm install
cp .env.example .env  # fill in DATABASE_URL, ANTHROPIC_API_KEY, BLUESKY_*, REDDIT_*
npm start
```
