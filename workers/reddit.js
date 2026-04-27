// workers/reddit.js
// Reddit ingest — runs as a cron job (every 10 min). Reads each
// customer's targets, queries Reddit for matching posts/comments,
// classifies each via classify.js, persists to mentions + threat_events.
//
// CONTRACTOR: this is a stub. Implementation tasks for week 2:
//
//   1. OAuth2 client-credentials flow (Reddit script-app pattern).
//      https://www.reddit.com/dev/api#section_using_application_only_oauth
//      Cache the access token in-memory; refresh ~10 min before expiry.
//
//   2. For each customer's targets, build a query string from
//      target.aliases + target.search_terms. Reddit's search supports
//      `OR` and quoted phrases. Default subreddit scope: site-wide.
//      Per-customer override possible later via a target.scope JSONB
//      column (not in v1).
//
//   3. Hit /search.json?q=...&sort=new&t=hour&limit=100. Page through
//      `after` cursor for full coverage. Throttle: 60 req/min on OAuth.
//
//   4. For each result:
//      - Skip if (source='reddit', source_id=t3_xxx) already in DB
//        (UNIQUE constraint will reject; do a SELECT first to skip
//        the LLM call cost).
//      - Resolve target by alias match (regex, case-insensitive).
//      - Call classify({...}). On classification, INSERT mention row.
//      - If tier >= 3, INSERT threat_events row + trigger alert.
//      - Archive raw payload to S3 (key format from ARCHITECTURE.md).
//
//   5. Cron schedule: every 10 minutes (Render cron syntax in
//      render.yaml). Each run completes in <60s at v1 customer scale.
//
//   6. Add per-source error budget: if Reddit auth fails 3 times in a
//      row, write a row to ingest_errors and pause that source for
//      the rest of the day. Log to console; daily digest mentions
//      "1 source paused: reddit (auth failed)".

'use strict';

console.log('[reddit-worker] stub — implement in week 2');
process.exit(0);
