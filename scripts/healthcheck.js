// scripts/healthcheck.js
// Standalone deploy / liveness probe. Hits a battery of public + smoke
// endpoints and reports pass/fail. Returns exit code 0 if all green,
// 1 if any check fails. Suitable for cron, uptime monitor, or manual
// post-deploy gate.
//
// Usage:
//   SENTINEL_BASE_URL=https://sentinel.parallaxadvisory.llc \
//   SMOKE_TOKEN=...  \
//   node scripts/healthcheck.js
//
// Without SMOKE_TOKEN, only the unauthenticated checks run; smoke
// checks are reported as 'skipped' (not failed).

'use strict';

const BASE = process.env.SENTINEL_BASE_URL || 'https://sentinel.parallaxadvisory.llc';
const TOKEN = process.env.SMOKE_TOKEN || '';
const TIMEOUT_MS = 15_000;

// Per-worker max acceptable seconds since last run. Reflects expected
// cadence + a 3-5x grace factor. Workers not listed here use DEFAULT.
const STALE_BUDGET = {
  alert:        5 * 60,           // runs every 1 min
  bluesky:     30 * 60,           // runs every 5 min
  reddit:      30 * 60,           // runs every 10 min
  rss:         60 * 60,           // runs every 15 min
  x:           30 * 60,           // runs every 5 min
  telegram:    60 * 60,           // runs every ~10-15 min
  truthsocial: 60 * 60,           // runs every ~10-15 min
  digest:      90 * 60,           // runs every 30 min
  cleanup:    120 * 60,           // runs every 60 min
  cisa:       180 * 60,           // runs every 60 min
  cost_anomaly: 180 * 60,         // runs every 60 min
  weekly:    8 * 24 * 60 * 60,    // runs once a week (Sunday)
};
const DEFAULT_STALE_SEC = parseInt(process.env.HEALTHCHECK_STALE_WORKER_SEC, 10) || 1800;

// Workers whose absence/staleness is acceptable (env-dormant by design).
const OPTIONAL_WORKERS = new Set([
  process.env.TRUTHSOCIAL_ACCESS_TOKEN ? null : 'truthsocial',
  process.env.CISA_TAXII_USERNAME ? null : 'cisa',
  process.env.FBI_CDE_API_KEY ? null : 'fbi'
].filter(Boolean));

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { name, ok: true, ms: Date.now() - t0, ...result };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: e.message };
  }
}

async function checkApiHealth() {
  const r = await fetchWithTimeout(`${BASE}/api/health`);
  if (!r.ok) throw new Error(`status ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error('json says not ok');
  return { detail: 'ok' };
}

async function checkStatusJson() {
  const r = await fetchWithTimeout(`${BASE}/status.json`);
  if (!r.ok) throw new Error(`status ${r.status}`);
  const j = await r.json();
  if (!j.db?.ok) throw new Error('db not ok');
  const stale = (j.workers || []).filter(w => {
    if (OPTIONAL_WORKERS.has(w.name)) return false;
    if (typeof w.seconds_since !== 'number') return false;
    const budget = STALE_BUDGET[w.name] ?? DEFAULT_STALE_SEC;
    return w.seconds_since > budget;
  });
  if (stale.length) {
    throw new Error('stale workers: ' + stale.map(w => `${w.name}(${w.seconds_since}s vs budget ${STALE_BUDGET[w.name] ?? DEFAULT_STALE_SEC}s)`).join(', '));
  }
  const failed = (j.workers || []).filter(w => w.last_run_ok === false);
  if (failed.length) {
    throw new Error('failed last run: ' + failed.map(w => w.name).join(', '));
  }
  return { detail: `${(j.workers || []).length} workers healthy, db ${j.db.ms}ms` };
}

async function checkApiV1Descriptor() {
  const r = await fetchWithTimeout(`${BASE}/api/v1`);
  if (!r.ok) throw new Error(`status ${r.status}`);
  const j = await r.json();
  if (j.service !== 'sentinel') throw new Error('unexpected service: ' + j.service);
  if (!Array.isArray(j.endpoints) || !j.endpoints.length) throw new Error('no endpoints listed');
  return { detail: `${j.endpoints.length} endpoints listed` };
}

async function smokeCheck(name, path) {
  if (!TOKEN) return { name, ok: null, skipped: true, reason: 'SMOKE_TOKEN not set' };
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'x-smoke-token': TOKEN }
    });
    const ms = Date.now() - t0;
    if (r.status === 404) return { name, ok: null, skipped: true, reason: '404 — likely SMOKE_DISABLED', ms };
    if (!r.ok) return { name, ok: false, error: `status ${r.status}`, ms };
    let body; try { body = await r.json(); } catch (_) { body = {}; }
    return { name, ok: true, ms, detail: JSON.stringify(body).slice(0, 80) };
  } catch (e) {
    return { name, ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

async function main() {
  console.log(`# Sentinel healthcheck — ${BASE}`);
  console.log(`#   ${new Date().toISOString()}`);
  console.log('');

  const results = [];
  results.push(await check('GET  /api/health', checkApiHealth));
  results.push(await check('GET  /status.json', checkStatusJson));
  results.push(await check('GET  /api/v1', checkApiV1Descriptor));
  results.push(await smokeCheck('POST /api/_smoke/reddit-run',  '/api/_smoke/reddit-run'));
  results.push(await smokeCheck('POST /api/_smoke/bluesky-run', '/api/_smoke/bluesky-run'));
  results.push(await smokeCheck('POST /api/_smoke/rss-run',     '/api/_smoke/rss-run'));
  results.push(await smokeCheck('POST /api/_smoke/x-run',       '/api/_smoke/x-run'));
  results.push(await smokeCheck('POST /api/_smoke/telegram-run','/api/_smoke/telegram-run'));

  const padN = Math.max(...results.map(r => r.name.length));
  for (const r of results) {
    const icon = r.skipped ? 'SKIP' : r.ok ? ' OK ' : 'FAIL';
    const line = `[${icon}] ${r.name.padEnd(padN)}  ${String(r.ms || 0).padStart(5)}ms`;
    console.log(line);
    if (r.skipped) console.log(`         ↳ ${r.reason}`);
    else if (r.ok && r.detail) console.log(`         ↳ ${r.detail}`);
    else if (!r.ok) console.log(`         ↳ ERROR: ${r.error}`);
  }

  const failed = results.filter(r => r.ok === false);
  console.log('');
  if (failed.length) {
    console.log(`# ${failed.length} check(s) FAILED`);
    process.exit(1);
  }
  const skipped = results.filter(r => r.skipped).length;
  console.log(`# all green${skipped ? ` (${skipped} skipped — SMOKE_TOKEN unset or smoke disabled)` : ''}`);
}

main().catch(e => { console.error('healthcheck FATAL:', e.message); process.exit(2); });
