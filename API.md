# Sentinel Public API v1

Read-only HTTP API for customers to integrate Sentinel data with their
own systems (SIEM, Slack bots, custom dashboards, audit pipelines).

**Base URL:** `https://sentinel.parallaxadvisory.llc/api/v1`
**Auth:** `Authorization: Bearer sk_<32 hex chars>`
**Rate limit:** 60 requests/minute per API key
**Versioning:** Path-versioned (`/api/v1/`); we bump to `/v2` for breaking changes

## Authentication

1. Log into your Sentinel customer dashboard at `/login`
2. Visit **Settings → API keys**
3. Click **+ Generate new key** with a descriptive label
4. **Copy the key immediately** — it's shown once and never again. Store it like a password.
5. Include it in every request: `Authorization: Bearer sk_<key>`

To revoke: same UI, click **Revoke** next to the key. Revoked keys 401 immediately.

Keys are scoped to a single customer — you can never see another customer's data.

## Endpoints

### `GET /api/v1` — service descriptor

Public (no auth). Useful for sanity checks and discovery.

```bash
curl https://sentinel.parallaxadvisory.llc/api/v1
```

### `GET /api/v1/customer` — your customer record

```bash
curl https://sentinel.parallaxadvisory.llc/api/v1/customer \
  -H 'Authorization: Bearer sk_...'
```

### `GET /api/v1/targets` — your monitored targets

```json
{
  "targets": [
    { "id": "uuid", "kind": "candidate", "name": "Jane Doe", "aliases": ["Doe"], "search_terms": ["Jane Doe"], "created_at": "..." }
  ]
}
```

### `GET /api/v1/mentions` — paginated mention list

Query params:
- `limit` (max 200, default 50)
- `tier` (1, 2, 3, or 4)
- `source` (reddit | bluesky | rss | x | telegram | truthsocial)
- `since` (ISO 8601 datetime — only mentions ingested at or after this time)
- `cursor` (UUID — pass back the `next_cursor` from a previous response)

```bash
curl 'https://sentinel.parallaxadvisory.llc/api/v1/mentions?tier=3&limit=100' \
  -H 'Authorization: Bearer sk_...'
```

Response shape:
```json
{
  "mentions": [
    {
      "id": "uuid",
      "tier": 3,
      "original_tier": 2,
      "tier_bumped": true,
      "bump_reason": "repeat_offender:5_t2plus_in_30d",
      "source": "reddit",
      "source_id": "t3_abc123",
      "source_url": "https://reddit.com/...",
      "author_handle": "...",
      "posted_at": "2026-04-28T...",
      "ingested_at": "2026-04-28T...",
      "body_excerpt": "...",
      "rationale": "Classifier reasoning here",
      "classifier_v": "tax-v1.2",
      "s3_key": "customer_id=.../...",
      "review_status": null,
      "reviewed_at": null,
      "reviewed_by": null,
      "target": { "id": "uuid", "name": "Jane Doe", "kind": "candidate" }
    }
  ],
  "next_cursor": "<uuid>" 
}
```

### `GET /api/v1/mentions/:id` — single mention detail

Full row including raw rationale + classifier metadata.

### `GET /api/v1/threats` — paginated threat-events

Query params:
- `limit` (max 200, default 50)
- `status` (open | reviewing | reported_platform | reported_law_enf | monitoring | dismissed)
- `cursor` (UUID)

### `GET /api/v1/threats/:id` — single threat detail

Includes the full `notes` audit trail.

### `GET /api/v1/authors/:handle/mentions` — author history

URL-encode the handle (it might contain `:` or `/` for did:plc:... format).

```bash
curl "https://sentinel.parallaxadvisory.llc/api/v1/authors/$(printf %s 'someone' | jq -sRr @uri)/mentions?limit=50" \
  -H 'Authorization: Bearer sk_...'
```

## Errors

All errors return JSON: `{ "error": "<human-readable message>" }`.

- `401` — missing / bad / revoked / customer-suspended API key
- `404` — resource not found OR not owned by your customer
- `429` — rate limit (60 req/min/key); `Retry-After` header indicates wait time
- `500` — server error; please email `support@sentinel.parallaxadvisory.llc`

## Examples

### Pull all open Tier-3+ threats

```bash
curl 'https://sentinel.parallaxadvisory.llc/api/v1/threats?status=open' \
  -H "Authorization: Bearer $SENTINEL_API_KEY" | jq '.threats[] | select(.tier >= 3)'
```

### Stream new mentions into your SIEM

Poll `/mentions?since=<last-poll-time>&limit=200` every 5 minutes. Use
the `id` field for deduplication on your side.

### Tail a specific author's harassment timeline

```bash
HANDLE='did:plc:abc123'
curl "https://sentinel.parallaxadvisory.llc/api/v1/authors/$(printf %s "$HANDLE" | jq -sRr @uri)/mentions" \
  -H "Authorization: Bearer $SENTINEL_API_KEY"
```

## What's NOT in v1

- Write endpoints (creating mentions, updating threats, etc.) — read-only
- Webhook subscriptions managed via API — for now, configure webhooks in `/dashboard/settings`
- Bulk export endpoints — use CSV exports in `/dashboard/settings` instead for big pulls
- Granular scopes — every key has `read` scope (covers all GET endpoints)
- WebSocket / SSE streaming — poll `?since=` for now

These are likely to land in v2 based on customer demand.
