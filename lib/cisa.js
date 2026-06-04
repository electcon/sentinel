// lib/cisa.js
// CISA AIS (Automated Indicator Sharing) TAXII 2.1 client. Pulls STIX
// 2.1 cyber indicators (malicious IPs, domains, file hashes) on a
// schedule. Indicators are persisted to `cyber_indicators` for future
// cross-referencing against URLs / domains in mention bodies.
//
// AUTHENTICATION — DORMANT UNTIL ENROLLMENT COMPLETE
// CISA AIS requires DHS approval + a federally-cross-certified medium-
// assurance PKI client cert (FCPCA or FBCA chain). See
// CISA_AIS_ONBOARDING.pdf for the enrollment steps and
// scripts/generate-cisa-csr.sh for CSR generation. Until creds are
// present, this worker logs and exits cleanly.
//
// Env vars (set by David after onboarding):
//   CISA_TAXII_BASE_URL              e.g. https://ais2.cisa.dhs.gov/taxii2/api2/
//   CISA_TAXII_COLLECTION_ID         STIX collection UUID — provided by CISA
//   CISA_TAXII_CLIENT_CERT_PEM       Client certificate (full PEM), or
//   CISA_TAXII_CLIENT_CERT_PATH      filesystem path to the cert PEM file
//   CISA_TAXII_CLIENT_KEY_PEM        Private key (full PEM, unencrypted), or
//   CISA_TAXII_CLIENT_KEY_PATH       filesystem path to the key PEM file
//   CISA_TAXII_CLIENT_KEY_PASSPHRASE optional, if the key is encrypted
//
// TAXII 2.1 spec: https://docs.oasis-open.org/cti/taxii/v2.1/os/taxii-v2.1-os.html

'use strict';

const fs = require('fs');
const https = require('https');

const UA = 'Sentinel/0.1 TAXII client (Parallax Advisory LLC; contact: david@parallaxadvisory.llc)';

let _httpsAgent = null;

function _readPem(varName) {
  const inline = process.env[varName + '_PEM'];
  if (inline && inline.includes('-----BEGIN')) return inline;
  const path = process.env[varName + '_PATH'];
  if (path) {
    try { return fs.readFileSync(path, 'utf8'); }
    catch (e) { throw new Error(`failed reading ${varName}_PATH: ${e.message}`); }
  }
  return null;
}

function isConfigured() {
  if (!process.env.CISA_TAXII_BASE_URL || !process.env.CISA_TAXII_COLLECTION_ID) return false;
  // Either inline-PEM or file-path env vars must resolve to non-empty strings
  // for both the cert and the private key.
  const certInline = process.env.CISA_TAXII_CLIENT_CERT_PEM;
  const certPath   = process.env.CISA_TAXII_CLIENT_CERT_PATH;
  const keyInline  = process.env.CISA_TAXII_CLIENT_KEY_PEM;
  const keyPath    = process.env.CISA_TAXII_CLIENT_KEY_PATH;
  const hasCert = !!(certInline || certPath);
  const hasKey  = !!(keyInline  || keyPath);
  return hasCert && hasKey;
}

// Build a singleton https.Agent that pins the client cert + key. Created
// lazily so a worker that runs before env vars are populated doesn't fail
// at require-time. Throws clearly if either PEM is missing or unparsable.
function _agent() {
  if (_httpsAgent) return _httpsAgent;
  const cert = _readPem('CISA_TAXII_CLIENT_CERT');
  const key  = _readPem('CISA_TAXII_CLIENT_KEY');
  if (!cert || !key) throw new Error('CISA_TAXII_CLIENT_CERT/KEY not configured');
  _httpsAgent = new https.Agent({
    cert,
    key,
    passphrase: process.env.CISA_TAXII_CLIENT_KEY_PASSPHRASE || undefined,
    keepAlive: true,
    // CISA AIS uses public CAs trusted by Node's default bundle for the
    // *server* cert; only the *client* cert needs to come from the federal
    // PKI hierarchy. Don't disable verification.
    rejectUnauthorized: true
  });
  return _httpsAgent;
}

function baseUrl() {
  return String(process.env.CISA_TAXII_BASE_URL).replace(/\/+$/, '');
}

// Wrapper around fetch() that pins our mTLS Agent. Node's global fetch()
// supports the `dispatcher` option, but we use the older agent option via
// the `https` module-backed fetch path so this works on Node 18+ without
// undici dispatcher dependency. Falls back to the global fetch with no
// agent if the agent fails to build (treated as misconfiguration).
function _fetchMtls(url, opts = {}) {
  const agent = _agent();
  // Node's global fetch (undici) ignores `agent` — use a bespoke https
  // request instead so the Agent's cert/key actually get used.
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: opts.method || 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers: opts.headers || {},
      agent
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => Promise.resolve(body),
          json: () => Promise.resolve(JSON.parse(body))
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Discovery endpoint — useful smoke test.
async function discover() {
  if (!isConfigured()) throw new Error('CISA_TAXII_* env vars not set');
  const r = await _fetchMtls(baseUrl() + '/', {
    headers: { Accept: 'application/taxii+json;version=2.1', 'User-Agent': UA }
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
  const r = await _fetchMtls(url, {
    headers: { Accept: 'application/taxii+json;version=2.1', 'User-Agent': UA }
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
