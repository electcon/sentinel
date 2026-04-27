// Sentinel — entry point.
//
// Boot order:
//   1. require('dotenv').config() if running locally
//   2. Connect Postgres pool
//   3. Run schema init (idempotent ALTER TABLE / CREATE TABLE IF NOT EXISTS)
//   4. Mount HTTP routes (dashboard + admin + alerts webhook)
//   5. app.listen(PORT)
//
// Workers (ingest, digest cron) are SEPARATE processes started via the
// scripts in package.json. Render runs them as cron jobs or separate
// services. The web process never blocks on ingest.

'use strict';

const express = require('express');
const { Pool } = require('pg');
const initSchema = require('./scripts/init-db');

if (!process.env.DATABASE_URL) {
  console.error('[sentinel] FATAL: DATABASE_URL not set');
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5
});

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Health (Render uses this for health checks) ─────────────────────
app.get('/api/health', async (req, res) => {
  let dbOk = false; let dbMs = null;
  try {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    dbMs = Date.now() - t0;
    dbOk = true;
  } catch (e) { /* dbOk stays false */ }
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    timestamp: new Date().toISOString(),
    db: { ok: dbOk, ms: dbMs },
    service: 'sentinel',
    version: require('./package.json').version
  });
});

// ── Smoke: classify (week-1 only, gated by SMOKE_TOKEN env) ─────────
// Will be removed once a real admin auth layer lands in week 5.
// Posts: { text, target?, source? } -> classifier output JSON.
app.post('/api/_smoke/classify', async (req, res) => {
  const tok = req.get('x-smoke-token') || '';
  const expected = process.env.SMOKE_TOKEN || '';
  if (!expected || tok !== expected) return res.status(401).json({ error: 'bad token' });
  try {
    const { classify } = require('./classify');
    const body = (req.body && req.body.text) || '';
    if (!body) return res.status(400).json({ error: 'text required' });
    const out = await classify({
      targetName: req.body.target || 'Test Candidate',
      body,
      source: req.body.source || 'smoke',
      authorHandle: 'smoke-test',
      postedAt: new Date().toISOString()
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stub: dashboard ─────────────────────────────────────────────────
// Replaced in week 5 by the real dashboard. For now, a placeholder so
// the web service has something at `/`.
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta charset=utf-8><title>Sentinel</title>
<style>body{background:#0a0f1a;color:#e6edf3;font-family:Inter,system-ui,sans-serif;padding:60px;max-width:680px;margin:0 auto}
code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px}
h1{margin-bottom:8px}.muted{color:#8b949e}</style></head>
<body><h1>Sentinel</h1>
<p class=muted>Defensive social-media + threat-monitoring platform.
Internal codename. Public-facing UI ships <strong>2026-06-15</strong>.</p>
<p>Health: <code>/api/health</code></p>
<p class=muted>If you reached this URL by accident, you're not in the wrong place — there's
just nothing here yet.</p></body></html>`);
});

// ── Boot ────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 10000;

(async () => {
  try {
    await initSchema(pool);
    console.log('[sentinel] schema init complete');
  } catch (e) {
    console.error('[sentinel] schema init FAILED:', e.message);
    process.exit(2);
  }

  app.listen(PORT, () => {
    console.log(`[sentinel] listening on :${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
})();

module.exports = { app, pool };
