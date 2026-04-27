# TruthSocial — onboarding (service-account access)

Code is shipped (`lib/truthsocial.js`, `workers/truthsocial.js`). Worker
stays dormant until `TRUTHSOCIAL_ACCESS_TOKEN` is set on Render.

## Why TruthSocial

It's the platform with the highest concentration of MAGA-aligned hostile
rhetoric directed at Democratic and Indy candidates by name. Coverage
gap when not monitored. Mastodon-fork API, public posts only.

## Steps

1. **Sign up a service account at truthsocial.com**
   - Use a generic email (e.g. `monitor@parallaxadvisory.llc` if you
     have it; otherwise any address you control)
   - This account never posts. It's read-only.
   - Confirm the email; complete profile setup if forced

2. **Mint an access token** (two paths):

   **Path A — copy from web devtools (fastest):**
   - Log in to truthsocial.com in a browser
   - Open Devtools → Network tab
   - Click around the site (search anything, view a profile)
   - Find any XHR request to `/api/v1/...` or `/api/v2/...`
   - In the request headers, copy the value after `Authorization: Bearer `
   - That's your token. Tokens last ~1 year on TruthSocial; rotate annually.

   **Path B — programmatic OAuth (more durable):**
   - First, register an "app" via:
     ```
     curl -X POST 'https://truthsocial.com/api/v1/apps' \
       -F 'client_name=Sentinel' \
       -F 'redirect_uris=urn:ietf:wg:oauth:2.0:oob' \
       -F 'scopes=read'
     ```
     This returns `client_id` and `client_secret`.
   - Then mint a token:
     ```
     curl -X POST 'https://truthsocial.com/oauth/token' \
       -F 'grant_type=password' \
       -F 'client_id=...' \
       -F 'client_secret=...' \
       -F 'username=monitor@parallaxadvisory.llc' \
       -F 'password=...' \
       -F 'scope=read'
     ```
     Returns `access_token`.
   - Note: TruthSocial occasionally locks down OAuth; if Path B 401s,
     Path A always works.

3. **Set on Render**:
   - `TRUTHSOCIAL_ACCESS_TOKEN` = the bearer token
   - (optional) `TRUTHSOCIAL_QPS_GAP_MS` = `2000` (default)

4. **Verify**:
   ```
   curl -X POST 'https://sentinel.parallaxadvisory.llc/api/_smoke/truthsocial-run' \
     -H 'x-smoke-token: <SMOKE_TOKEN>'
   ```
   Expect: `{customers, queries, hits_returned, new_mentions, ...}` similar
   to the Bluesky / X smoke responses. If `not_configured` returns,
   the env var didn't load — check Render env tab.

## AUP / TOS posture

TruthSocial's TOS technically prohibits programmatic scraping of any
kind. Sentinel's posture:
- Service account never posts, never DMs, never impersonates
- Query rate matches normal user behavior (one search per ~2s, ~10 min cron)
- Public-search endpoints only; no joining gated profiles
- Documented in customer onboarding as "monitoring of public TruthSocial
  content for mentions of customer's targets"

This is the same gray-zone as twitterapi.io for X. We monitor public
posts about our customers' own targets — defensive, not opposition
research. If TruthSocial sends a takedown, comply immediately and switch
to alternate vendors (Apify, ScrapeCreators).

## Rotation

If the service-account password is changed (or the token is revoked),
update `TRUTHSOCIAL_ACCESS_TOKEN` on Render. The worker will start
returning auth errors until the new token is in place.
