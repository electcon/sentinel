// lib/cisa.js
// CISA AIS (Automated Indicator Sharing) TAXII 2.1 client. Pulls STIX
// 2.1 cyber indicators (malicious IPs, domains, file hashes) on a
// schedule. Indicators are persisted to `cyber_indicators` for future
// cross-referencing against URLs / domains in mention bodies.
//
// AUTHENTICATION — DORMANT UNTIL ENROLLMENT COMPLETE
// CISA AIS requires DHS approval. See CISA_AIS_ONBOARDING.md for
// the enrollment steps. Until creds are present, this worker logs
// and exits cleanly.
//
// Env vars (set by David after onboarding):
//   CISA_TAXII_BASE_URL       e.g. https://ais2.cisa.dhs.gov/taxii2/api2/
//   CISA_TAXII_USERNAME       (basic auth) — provided by CISA
//   CISA_TAXII_PASSWORD       (basic auth) — provided by CISA
//   CISA_TAXII_COLLECTION_ID  STIX collection UUID — provided by CISA
//
// TAXII 2.1 spec: https://docs.oasis-open.org/cti/taxii/v2.1/os/taxii-v2.1-os.html

'use strict';

const UA = 'Sentinel/0.1 TAXII client (Parallax Advisory LLC; contact: david@parallaxadvisory.llc)';

function isConfigured() {
  return !!(process.env.CISA_TAXII_BASE_URL
    && process.env.CISA_TAXII_USERNAME
    && process.env.CISA_TAXII_PASSWORD
    && process.env.CISA_TAXII_COLLECTION_ID);
}

function authHeader() {
  const u = process.env.CISA_TAXII_USERNAME;
  const p = process.env.CISA_TAXII_PASSWORD;
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}

function baseUrl() {
  return String(process.env.CISA_TAXII_BASE_URL).replace(/\/+$/, '');
}

// Discovery endpoint — useful smoke test.
async function discover() {
  if (!isConfigured()) throw new Error('CISA_TAXII_* env vars not set');
  const r = await fetch(baseUrl() + '/', {
    headers: { Authorization: authHeader(), Accept: 'application/taxii+json;version=2.1', 'User-Agent': UA }
  });
  if (!r.ok) throw new Error(`taxii discover ${r.status}`);
  return r.json();
}

// Poll a collection for STIX objects added after `addedAfter` ISO time.
// Returns { objects: [...], more: bool, next: cursor }.
async function pollCollection({ addedAfter, limit = 100 } = {}) {
  if (!isConfigured()) throw new Error('CISA_TAXII_* env vars not set');
  const collectionId = process.env.CISA_TAXII_COLLECTION_ID;
  const params = new URLSearchParams({ limit: String(limit) });
  if (addedAfter) params.set('added_after', addedAfter);
  const url = `${baseUrl()}/collections/${collectionId}/objects/?${params.toString()}`;
  const r = await fetch(url, {
    headers: { Authorization: authHeader(), Accept: 'application/taxii+json;version=2.1', 'User-Agent': UA }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`taxii poll ${r.status}: ${body.slice(0, 200)}`);
  }
  const json = await r.json();
  return {
    objects: json.objects || [],
    more: !!json.more,
    next: json.next || null
  };
}

// Extract a normalized indicator record from a STIX 2.1 object.
// We only care about Indicator and Sighting types for v1. Indicator
// patterns look like:  [domain-name:value = 'evil.example.com']
//                       [ipv4-addr:value = '203.0.113.5']
//                       [file:hashes.'SHA-256' = 'abc123...']
function normalizeStixIndicator(obj) {
  if (!obj || obj.type !== 'indicator') return null;
  const pattern = String(obj.pattern || '');
  // Crude pattern parser — pulls out the first bracket-quoted comparison.
  // STIX patterns are technically a real grammar, but for our use case
  // (poll → store → cross-reference) the value extraction is what matters.
  const matches = pattern.match(/\[([\w-]+):([\w.'-]+)\s*=\s*'([^']+)'\]/);
  if (!matches) return null;
  const [, objectType, attrPath, value] = matches;
  let kind;
  if (objectType === 'domain-name') kind = 'domain';
  else if (objectType === 'ipv4-addr') kind = 'ipv4';
  else if (objectType === 'ipv6-addr') kind = 'ipv6';
  else if (objectType === 'url') kind = 'url';
  else if (objectType === 'file' && attrPath.toLowerCase().includes('sha-256')) kind = 'sha256';
  else if (objectType === 'file' && attrPath.toLowerCase().includes('md5')) kind = 'md5';
  else kind = `${objectType}:${attrPath}`;
  return {
    stix_id: obj.id,
    kind,
    value,
    pattern,
    confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
    valid_from: obj.valid_from || null,
    valid_until: obj.valid_until || null,
    labels: obj.labels || [],
    description: obj.description || null
  };
}

module.exports = { isConfigured, discover, pollCollection, normalizeStixIndicator, UA };
