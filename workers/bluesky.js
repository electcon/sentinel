// workers/bluesky.js
// Bluesky ingest via AT-Proto. Runs every 5 min as Render cron.
//
// CONTRACTOR: stub. Week 2 implementation:
//
//   1. Auth: createSession with BLUESKY_IDENTIFIER + BLUESKY_APP_PASSWORD
//      against bsky.social. Save accessJwt + refreshJwt; refresh on 401.
//
//   2. For each customer's targets:
//        - app.bsky.feed.searchPosts ?q=<aliases OR>&since=<last_seen>&limit=100
//        - Page if results.length === limit
//
//   3. Per result, same flow as reddit.js: dedup, resolve target,
//      classify, persist.
//
//   4. Bluesky firehose (via Jetstream WS) is an option later — gives
//      us real-time instead of 5-min cron. v2 scope.

'use strict';

console.log('[bluesky-worker] stub — implement in week 2');
process.exit(0);
