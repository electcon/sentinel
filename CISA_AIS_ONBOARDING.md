# CISA AIS — onboarding (TAXII 2.1 access)

Code is shipped (`lib/cisa.js`, `workers/cisa.js`). The worker stays
dormant until the four `CISA_TAXII_*` env vars are set on Render.
Onboarding takes ~1–4 weeks of email back-and-forth with CISA.

## Steps

1. **Email CISA's NCCIC team** to request AIS access:
   - To: `central@cisa.dhs.gov` (or `ncciccustomerservice@cisa.dhs.gov`
     if the first bounces — the address has rotated over the years)
   - Subject: `AIS Access Request — Parallax Advisory LLC`
   - Body template:

   ```
   Hi —

   I'm requesting Automated Indicator Sharing (AIS) access for Parallax
   Advisory LLC. We operate Sentinel, a defensive social-media + threat-
   monitoring service for U.S. political campaigns. Cyber-IOC indicators
   from AIS would be cross-referenced against URLs and domains appearing
   in social-media content we monitor on behalf of those campaigns —
   primarily to detect phishing campaigns aimed at campaign staff.

   We are a private-sector U.S. entity, not a sworn law-enforcement
   agency. We commit to AIS Terms of Use including TLP handling rules
   and non-disclosure of indicators outside our customer base.

   Technical contact: David Wheeler, david@parallaxadvisory.llc
   Organization: Parallax Advisory LLC
   Use case: defensive cyber + threat monitoring for political-campaign
   customers (Sentinel product surface)

   Please send the AIS Terms of Use and onboarding instructions.

   Thanks,
   David Wheeler
   ```

2. **Sign the AIS TOU** when CISA returns it. Read it — there are
   strict rules about TLP marking inheritance and non-disclosure outside
   your customer base.

3. **Receive credentials** from CISA (typically TAXII 2.1 basic-auth
   creds bound to a collection UUID, sometimes mTLS cert instead — both
   are supported by `lib/cisa.js` if you swap the auth header builder).

4. **Set on Render**:
   - `CISA_TAXII_BASE_URL` — usually `https://ais2.cisa.dhs.gov/taxii2/api2/`
   - `CISA_TAXII_USERNAME`
   - `CISA_TAXII_PASSWORD`
   - `CISA_TAXII_COLLECTION_ID` — the STIX collection UUID

5. **Verify**: hit `POST /api/_smoke/cisa-run` with the smoke token.
   Expected first run: pulls last 24h of indicators (often thousands),
   subsequent runs are incremental via `added_after` cursor stored in
   `ingest_state` table.

## What this gets us

- ~10K–50K cyber IOCs/day (domains, IPs, file hashes) flagged by US
  federal partners, ISACs, and CISA itself
- Indicators stored in `cyber_indicators` table for cross-reference
- Phase 2: cross-reference against URLs/domains in mention bodies →
  if a Reddit post links to a CISA-flagged phishing domain, that mention
  gets its tier bumped + a flag added in the dashboard

## What it does NOT get us

- Physical-threat intelligence (CISA AIS is purely cyber)
- Real-time alerts (typical TAXII poll latency is 30–60 min)
- Anything law-enforcement-only (eGuardian, NCIC, etc. — those require
  sworn-LE status)

## Marketing value

Even before cross-referencing logic ships, "ingests CISA AIS feeds"
is enterprise-sales credibility. Add to the pitch deck once enrolled.
