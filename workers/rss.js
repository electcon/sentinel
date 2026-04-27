// workers/rss.js
// RSS / news ingest. Runs every 15 min.
//
// CONTRACTOR: stub. Week 2 implementation:
//
//   1. RSS feeds are configured per-customer in a new table:
//        rss_feeds (customer_id, url, name, last_fetched_at, etag)
//      Pre-seed each beta customer with: their state's major papers,
//      Politico (national), Axios local, plus Google News alerts for
//      each target.name. Total ~10-20 feeds per customer.
//
//   2. Use feedparser-promised or a similar lib. Conditional GET via
//      etag/last-modified to avoid refetching.
//
//   3. For each new item: scan title + description for any target
//      alias. If match, the WHOLE article body needs to be fetched —
//      RSS descriptions are usually truncated. Use readability/mercury
//      to extract main content. Then classify the relevant excerpt.
//
//   4. News articles rarely contain explicit threats — they're mostly
//      tier 1 mentions for trend tracking. But: a hostile op-ed
//      naming the candidate's family, or a published address, can
//      be tier 2-3. Don't shortcut the classifier.

'use strict';

console.log('[rss-worker] stub — implement in week 2');
process.exit(0);
