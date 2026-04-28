// routes/admin.js
// Internal admin view for the Sentinel operator (David). HTTP Basic
// auth gated by ADMIN_PASSWORD env var. If unset, all /admin routes
// 404. No customer auth — this is the operator's omniscient view.

'use strict';

const crypto = require('crypto');
const express = require('express');
const { hashPassword } = require('../lib/auth');
const { sendWelcome } = require('../lib/welcome');
const opAuth = require('../lib/operator-auth');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ago(d) {
  if (!d) return 'never';
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 60_000) return Math.floor(ms / 1000) + 's ago';
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
  return Math.floor(ms / 86_400_000) + 'd ago';
}

function fmtTime(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// Auth is now handled by lib/operator-auth.requireOperator (operator
// session cookie OR bootstrap ADMIN_PASSWORD Basic-auth fallback).
// The legacy basicAuthGate is preserved here for reference but unused.

function adminPage(title, body, operator) {
  const opChip = operator
    ? `<span style="margin-left:auto;color:#8b949e;font-size:12px">${escapeHtml(operator.name || operator.email || 'bootstrap')}${operator.bootstrap ? ' · <em style="color:#d8902f">bootstrap</em>' : ''} · <a href="/admin/logout" style="color:#4f9af0">log out</a></span>`
    : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Sentinel admin</title>
<style>
  *,*::before,*::after { box-sizing: border-box; }
  body { margin:0; font-family: Inter, system-ui, sans-serif; background:#0a0f1a; color:#e6edf3; }
  a { color:#4f9af0; }
  .nav { background:#1a1c30; border-bottom:1px solid #2a2c40; padding:14px 28px; display:flex; align-items:center; gap:24px; }
  .nav .brand { font-weight:600; color:#ffd56b; }
  .container { max-width:1200px; margin:0 auto; padding:32px 28px; }
  h1 { margin:0 0 4px; font-size:22px; }
  h2 { margin:24px 0 8px; font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:#8b949e; }
  table { width:100%; border-collapse:collapse; margin-bottom:18px; }
  th,td { padding:8px 12px; text-align:left; border-bottom:1px solid #1c2330; font-size:13px; }
  th { color:#8b949e; font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  tr:hover { background:#10182a; }
  .pill { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; }
  .ok { background:#1a4a1a; color:#7fff7f; }
  .err { background:#5e0e16; color:#ff7f7f; }
  .muted { color:#8b949e; font-size:12px; }
  .card { background:#0e1422; border:1px solid #1c2330; border-radius:6px; padding:14px; margin-bottom:14px; }
  pre { background:#0a0f1a; border:1px solid #1c2330; border-radius:4px; padding:8px 12px; font-size:12px; max-height:120px; overflow:auto; }
</style>
</head><body>
<div class="nav">
  <div class="brand">SENTINEL · admin</div>
  <a href="/admin">overview</a>
  <a href="/admin/customers">customers</a>
  <a href="/admin/provision">+ provision</a>
  <a href="/admin/workers">workers</a>
  <a href="/admin/errors">errors</a>
  <a href="/admin/threats">threats</a>
  <a href="/admin/classifier-quality">classifier</a>
  <a href="/admin/telegram-channels">telegram</a>
  <a href="/admin/soc" style="background:#5e0e16;color:#fff;padding:3px 10px;border-radius:3px">SOC</a>
  <a href="/admin/leads">leads</a>
  <a href="/admin/audit">audit</a>
  <a href="/admin/operators">operators</a>
  ${opChip}
</div>
<div class="container">
${body}
</div>
</body></html>`;
}

function build(pool) {
  const r = express.Router();

  // Hard 404 if neither ADMIN_PASSWORD bootstrap nor a real operator
  // exists yet — preserves the original "/admin returns 404 unless
  // configured" behavior.
  r.use(async function adminGuard(req, res, next) {
    if (!process.env.ADMIN_PASSWORD) {
      // Check if at least one operator exists; if not, /admin is 404.
      try {
        const c = await pool.query('SELECT 1 FROM operators WHERE active = TRUE LIMIT 1');
        if (!c.rowCount) return res.status(404).send('not found');
      } catch (_) { return res.status(404).send('not found'); }
    }
    next();
  });

  // Operator login — public, no auth required.
  r.get('/admin/login', (req, res) => {
    const next = req.query.next || '/admin';
    const err = req.query.err === '1' ? '<div style="background:#5e0e16;color:#fff;padding:10px;margin-bottom:14px;border-radius:4px;text-align:center">Invalid email or password.</div>' : '';
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Operator login — Sentinel</title>
<style>body{margin:0;background:#0a0f1a;color:#e6edf3;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#0e1422;border:1px solid #1c2330;border-radius:8px;padding:32px;width:100%;max-width:400px}
h1{margin:0 0 24px;font-size:18px;text-align:center;letter-spacing:.06em;color:#ffd56b}
label{display:block;color:#8b949e;font-size:13px;margin-bottom:5px}
input{width:100%;background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px 12px;border-radius:4px;font-size:14px;margin-bottom:14px}
button{width:100%;background:#4f9af0;color:#fff;border:0;padding:11px;border-radius:4px;font-size:14px;font-weight:600;cursor:pointer}
.muted{color:#8b949e;font-size:12px;text-align:center;margin-top:18px}
</style></head><body><div class="card"><h1>SENTINEL · OPERATOR LOGIN</h1>${err}<form method="POST" action="/admin/login">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="email">Email</label><input id="email" name="email" type="email" required autofocus>
<label for="password">Password</label><input id="password" name="password" type="password" required>
<button type="submit">Log in</button></form>
<div class="muted">Operator accounts only. Bootstrap with ADMIN_PASSWORD via Basic auth on first install, then create real operator accounts via <code>scripts/add-operator.js</code>.</div>
</div></body></html>`);
  });

  r.post('/admin/login', express.urlencoded({ extended: false }), async (req, res) => {
    const next = req.body.next || '/admin';
    const op = await opAuth.authenticate(pool, req.body.email, req.body.password || '');
    if (!op) return res.redirect(`/admin/login?err=1&next=${encodeURIComponent(next)}`);
    opAuth.setSessionCookie(res, op.id);
    res.redirect(next.startsWith('/admin') ? next : '/admin');
  });

  r.get('/admin/logout', (req, res) => {
    opAuth.clearSessionCookie(res);
    res.redirect('/admin/login');
  });

  // All subsequent /admin routes require an operator (or bootstrap).
  const gate = opAuth.requireOperator(pool);

  // Best-effort audit-log writer. Failures are silent — audit log is
  // useful but not load-bearing. Pulls operator identity from req.operator
  // (set by lib/operator-auth.requireOperator).
  async function audit(req, action, { targetType = null, targetId = null, details = null } = {}) {
    try {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const op = req.operator || {};
      const actor = op.email || op.name || 'unknown';
      await pool.query(`
        INSERT INTO operator_audit (actor, action, target_type, target_id, details, ip, operator_id)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
      `, [actor, action, targetType, targetId, details ? JSON.stringify(details) : null, ip || null, op.id || null]);
    } catch (e) {
      console.error('[audit] write failed:', e.message);
    }
  }

  // ── /admin overview ───────────────────────────────────────────────
  r.get('/admin', gate, async (req, res) => {
    const [customers, workers, errors24h, threats24h, mentions24h] = await Promise.all([
      pool.query(`
        SELECT c.id, c.name, c.status, c.contact_email, c.alert_email, c.created_at,
               COALESCE(t.n, 0)::int AS target_count,
               COALESCE(m.n, 0)::int AS mention_count_24h,
               COALESCE(m.last, NULL) AS last_mention_at
        FROM customers c
        LEFT JOIN (SELECT customer_id, COUNT(*) AS n FROM targets GROUP BY customer_id) t ON t.customer_id = c.id
        LEFT JOIN (SELECT customer_id, COUNT(*) AS n, MAX(ingested_at) AS last FROM mentions WHERE ingested_at > NOW() - INTERVAL '24 hours' GROUP BY customer_id) m ON m.customer_id = c.id
        ORDER BY c.created_at DESC
      `),
      pool.query(`
        SELECT DISTINCT ON (worker_name) worker_name, started_at, duration_ms, ok, summary, error
        FROM worker_runs ORDER BY worker_name, started_at DESC
      `),
      pool.query(`SELECT COUNT(*)::int AS n FROM worker_runs WHERE NOT ok AND started_at > NOW() - INTERVAL '24 hours'`),
      pool.query(`SELECT COUNT(*)::int AS n FROM threat_events WHERE created_at > NOW() - INTERVAL '24 hours'`),
      pool.query(`SELECT COUNT(*)::int AS n FROM mentions WHERE ingested_at > NOW() - INTERVAL '24 hours'`)
    ]);

    const customerRows = customers.rows.map(c => `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td><span class="pill ok">${escapeHtml(c.status)}</span></td>
        <td>${c.target_count}</td>
        <td>${c.mention_count_24h}</td>
        <td class="muted">${ago(c.last_mention_at)}</td>
        <td class="muted">${escapeHtml(c.alert_email)}</td>
        <td><a href="/admin/customers/${c.id}">open</a></td>
      </tr>
    `).join('');

    const WORKER_INTERVAL_SECONDS = { alert: 60, bluesky: 300, x: 300, reddit: 600, rss: 900, digest: 1800, cleanup: 3600 };
    const isStale = (w) => {
      const expected = WORKER_INTERVAL_SECONDS[w.worker_name];
      if (!expected) return false;
      const ageSec = Math.floor((Date.now() - new Date(w.started_at).getTime()) / 1000);
      return ageSec > expected * 2;
    };
    const staleWorkers = workers.rows.filter(w => isStale(w));
    const workerRows = workers.rows.map(w => {
      const stale = isStale(w);
      const status = !w.ok ? '<span class="pill err">err</span>' : stale ? '<span class="pill" style="background:#3d301a;color:#d8902f">stale</span>' : '<span class="pill ok">ok</span>';
      return `
      <tr>
        <td><strong>${escapeHtml(w.worker_name)}</strong></td>
        <td>${status}</td>
        <td class="muted">${ago(w.started_at)}</td>
        <td class="muted">${w.duration_ms || 0}ms</td>
        <td class="muted">${w.error ? escapeHtml(w.error.slice(0, 80)) : (w.summary ? escapeHtml(JSON.stringify(w.summary).slice(0, 200)) : '—')}</td>
      </tr>
    `;
    }).join('');

    const staleBanner = staleWorkers.length
      ? `<div style="background:#3d301a;border-left:3px solid #d8902f;padding:10px 14px;margin:14px 0;font-size:13px">
           <strong style="color:#d8902f">⚠ Stale workers:</strong> ${staleWorkers.map(w => escapeHtml(w.worker_name)).join(', ')} —
           last run is older than 2× the expected interval. Investigate via the Errors tab or Render logs.
         </div>` : '';
    const smokeOn = process.env.SMOKE_DISABLED !== 'true';
    const smokeBanner = smokeOn
      ? `<div style="background:#3d301a;border-left:3px solid #d8902f;padding:10px 14px;margin:14px 0;font-size:13px">
           <strong style="color:#d8902f">⚠ Smoke endpoints enabled.</strong> /api/_smoke/* is reachable with the dev token.
           Once you have real customers in production, set <code>SMOKE_DISABLED=true</code> on Render to lock these down.
         </div>`
      : `<div style="background:#1a4a1a;border-left:3px solid #3a9c3a;padding:10px 14px;margin:14px 0;font-size:13px">
           <strong style="color:#7fff7f">✓ Smoke endpoints disabled</strong> (SMOKE_DISABLED=true). All /api/_smoke/* routes return 404.
         </div>`;
    const body = `
      <h1>Sentinel — admin overview</h1>
      <div class="muted">${customers.rowCount} customer${customers.rowCount === 1 ? '' : 's'} · ${mentions24h.rows[0].n} mentions · ${threats24h.rows[0].n} threat events · ${errors24h.rows[0].n} worker errors (24h)</div>
      ${staleBanner}
      ${smokeBanner}

      <h2>Customers</h2>
      ${customers.rowCount ? `<table>
        <thead><tr><th>Name</th><th>Status</th><th>Targets</th><th>24h mentions</th><th>Last mention</th><th>Alert email</th><th></th></tr></thead>
        <tbody>${customerRows}</tbody>
      </table>` : '<div class="muted">No customers yet.</div>'}

      <h2>Workers</h2>
      <table>
        <thead><tr><th>Worker</th><th>Status</th><th>Last run</th><th>Duration</th><th>Summary / error</th></tr></thead>
        <tbody>${workerRows}</tbody>
      </table>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('overview', body, req.operator));
  });

  // ── /admin/customers ──────────────────────────────────────────────
  r.get('/admin/customers', gate, async (req, res) => {
    const flash = req.query.ok ? `<div style="background:#1a4a1a;color:#7fff7f;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.ok)}</div>` : '';
    const r2 = await pool.query(`
      SELECT c.*, COALESCE(t.n, 0)::int AS target_count,
             COALESCE(m.n, 0)::int AS mention_count
      FROM customers c
      LEFT JOIN (SELECT customer_id, COUNT(*) AS n FROM targets GROUP BY customer_id) t ON t.customer_id = c.id
      LEFT JOIN (SELECT customer_id, COUNT(*) AS n FROM mentions GROUP BY customer_id) m ON m.customer_id = c.id
      ORDER BY c.created_at DESC
    `);
    const rows = r2.rows.map(c => {
      const inactive = !c.last_login_at || (Date.now() - new Date(c.last_login_at).getTime() > 30 * 86400 * 1000);
      const loginCell = c.last_login_at
        ? `${ago(c.last_login_at)}${inactive ? ' <span class="pill" style="background:#3d301a;color:#d8902f">inactive</span>' : ''}<div class="muted" style="font-size:11px">${c.login_count || 0} logins</div>`
        : '<span class="pill" style="background:#5e0e16;color:#ff7f7f">never</span>';
      return `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong><div class="muted">${escapeHtml(c.id)}</div></td>
        <td><span class="pill ok">${escapeHtml(c.status)}</span></td>
        <td>${c.target_count}</td>
        <td>${c.mention_count}</td>
        <td class="muted">${escapeHtml(c.contact_email)}</td>
        <td class="muted">${escapeHtml(c.alert_email)}</td>
        <td>${loginCell}</td>
        <td class="muted">${fmtTime(c.created_at)}</td>
        <td>${c.password_hash ? '<span class="pill ok">set</span>' : '<span class="pill err">no pw</span>'}</td>
        <td><a href="/admin/customers/${c.id}">open</a></td>
      </tr>
    `;
    }).join('');
    const body = `
      <h1>Customers</h1>
      ${flash}
      <div style="margin:14px 0"><a href="/admin/provision"><button style="background:#4f9af0;color:#fff;border:0;padding:8px 14px;border-radius:4px;cursor:pointer;font-size:13px">+ Provision new customer</button></a></div>
      <table>
        <thead><tr><th>Name / ID</th><th>Status</th><th>Targets</th><th>Mentions</th><th>Contact</th><th>Alert</th><th>Last login</th><th>Created</th><th>PW</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('customers', body, req.operator));
  });

  // Per-customer detail (read-only): targets, recent mentions
  r.get('/admin/customers/:id', gate, async (req, res) => {
    const c = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    if (!c.rowCount) return res.status(404).send('not found');
    const cust = c.rows[0];

    const [targets, recent] = await Promise.all([
      pool.query('SELECT id, kind, name, aliases, search_terms FROM targets WHERE customer_id = $1 ORDER BY name', [req.params.id]),
      pool.query(`
        SELECT m.id, m.threat_tier, m.source, m.source_url, m.posted_at, m.body_excerpt, t.name AS target_name
        FROM mentions m LEFT JOIN targets t ON t.id = m.target_id
        WHERE m.customer_id = $1 ORDER BY m.ingested_at DESC LIMIT 25
      `, [req.params.id])
    ]);

    const targetRows = targets.rows.map(t => `<tr><td>${escapeHtml(t.kind)}</td><td>${escapeHtml(t.name)}</td><td class="muted">${escapeHtml((t.aliases || []).join(', '))}</td><td class="muted">${escapeHtml((t.search_terms || []).join(', '))}</td></tr>`).join('');
    const mentionRows = recent.rows.map(m => `<tr><td>T${m.threat_tier || '—'}</td><td>${escapeHtml(m.target_name || '—')}</td><td>${escapeHtml(m.source)}</td><td>${escapeHtml((m.body_excerpt || '').slice(0, 120))}</td><td class="muted">${ago(m.posted_at)}</td></tr>`).join('');

    const flash = req.query.ok ? `<div style="background:#1a4a1a;color:#7fff7f;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.ok)}</div>` : '';

    // Geographic risk panel — best-effort lookup; hides on failure.
    let riskPanel = '';
    if (cust.state) {
      try {
        const { riskSummaryForState } = require('../lib/fbi-cde');
        const r2 = await riskSummaryForState(cust.state);
        if (r2 && !r2.error) {
          riskPanel = `<div class="card" style="margin-top:14px;background:#101a26;border:1px solid #1c2330">
            <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Geographic context — FBI CDE</div>
            <div style="font-size:20px;font-weight:600">${r2.total_incidents} hate-crime incidents</div>
            <div class="muted" style="margin-top:4px">${escapeHtml(cust.state)} · ${escapeHtml(r2.year_range)} · refresh: ${escapeHtml(r2.last_refresh || '—')}</div>
            <div style="margin-top:10px;display:grid;grid-template-columns:repeat(2,1fr);gap:6px;font-size:13px">
              <div><span class="muted">vs individuals:</span> ${r2.against_individuals}</div>
              <div><span class="muted">vs government:</span> ${r2.against_government}</div>
              <div><span class="muted">vs religious org:</span> ${r2.against_religious_org}</div>
              <div><span class="muted">vs LE officers:</span> ${r2.against_law_enforcement}</div>
            </div>
            ${r2.top_offense ? `<div class="muted" style="margin-top:8px;font-size:12px">Top offense: <strong>${escapeHtml(r2.top_offense.name)}</strong> (${r2.top_offense.count})</div>` : ''}
          </div>`;
        } else if (r2 && r2.error) {
          riskPanel = `<div class="card" style="margin-top:14px"><div class="muted">Geographic risk lookup failed: ${escapeHtml(r2.error)}</div></div>`;
        }
      } catch (e) {
        riskPanel = `<div class="card" style="margin-top:14px"><div class="muted">Geographic risk lookup unavailable: ${escapeHtml(e.message)}</div></div>`;
      }
    }

    const body = `
      <a href="/admin/customers" class="muted">← all customers</a>
      <h1 style="margin-top:14px">${escapeHtml(cust.name)}</h1>
      <div class="muted">${escapeHtml(cust.id)}</div>
      ${flash}
      <div class="card" style="margin-top:14px">
        <div class="muted">contact: ${escapeHtml(cust.contact_email)}</div>
        <div class="muted">alert: ${escapeHtml(cust.alert_email)}</div>
        <div class="muted">digest: ${escapeHtml(cust.digest_email)}</div>
        <div class="muted">state: ${cust.state ? escapeHtml(cust.state) : '<em>not set</em>'} · status: ${escapeHtml(cust.status)} · created: ${fmtTime(cust.created_at)} · last digest: ${fmtTime(cust.last_digest_at)}</div>
        <div class="muted">last login: ${cust.last_login_at ? `${ago(cust.last_login_at)} (${fmtTime(cust.last_login_at)})` : '<em>never</em>'} · ${cust.login_count || 0} logins total</div>
      </div>
      ${riskPanel}
      <h2>Targets (${targets.rowCount})</h2>
      ${targets.rowCount ? `<table><thead><tr><th>Kind</th><th>Name</th><th>Aliases</th><th>Search terms</th></tr></thead><tbody>${targetRows}</tbody></table>` : '<div class="muted">No targets.</div>'}
      <h2>Recent mentions (${recent.rowCount})</h2>
      ${recent.rowCount ? `<table><thead><tr><th>Tier</th><th>Target</th><th>Source</th><th>Excerpt</th><th>Posted</th></tr></thead><tbody>${mentionRows}</tbody></table>` : '<div class="muted">No mentions.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('customer', body, req.operator));
  });

  // ── /admin/workers ────────────────────────────────────────────────
  r.get('/admin/workers', gate, async (req, res) => {
    const recent = await pool.query(`
      SELECT worker_name, started_at, duration_ms, ok, summary, error
      FROM worker_runs ORDER BY started_at DESC LIMIT 200
    `);
    const rows = recent.rows.map(w => `
      <tr>
        <td>${escapeHtml(w.worker_name)}</td>
        <td><span class="pill ${w.ok ? 'ok' : 'err'}">${w.ok ? 'ok' : 'err'}</span></td>
        <td class="muted">${ago(w.started_at)}</td>
        <td class="muted">${w.duration_ms || 0}ms</td>
        <td class="muted" style="max-width:600px;overflow:hidden;text-overflow:ellipsis">${w.error ? escapeHtml(w.error.slice(0, 200)) : (w.summary ? escapeHtml(JSON.stringify(w.summary).slice(0, 300)) : '—')}</td>
      </tr>
    `).join('');
    const body = `<h1>Worker runs (last 200)</h1>
      <table><thead><tr><th>Worker</th><th>Status</th><th>Started</th><th>Duration</th><th>Summary / error</th></tr></thead><tbody>${rows}</tbody></table>`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('workers', body, req.operator));
  });

  // ── /admin/errors ─────────────────────────────────────────────────
  r.get('/admin/errors', gate, async (req, res) => {
    const q = await pool.query(`
      SELECT worker_name, started_at, duration_ms, error
      FROM worker_runs WHERE NOT ok ORDER BY started_at DESC LIMIT 100
    `);
    const rows = q.rows.map(w => `
      <tr>
        <td>${escapeHtml(w.worker_name)}</td>
        <td class="muted">${ago(w.started_at)}</td>
        <td class="muted">${w.duration_ms}ms</td>
        <td><pre>${escapeHtml(w.error || '')}</pre></td>
      </tr>
    `).join('');
    const body = `<h1>Worker errors (last 100)</h1>
      ${q.rowCount ? `<table><thead><tr><th>Worker</th><th>When</th><th>Duration</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted">No errors logged.</div>'}`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('errors', body, req.operator));
  });

  // ── /admin/provision (create or update customer via web form) ────
  r.get('/admin/provision', gate, async (req, res) => {
    const flash = req.query.ok ? `<div style="background:#1a4a1a;color:#7fff7f;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.ok)}</div>` : '';
    const err = req.query.err ? `<div style="background:#5e0e16;color:#fff;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.err)}</div>` : '';
    // Prefill from lead conversion (?lead_id=...&name=...&...). If lead_id
    // is present we also surface the lead's message in the targets help.
    const prefill = {
      name: req.query.name || '',
      contact_email: req.query.contact_email || '',
      alert_email: req.query.alert_email || req.query.contact_email || '',
      digest_email: req.query.digest_email || req.query.contact_email || '',
      state: (req.query.state || '').toString().toUpperCase().slice(0, 2),
      lead_id: req.query.lead_id || ''
    };
    let leadBanner = '';
    if (prefill.lead_id) {
      try {
        const l = await pool.query('SELECT message, role, contact_name FROM beta_leads WHERE id = $1', [prefill.lead_id]);
        if (l.rowCount) {
          const r2 = l.rows[0];
          leadBanner = `<div style="background:#1a3a5c;border:1px solid #2a5a8c;padding:12px 14px;border-radius:6px;margin-bottom:14px;font-size:13px">
            <strong style="color:#cfe5ff">Converting lead</strong>${r2.contact_name ? ` from ${escapeHtml(r2.contact_name)}` : ''}${r2.role ? ` (${escapeHtml(r2.role)})` : ''}.
            ${r2.message ? `<div style="margin-top:6px;color:#cdd5e0">"${escapeHtml(r2.message.slice(0, 400))}"</div>` : ''}
          </div>`;
        }
      } catch (_) {}
    }
    const body = `
      <a href="/admin" style="color:#8b949e;font-size:13px">← admin overview</a>
      <h1 style="margin-top:14px">Provision customer</h1>
      <p style="color:#8b949e;font-size:13px">Idempotent: if a customer with the same name exists, this updates it (preserves mentions/threats).</p>
      ${flash}${err}
      ${leadBanner}
      <form method="POST" action="/admin/provision">
        ${prefill.lead_id ? `<input type="hidden" name="lead_id" value="${escapeHtml(prefill.lead_id)}">` : ''}
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Customer name (e.g., "Jolly for Governor")</label>
          <input type="text" name="name" value="${escapeHtml(prefill.name)}" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Contact email (used for login)</label>
          <input type="email" name="contact_email" value="${escapeHtml(prefill.contact_email)}" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Alert email (tier 3+ real-time)</label>
          <input type="email" name="alert_email" value="${escapeHtml(prefill.alert_email)}" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Digest email (daily summary)</label>
          <input type="email" name="digest_email" value="${escapeHtml(prefill.digest_email)}" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Password (≥ 8 chars; tell customer to change on first login)</label>
          <input type="text" name="password" required minlength="8" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px;font-family:monospace">
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Status</label>
          <select name="status" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
            <option value="beta">beta</option>
            <option value="active">active</option>
            <option value="paused">paused</option>
          </select>
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Candidate's state (2-letter postal abbrev, optional)</label>
          <input type="text" name="state" maxlength="2" value="${escapeHtml(prefill.state)}" placeholder="NH" pattern="[A-Za-z]{2}" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px;text-transform:uppercase">
          <div style="color:#8b949e;font-size:12px;margin-top:4px">Used for hate-crime risk lookup via FBI CDE.</div>
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Targets — one per line OR JSON array</label>
          <textarea name="targets" rows="10" placeholder='Either:&#10;Cinde Warmington&#10;Tom Sherman (her partner)&#10;&#10;Or:&#10;[&#10;  {"kind":"candidate","name":"Cinde Warmington","aliases":["Warmington"],"search_terms":["Cinde Warmington"]},&#10;  {"kind":"family","name":"Tom Sherman"}&#10;]' style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:13px;font-family:monospace"></textarea>
        </div>
        <div style="margin-bottom:14px;background:#0e1422;padding:10px;border-radius:4px">
          <label style="display:flex;align-items:center;gap:8px;color:#e6edf3;font-size:13px;cursor:pointer">
            <input type="checkbox" name="send_welcome" value="1" checked style="width:auto;display:inline-block;margin:0">
            Send welcome email to contact_email with login URL + password
          </label>
          <div style="color:#8b949e;font-size:12px;margin-top:4px">Skip if you'll deliver credentials via secure channel manually.</div>
        </div>
        <button type="submit" style="background:#4f9af0;color:#fff;border:0;padding:10px 20px;border-radius:4px;font-size:14px;cursor:pointer">Provision</button>
      </form>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('Provision customer', body, req.operator));
  });

  r.post('/admin/provision', gate, express.urlencoded({ extended: false, limit: '256kb' }), async (req, res) => {
    try {
      const { name, contact_email, alert_email, digest_email, password, status } = req.body;
      if (!name || !contact_email || !alert_email || !digest_email || !password) {
        return res.redirect('/admin/provision?err=' + encodeURIComponent('All fields required'));
      }
      if (password.length < 8) {
        return res.redirect('/admin/provision?err=' + encodeURIComponent('Password must be ≥ 8 chars'));
      }
      const useStatus = ['beta', 'active', 'paused'].includes(status) ? status : 'beta';
      const rawState = String(req.body.state || '').toUpperCase().trim();
      const useState = /^[A-Z]{2}$/.test(rawState) ? rawState : null;

      // Parse targets: JSON array or one-name-per-line.
      const targetsText = String(req.body.targets || '').trim();
      let targets = [];
      if (targetsText.startsWith('[') || targetsText.startsWith('{')) {
        try {
          const parsed = JSON.parse(targetsText);
          targets = (Array.isArray(parsed) ? parsed : [parsed]).filter(t => t && t.name);
        } catch (e) {
          return res.redirect('/admin/provision?err=' + encodeURIComponent('Invalid JSON: ' + e.message.slice(0, 80)));
        }
      } else if (targetsText) {
        targets = targetsText.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(name => ({ kind: 'candidate', name, aliases: [], search_terms: [name] }));
      }
      if (!targets.length) {
        return res.redirect('/admin/provision?err=' + encodeURIComponent('At least one target required'));
      }

      // Ensure schema (idempotent in case the column was added recently).
      await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS targets_customer_name ON targets (customer_id, name)`);

      const passwordHash = await hashPassword(password);

      const existing = await pool.query('SELECT id FROM customers WHERE name = $1 LIMIT 1', [name]);
      let customerId;
      if (existing.rowCount > 0) {
        customerId = existing.rows[0].id;
        await pool.query(`UPDATE customers SET contact_email=$2, alert_email=$3, digest_email=$4, status=$5, password_hash=$6, state=$7 WHERE id=$1`,
          [customerId, contact_email, alert_email, digest_email, useStatus, passwordHash, useState]);
      } else {
        const ins = await pool.query(`INSERT INTO customers (name, contact_email, alert_email, digest_email, status, password_hash, state) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [name, contact_email, alert_email, digest_email, useStatus, passwordHash, useState]);
        customerId = ins.rows[0].id;
      }
      let created = 0, updated = 0;
      for (const t of targets) {
        const kindRaw = String(t.kind || 'candidate').trim();
        const kind = ['candidate', 'family', 'staff', 'surrogate'].includes(kindRaw) ? kindRaw : 'candidate';
        const aliases = Array.isArray(t.aliases) ? t.aliases : [];
        const searchTerms = Array.isArray(t.search_terms) ? t.search_terms : [t.name];
        const r2 = await pool.query(`
          INSERT INTO targets (customer_id, kind, name, aliases, search_terms)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
          ON CONFLICT (customer_id, name) DO UPDATE
          SET kind = EXCLUDED.kind, aliases = EXCLUDED.aliases, search_terms = EXCLUDED.search_terms
          RETURNING (xmax = 0) AS inserted
        `, [customerId, kind, t.name, JSON.stringify(aliases), JSON.stringify(searchTerms)]);
        if (r2.rows[0].inserted) created++; else updated++;
      }
      // Optionally fire welcome email.
      let welcomeNote = '';
      if (req.body.send_welcome === '1' && existing.rowCount === 0) {
        const loginUrl = (process.env.DASHBOARD_BASE_URL || 'https://sentinel.parallaxadvisory.llc') + '/login';
        const out = await sendWelcome({
          to: contact_email,
          customerName: name,
          password,
          loginUrl,
          alertEmail: alert_email,
          digestEmail: digest_email,
          targets: targets.map(t => ({ name: t.name, kind: t.kind || 'candidate' }))
        });
        if (out.ok) {
          welcomeNote = out.dryRun ? ' Welcome email dry-run logged (no RESEND_API_KEY).' : ` Welcome email sent to ${contact_email}.`;
        } else {
          welcomeNote = ` Welcome email FAILED: ${out.error?.slice(0, 100)}.`;
        }
      } else if (req.body.send_welcome === '1' && existing.rowCount > 0) {
        welcomeNote = ' (Welcome email skipped — customer existed; only re-send via CLI to avoid resend on every update.)';
      }

      // If this provision came from a lead conversion, link it.
      let leadNote = '';
      if (req.body.lead_id) {
        try {
          await pool.query(`
            UPDATE beta_leads
            SET status = 'converted',
                provisioned_customer_id = $2,
                contacted_at = COALESCE(contacted_at, NOW())
            WHERE id = $1
          `, [req.body.lead_id, customerId]);
          leadNote = ' Lead marked as converted.';
        } catch (_) {}
      }

      await audit(req, existing.rowCount > 0 ? 'update' : 'provision', {
        targetType: 'customer',
        targetId: customerId,
        details: { name, contact_email, alert_email, digest_email, status: useStatus, state: useState, targets_added: created, targets_updated: updated, welcome_emailed: req.body.send_welcome === '1' && existing.rowCount === 0, from_lead: req.body.lead_id || null }
      });
      const note = `${existing.rowCount > 0 ? 'updated' : 'created'} customer; ${created} new + ${updated} updated targets.${welcomeNote}${leadNote}`;
      res.redirect(`/admin/customers/${customerId}?ok=` + encodeURIComponent(note));
    } catch (e) {
      res.redirect('/admin/provision?err=' + encodeURIComponent(e.message.slice(0, 200)));
    }
  });

  // ── /admin/classifier-quality ─────────────────────────────────────
  // Drift dashboard: shows reviewer-action distribution per source +
  // per original-tier, with dismissal-rate callouts when classifier
  // appears to be over-calling. Last 30 days.
  r.get('/admin/classifier-quality', gate, async (req, res) => {
    const [bySource, byTier, recent, totals] = await Promise.all([
      pool.query(`
        SELECT source, reviewer_action, COUNT(*)::int AS n
        FROM classifier_feedback
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1, 2
        ORDER BY 1, 2
      `),
      pool.query(`
        SELECT original_tier, reviewer_action, COUNT(*)::int AS n
        FROM classifier_feedback
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1, 2
        ORDER BY 1, 2
      `),
      pool.query(`
        SELECT cf.created_at, cf.original_tier, cf.original_confidence, cf.reviewer_action,
               cf.reviewer_actor, cf.reviewer_note, cf.source, m.body_excerpt, c.name AS customer_name
        FROM classifier_feedback cf
        JOIN mentions m ON m.id = cf.mention_id
        JOIN customers c ON c.id = cf.customer_id
        ORDER BY cf.created_at DESC
        LIMIT 30
      `),
      pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE reviewer_action = 'dismissed')::int AS dismissed,
               COUNT(*) FILTER (WHERE reviewer_action = 'escalated')::int AS escalated,
               COUNT(*) FILTER (WHERE reviewer_action = 'ongoing_campaign')::int AS ongoing,
               COUNT(*) FILTER (WHERE reviewer_action IN ('reported_platform','reported_law_enf'))::int AS reported,
               COUNT(*) FILTER (WHERE reviewer_action = 'monitoring')::int AS monitoring
        FROM classifier_feedback
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `)
    ]);

    // Build per-source pivot: for each source, count by action.
    const sourcePivot = {};
    for (const r2 of bySource.rows) {
      if (!sourcePivot[r2.source]) sourcePivot[r2.source] = { dismissed: 0, escalated: 0, ongoing_campaign: 0, reviewing: 0, reported_platform: 0, reported_law_enf: 0, monitoring: 0, total: 0 };
      sourcePivot[r2.source][r2.reviewer_action] = r2.n;
      sourcePivot[r2.source].total += r2.n;
    }
    const sourceRows = Object.entries(sourcePivot).map(([source, p]) => {
      const dismissalRate = p.total > 0 ? Math.round((p.dismissed / p.total) * 100) : 0;
      const drift = dismissalRate >= 60;
      return `<tr>
        <td><strong>${escapeHtml(source)}</strong></td>
        <td>${p.total}</td>
        <td>${p.dismissed}</td>
        <td>${p.escalated || 0}</td>
        <td>${p.ongoing_campaign || 0}</td>
        <td>${(p.reported_platform || 0) + (p.reported_law_enf || 0)}</td>
        <td>${p.monitoring || 0}</td>
        <td><span class="pill ${drift ? 'err' : 'ok'}">${dismissalRate}%</span></td>
      </tr>`;
    }).join('');

    // Tier pivot: original_tier × reviewer_action.
    const tierPivot = {};
    for (const r2 of byTier.rows) {
      const t = r2.original_tier || 0;
      if (!tierPivot[t]) tierPivot[t] = { dismissed: 0, escalated: 0, ongoing_campaign: 0, reviewing: 0, reported_platform: 0, reported_law_enf: 0, monitoring: 0, total: 0 };
      tierPivot[t][r2.reviewer_action] = r2.n;
      tierPivot[t].total += r2.n;
    }
    const tierRows = Object.entries(tierPivot).sort(([a], [b]) => Number(b) - Number(a)).map(([tier, p]) => {
      const dismissalRate = p.total > 0 ? Math.round((p.dismissed / p.total) * 100) : 0;
      return `<tr>
        <td><strong>Tier ${tier}</strong></td>
        <td>${p.total}</td>
        <td>${p.dismissed}</td>
        <td>${p.escalated || 0}</td>
        <td>${p.ongoing_campaign || 0}</td>
        <td>${(p.reported_platform || 0) + (p.reported_law_enf || 0)}</td>
        <td>${dismissalRate}%</td>
      </tr>`;
    }).join('');

    const t = totals.rows[0];
    const totalDismissalRate = t.total > 0 ? Math.round((t.dismissed / t.total) * 100) : 0;
    const drift = totalDismissalRate >= 60 && t.total >= 10;

    const recentRows = recent.rows.map(r2 => `
      <tr>
        <td class="muted">${ago(r2.created_at)}</td>
        <td>T${r2.original_tier ?? '—'}${r2.original_confidence != null ? ` (${Number(r2.original_confidence).toFixed(2)})` : ''}</td>
        <td>${escapeHtml(r2.source || '—')}</td>
        <td><span class="pill ${r2.reviewer_action === 'dismissed' ? 'err' : 'ok'}">${escapeHtml(r2.reviewer_action)}</span></td>
        <td>${escapeHtml(r2.customer_name)}</td>
        <td class="muted" style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escapeHtml((r2.body_excerpt || '').slice(0, 120))}</td>
        <td class="muted">${escapeHtml((r2.reviewer_note || '').slice(0, 80))}</td>
      </tr>
    `).join('');

    const driftBanner = drift
      ? `<div style="background:#3d301a;border-left:3px solid #d8902f;padding:10px 14px;margin:14px 0;font-size:13px">
           <strong style="color:#d8902f">⚠ Drift watch:</strong> overall dismissal rate is ${totalDismissalRate}% over ${t.total} reviews (last 30d).
           Classifier may be over-calling — consider tightening rubric examples for the high-dismissal source(s) below.
         </div>` : '';

    const body = `
      <h1>Classifier quality</h1>
      <div class="muted">Reviewer dispositions captured as ground-truth feedback. Last 30 days.</div>
      ${driftBanner}

      <div class="row" style="display:flex;gap:18px;margin:18px 0;flex-wrap:wrap">
        <div class="card" style="flex:1 1 140px;min-width:120px"><div class="muted">Total reviews</div><div style="font-size:28px;font-weight:600">${t.total}</div></div>
        <div class="card" style="flex:1 1 140px;min-width:120px"><div class="muted">Dismissed</div><div style="font-size:28px;font-weight:600">${t.dismissed}</div></div>
        <div class="card" style="flex:1 1 140px;min-width:120px"><div class="muted">Escalated</div><div style="font-size:28px;font-weight:600">${t.escalated}</div></div>
        <div class="card" style="flex:1 1 140px;min-width:120px"><div class="muted">Reported</div><div style="font-size:28px;font-weight:600">${t.reported}</div></div>
        <div class="card" style="flex:1 1 140px;min-width:120px"><div class="muted">Dismissal rate</div><div style="font-size:28px;font-weight:600">${totalDismissalRate}%</div></div>
      </div>

      <h2>By source</h2>
      ${sourceRows ? `<table>
        <thead><tr><th>Source</th><th>Total</th><th>Dismissed</th><th>Escalated</th><th>Ongoing</th><th>Reported</th><th>Monitoring</th><th>Dismissal %</th></tr></thead>
        <tbody>${sourceRows}</tbody>
      </table>` : '<div class="muted">No feedback yet.</div>'}

      <h2>By original tier</h2>
      ${tierRows ? `<table>
        <thead><tr><th>Tier</th><th>Total</th><th>Dismissed</th><th>Escalated</th><th>Ongoing</th><th>Reported</th><th>Dismissal %</th></tr></thead>
        <tbody>${tierRows}</tbody>
      </table>` : '<div class="muted">No feedback yet.</div>'}

      <h2>Recent decisions</h2>
      ${recentRows ? `<table>
        <thead><tr><th>When</th><th>Original</th><th>Source</th><th>Action</th><th>Customer</th><th>Excerpt</th><th>Note</th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>` : '<div class="muted">No feedback yet.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('classifier quality', body, req.operator));
  });

  // ── /admin/telegram-channels ──────────────────────────────────────
  // Operator-curated list of Telegram channels the worker should
  // monitor. Shared across all customers. Add via paste-form (one
  // channel-id per line OR JSON array).
  r.get('/admin/telegram-channels', gate, async (req, res) => {
    const q = await pool.query(`
      SELECT id, channel_id, category, label, notes, citation, est_subscribers,
             active, last_run_at, last_post_count, last_error,
             consecutive_empty_runs, auto_paused_at, auto_paused_reason,
             created_at
      FROM monitored_channels
      WHERE source = 'telegram'
      ORDER BY active DESC, auto_paused_at DESC NULLS LAST, channel_id ASC
    `);
    const flash = req.query.ok ? `<div style="background:#1a4a1a;color:#7fff7f;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.ok)}</div>` : '';
    const errFlash = req.query.err ? `<div style="background:#5e0e16;color:#fff;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.err)}</div>` : '';
    const rows = q.rows.map(c => {
      const isAutoPaused = !c.active && !!c.auto_paused_at;
      const status = c.active
        ? '<span class="pill ok">active</span>'
        : isAutoPaused
          ? `<span class="pill" style="background:#5e0e16;color:#ff7f7f">auto-paused</span><div class="muted" style="font-size:10px;margin-top:2px">${escapeHtml(c.auto_paused_reason || 'stale')} · ${ago(c.auto_paused_at)}</div>`
          : '<span class="pill" style="background:#3d301a;color:#d8902f">paused</span>';
      const lastRun = c.last_run_at ? `${ago(c.last_run_at)} · ${c.last_post_count || 0} posts` : 'never';
      const consecutive = (c.consecutive_empty_runs || 0) > 0 && c.active ? `<div class="muted" style="font-size:10px;color:#d8902f;margin-top:2px">${c.consecutive_empty_runs} empty in a row</div>` : '';
      const errLine = c.last_error ? `<div class="muted" style="color:#ff7080;font-size:11px;margin-top:4px">⚠ ${escapeHtml(c.last_error.slice(0, 150))}</div>` : '';
      return `<tr>
        <td><strong>${escapeHtml(c.channel_id)}</strong>${c.label ? `<div class="muted" style="font-size:11px">${escapeHtml(c.label)}</div>` : ''}${consecutive}${errLine}</td>
        <td>${c.category ? `<span class="status-pill">${escapeHtml(c.category)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${status}</td>
        <td class="muted">${lastRun}</td>
        <td class="muted" style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.notes || '—')}</td>
        <td>${c.citation ? `<a href="${escapeHtml(c.citation)}" target="_blank" rel="noopener" style="font-size:11px">cite</a>` : '<span class="muted">—</span>'}</td>
        <td><a href="https://t.me/s/${escapeHtml(c.channel_id)}" target="_blank" rel="noopener" style="font-size:11px">preview</a></td>
        <td>
          <form method="POST" action="/admin/telegram-channels/${c.id}/toggle"><button type="submit" class="${c.active ? '' : 'ok'}" style="background:#1c2330;color:#e6edf3;border:0;padding:4px 8px;border-radius:3px;cursor:pointer;font-size:11px">${c.active ? 'pause' : 'resume'}</button></form>
          <form method="POST" action="/admin/telegram-channels/${c.id}/delete" onsubmit="return confirm('Delete ${escapeHtml(c.channel_id)}?');" style="display:inline"><button type="submit" style="background:#5e0e16;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer;font-size:11px;margin-left:4px">×</button></form>
        </td>
      </tr>`;
    }).join('');

    const body = `
      <h1>Telegram channels</h1>
      <div class="muted">Operator-curated seed list. Worker fetches each active channel every 10 min and cross-products against all customers' targets.</div>
      ${flash}${errFlash}
      <h2>Active list (${q.rows.filter(r => r.active).length} of ${q.rowCount})</h2>
      ${q.rowCount ? `<table>
        <thead><tr><th>Channel</th><th>Category</th><th>Status</th><th>Last run</th><th>Notes</th><th>Source</th><th>Preview</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="muted">No channels yet. Add some below.</div>'}

      <h2>Add channels</h2>
      <p class="muted">Paste a JSON array (full schema) OR one channel per line (e.g. <code>realstewpeters</code>) — without the @ prefix.</p>
      <form method="POST" action="/admin/telegram-channels/bulk-add">
        <textarea name="bulk" rows="12" placeholder='Either, one per line:&#10;realstewpeters&#10;realalexjones&#10;&#10;Or JSON:&#10;[&#10;  {"channel_id":"realstewpeters","category":"general-far-right","label":"Stew Peters Network","notes":"Steady volume of MAGA-aligned hostile rhetoric","citation":"https://...","est_subscribers":100000},&#10;  {"channel_id":"realalexjones"}&#10;]' style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-family:monospace;font-size:13px"></textarea>
        <button type="submit" style="background:#4f9af0;color:#fff;border:0;padding:8px 14px;border-radius:4px;cursor:pointer;margin-top:10px">Add</button>
      </form>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('Telegram channels', body, req.operator));
  });

  r.post('/admin/telegram-channels/bulk-add', gate, express.urlencoded({ extended: false, limit: '256kb' }), async (req, res) => {
    const text = String(req.body.bulk || '').trim();
    if (!text) return res.redirect('/admin/telegram-channels?err=No+input');
    let entries = [];
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        entries = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {
        return res.redirect('/admin/telegram-channels?err=' + encodeURIComponent('Invalid JSON: ' + e.message.slice(0, 80)));
      }
    } else {
      entries = text.split(/\r?\n/).map(l => l.trim().replace(/^@/, '')).filter(Boolean).map(channel_id => ({ channel_id }));
    }

    let added = 0; let updated = 0; let skipped = 0;
    for (const e of entries) {
      const cid = String(e.channel_id || '').trim().replace(/^@/, '');
      if (!/^[a-zA-Z0-9_]{4,40}$/.test(cid)) { skipped++; continue; }
      const r2 = await pool.query(`
        INSERT INTO monitored_channels (source, channel_id, category, label, notes, citation, est_subscribers, active)
        VALUES ('telegram', $1, $2, $3, $4, $5, $6, TRUE)
        ON CONFLICT (source, channel_id) DO UPDATE
        SET category = COALESCE(EXCLUDED.category, monitored_channels.category),
            label = COALESCE(EXCLUDED.label, monitored_channels.label),
            notes = COALESCE(EXCLUDED.notes, monitored_channels.notes),
            citation = COALESCE(EXCLUDED.citation, monitored_channels.citation),
            est_subscribers = COALESCE(EXCLUDED.est_subscribers, monitored_channels.est_subscribers),
            active = TRUE
        RETURNING (xmax = 0) AS inserted_new
      `, [cid, e.category || null, e.label || null, e.notes || null, e.citation || null, e.est_subscribers || null]);
      if (r2.rows[0].inserted_new) added++; else updated++;
    }
    await audit(req, 'bulk_add', { targetType: 'monitored_channel', details: { source: 'telegram', added, updated, skipped, total_input: entries.length } });
    res.redirect(`/admin/telegram-channels?ok=${encodeURIComponent(`Added ${added}, updated ${updated}${skipped ? `, skipped ${skipped}` : ''}`)}`);
  });

  r.post('/admin/telegram-channels/:id/toggle', gate, express.urlencoded({ extended: false }), async (req, res) => {
    const before = await pool.query(`SELECT channel_id, active FROM monitored_channels WHERE id = $1`, [req.params.id]);
    await pool.query(`
      UPDATE monitored_channels
      SET active = NOT active,
          consecutive_empty_runs = CASE WHEN NOT active THEN 0 ELSE consecutive_empty_runs END,
          auto_paused_at = CASE WHEN NOT active THEN NULL ELSE auto_paused_at END,
          auto_paused_reason = CASE WHEN NOT active THEN NULL ELSE auto_paused_reason END
      WHERE id = $1 AND source = 'telegram'
    `, [req.params.id]);
    await audit(req, 'toggle', { targetType: 'monitored_channel', targetId: req.params.id, details: { channel_id: before.rows[0]?.channel_id, was_active: before.rows[0]?.active } });
    res.redirect('/admin/telegram-channels?ok=Toggled');
  });

  r.post('/admin/telegram-channels/:id/delete', gate, express.urlencoded({ extended: false }), async (req, res) => {
    const before = await pool.query(`SELECT channel_id FROM monitored_channels WHERE id = $1`, [req.params.id]);
    await pool.query(`DELETE FROM monitored_channels WHERE id = $1 AND source = 'telegram'`, [req.params.id]);
    await audit(req, 'delete', { targetType: 'monitored_channel', targetId: req.params.id, details: { channel_id: before.rows[0]?.channel_id } });
    res.redirect('/admin/telegram-channels?ok=Deleted');
  });

  // ── /admin/soc — Operations Center ────────────────────────────────
  // Wall-display-friendly multi-customer threat queue. Auto-refresh
  // every 30s. Inline ack/dismiss/escalate buttons. Audio cue on
  // first-load when new T3+ has landed since last seen (cookie-tracked).
  r.get('/admin/soc', gate, async (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';

    // Threat queue: open + reviewing across all customers, T4 first.
    const threats = await pool.query(`
      SELECT te.id, te.tier, te.status, te.created_at, te.alerted_at,
             te.assignee_ip, te.assignee_taken_at, te.assignee_operator_id,
             op.name AS assignee_name, op.email AS assignee_email,
             m.body_excerpt, m.source, m.source_url, m.author_handle, m.posted_at,
             c.name AS customer_name, c.id AS customer_id,
             t.name AS target_name
      FROM threat_events te
      JOIN mentions m ON m.id = te.mention_id
      JOIN customers c ON c.id = te.customer_id
      LEFT JOIN targets t ON t.id = te.target_id
      LEFT JOIN operators op ON op.id = te.assignee_operator_id
      WHERE te.status IN ('open', 'reviewing')
      ORDER BY te.tier DESC, te.created_at DESC
      LIMIT 60
    `);

    // Top-bar counters — across-all-customers state.
    const counters = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE te.tier = 4 AND te.status = 'open')::int AS t4_open,
        COUNT(*) FILTER (WHERE te.tier = 3 AND te.status = 'open')::int AS t3_open,
        COUNT(*) FILTER (WHERE te.status = 'reviewing')::int AS reviewing,
        (SELECT COUNT(*)::int FROM mentions WHERE review_status = 'pending') AS t2_pending,
        (SELECT COUNT(*)::int FROM mentions WHERE ingested_at > NOW() - INTERVAL '1 hour') AS mentions_1h
      FROM threat_events te
    `);
    const c = counters.rows[0];

    // Activity feed: last 30 events of any kind.
    const feed = await pool.query(`
      (
        SELECT 'threat' AS kind, te.created_at AS at, te.tier, te.status,
               t.name AS target, cu.name AS customer, m.source, m.body_excerpt
        FROM threat_events te
        JOIN mentions m ON m.id = te.mention_id
        JOIN customers cu ON cu.id = te.customer_id
        LEFT JOIN targets t ON t.id = te.target_id
        ORDER BY te.created_at DESC LIMIT 20
      )
      UNION ALL
      (
        SELECT 'worker_err' AS kind, started_at AS at, NULL::int AS tier, NULL::text AS status,
               worker_name AS target, NULL AS customer, worker_name AS source, error AS body_excerpt
        FROM worker_runs
        WHERE NOT ok AND started_at > NOW() - INTERVAL '6 hours'
        ORDER BY started_at DESC LIMIT 10
      )
      ORDER BY at DESC LIMIT 30
    `);

    // New-T3+-since-last-load detection. Cookie tracks the latest seen
    // threat_event id; if the current top T3+ id is different, we
    // tell the page to play the alert tone on load.
    const latestT3Plus = threats.rows.find(r2 => r2.tier >= 3);
    const lastSeen = req.cookies?.soc_last_seen || (req.headers.cookie || '').match(/soc_last_seen=([^;]+)/)?.[1] || '';
    const playAlert = latestT3Plus && lastSeen !== latestT3Plus.id;
    if (latestT3Plus) {
      const isProd = process.env.NODE_ENV === 'production';
      res.append('Set-Cookie', `soc_last_seen=${encodeURIComponent(latestT3Plus.id)}; Path=/admin/soc; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}; Max-Age=86400`);
    }

    const tierColor = { 4: '#7a1019', 3: '#a04400', 2: '#7a4a0a', 1: '#5b6573' };
    const tierBg = { 4: '#1a0608', 3: '#1a0c00', 2: '#0e1422', 1: '#0e1422' };
    const tierBorder = { 4: '#a82a2a', 3: '#d8902f', 2: '#5b6573', 1: '#1c2330' };

    const fmtTimeShort = (d) => {
      if (!d) return '—';
      const dt = d instanceof Date ? d : new Date(d);
      return dt.toISOString().slice(11, 16) + 'Z';
    };

    const threatCards = threats.rows.length === 0
      ? '<div style="text-align:center;padding:48px;color:#5b6573">No open threats. ☕</div>'
      : threats.rows.map(t => {
          const taken = !!(t.assignee_operator_id || t.assignee_ip);
          const mine = (req.operator?.id && t.assignee_operator_id === req.operator.id) || (!t.assignee_operator_id && t.assignee_ip === ip);
          const takenByLabel = t.assignee_name || t.assignee_email || (t.assignee_ip || '').slice(0, 16);
          const pulse = t.tier === 4 && t.status === 'open' ? ' soc-pulse' : '';
          return `<div class="soc-card${pulse}" style="background:${tierBg[t.tier] || '#0e1422'};border-color:${tierBorder[t.tier] || '#1c2330'}">
            <div class="soc-card-head">
              <span class="tier-pill" style="background:${tierColor[t.tier]};color:#fff">T${t.tier}</span>
              <strong>${escapeHtml(t.target_name || '—')}</strong>
              <span class="muted">·</span>
              <span class="muted">${escapeHtml(t.customer_name)}</span>
              <span class="muted">·</span>
              <span class="muted">${escapeHtml(t.source)}${t.author_handle ? ' · @' + escapeHtml(t.author_handle) : ''}</span>
              <span class="soc-age">${ago(t.created_at)}</span>
            </div>
            <div class="soc-card-body">${escapeHtml((t.body_excerpt || '').slice(0, 280))}</div>
            <div class="soc-card-meta">
              status: <strong>${escapeHtml(t.status)}</strong>
              ${taken ? ` · taken by <strong>${mine ? 'you' : escapeHtml(takenByLabel)}</strong> ${ago(t.assignee_taken_at)}` : ''}
              ${t.source_url ? ` · <a href="${escapeHtml(t.source_url)}" target="_blank" rel="noopener">source</a>` : ''}
              · <a href="/admin/customers/${t.customer_id}">customer</a>
            </div>
            <div class="soc-actions">
              ${!taken ? `<form method="POST" action="/admin/soc/${t.id}/take" style="display:inline"><button class="btn-take" type="submit">Take</button></form>` : ''}
              <form method="POST" action="/admin/soc/${t.id}/ack" style="display:inline"><button class="btn-ack" type="submit">Ack (reviewing)</button></form>
              <form method="POST" action="/admin/soc/${t.id}/dismiss" style="display:inline"><button class="btn-dismiss" type="submit">Dismiss</button></form>
              <form method="POST" action="/admin/soc/${t.id}/escalate-le" style="display:inline"><button class="btn-le" type="submit">→ Law enf</button></form>
            </div>
          </div>`;
        }).join('');

    const feedItems = feed.rows.map(f => {
      const time = fmtTimeShort(f.at);
      if (f.kind === 'threat') {
        const c2 = f.tier ? tierColor[f.tier] : '#5b6573';
        return `<div class="feed-row"><span class="feed-time">${time}</span><span class="tier-pill" style="background:${c2};color:#fff">T${f.tier}</span> <strong>${escapeHtml(f.target || '—')}</strong> <span class="muted">${escapeHtml(f.customer || '')} · ${escapeHtml(f.source || '')}</span><div class="feed-excerpt">${escapeHtml((f.body_excerpt || '').slice(0, 100))}</div></div>`;
      } else {
        return `<div class="feed-row feed-err"><span class="feed-time">${time}</span><span class="tier-pill" style="background:#5e0e16;color:#fff">ERR</span> <strong>${escapeHtml(f.target)}</strong><div class="feed-excerpt">${escapeHtml((f.body_excerpt || '').slice(0, 120))}</div></div>`;
      }
    }).join('');

    const css = `
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Inter,system-ui,-apple-system,sans-serif;background:#050810;color:#e6edf3;font-size:14px;line-height:1.4}
      .topbar{background:linear-gradient(180deg,#0e1422 0%, #050810 100%);border-bottom:1px solid #2a2c40;padding:14px 24px;display:flex;align-items:center;gap:24px;position:sticky;top:0;z-index:10}
      .topbar .brand{font-weight:700;letter-spacing:.08em;color:#ffd56b;font-size:16px}
      .counter{display:flex;flex-direction:column;align-items:center}
      .counter .n{font-size:24px;font-weight:700;line-height:1}
      .counter .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin-top:4px}
      .counter.t4 .n{color:#ff7080}
      .counter.t3 .n{color:#e57e3a}
      .counter.t2 .n{color:#d8902f}
      .counter.review .n{color:#7fff7f}
      .topbar .right{margin-left:auto;font-size:12px;color:#8b949e;text-align:right}
      .layout{display:grid;grid-template-columns:1fr 360px;gap:0;height:calc(100vh - 60px)}
      .queue{padding:18px 24px;overflow-y:auto;border-right:1px solid #1c2330}
      .feed{padding:14px 18px;overflow-y:auto;background:#0a0d18}
      .queue h2,.feed h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin-bottom:12px;display:flex;align-items:center;gap:8px}
      .live-dot{width:8px;height:8px;border-radius:50%;background:#3a9c3a;animation:livepulse 2s infinite}
      @keyframes livepulse{0%,100%{opacity:1}50%{opacity:.3}}
      .soc-card{background:#0e1422;border:1px solid #1c2330;border-radius:6px;padding:12px 14px;margin-bottom:10px}
      .soc-card-head{display:flex;align-items:center;gap:8px;font-size:13px;flex-wrap:wrap}
      .soc-card-body{padding:8px 0;color:#cdd5e0;font-size:14px;line-height:1.5}
      .soc-card-meta{font-size:11px;color:#8b949e;margin-bottom:8px}
      .soc-card-meta a{color:#4f9af0}
      .soc-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
      .soc-actions button{font-size:11px;font-weight:600;padding:5px 10px;border:0;border-radius:3px;cursor:pointer;color:#fff;font-family:inherit}
      .btn-take{background:#1a4a1a}
      .btn-ack{background:#2a5a8c}
      .btn-dismiss{background:#3d301a}
      .btn-le{background:#7a1019}
      .tier-pill{display:inline-block;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:.05em}
      .soc-age{margin-left:auto;color:#5b6573;font-size:11px}
      .muted{color:#8b949e;font-size:12px}
      .soc-pulse{animation:tier4pulse 1.6s infinite}
      @keyframes tier4pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,112,128,.0)}50%{box-shadow:0 0 0 4px rgba(255,112,128,.4)}}
      .feed-row{padding:6px 0;border-bottom:1px solid #1c2330;font-size:12px}
      .feed-row:last-child{border-bottom:0}
      .feed-time{color:#5b6573;font-family:'SF Mono',Monaco,monospace;margin-right:6px}
      .feed-excerpt{color:#5b6573;font-size:11px;margin-top:2px;padding-left:32px}
      .feed-err .tier-pill{background:#5e0e16}
    `;

    const js = `
      // 30s auto-refresh keeps the page live without WebSockets.
      setTimeout(function(){ location.reload(); }, 30000);
      // Audio alert on new T3+ (only if cookie didn't match prior latest).
      ${playAlert ? `
        (function(){
          try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var o = ctx.createOscillator();
            var g = ctx.createGain();
            o.type = 'sine'; o.frequency.value = 880;
            g.gain.setValueAtTime(0.3, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
            o.connect(g); g.connect(ctx.destination);
            o.start(); o.stop(ctx.currentTime + 0.5);
          } catch(e){}
        })();
      ` : ''}
    `;

    res.set('Content-Type', 'text/html; charset=utf-8');
    // Relax CSP for this page so the inline audio script can run.
    // Only this route needs the unsafe-inline; the rest of the app keeps strict CSP.
    res.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'");
    res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOC — Sentinel</title>
<style>${css}</style>
</head><body>
<div class="topbar">
  <div class="brand">SENTINEL · SOC</div>
  <div class="counter t4"><div class="n">${c.t4_open}</div><div class="lbl">T4 open</div></div>
  <div class="counter t3"><div class="n">${c.t3_open}</div><div class="lbl">T3 open</div></div>
  <div class="counter review"><div class="n">${c.reviewing}</div><div class="lbl">Reviewing</div></div>
  <div class="counter t2"><div class="n">${c.t2_pending}</div><div class="lbl">T2 queue</div></div>
  <div class="counter"><div class="n" style="color:#cdd5e0">${c.mentions_1h}</div><div class="lbl">Mentions 1h</div></div>
  <div class="right">
    <div><span class="live-dot"></span> live · auto-refresh 30s</div>
    <div style="margin-top:2px;font-family:monospace">operator: ${escapeHtml(ip.slice(0, 16))}</div>
  </div>
</div>

<div class="layout">
  <div class="queue">
    <h2><span class="live-dot"></span> Active threat queue (${threats.rowCount})</h2>
    ${threatCards}
  </div>
  <div class="feed">
    <h2><span class="live-dot"></span> Activity feed</h2>
    ${feedItems}
  </div>
</div>

<script>${js}</script>
</body></html>`);
  });

  // SOC inline action handlers — write threat-event status updates +
  // append audit notes. Same shape as the customer-side dashboard
  // actions but operator-side and unified across customers.
  async function _socAction(req, action, newStatus, takeIfNot = false) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';
    const opId = req.operator?.id || null;
    const opLabel = req.operator?.email || req.operator?.name || ip;
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    const note = `[${stamp}] [SOC ${opLabel}] → ${action}`;
    if (takeIfNot) {
      await pool.query(`
        UPDATE threat_events
        SET assignee_ip = COALESCE(assignee_ip, $2),
            assignee_operator_id = COALESCE(assignee_operator_id, $3),
            assignee_taken_at = COALESCE(assignee_taken_at, NOW())
        WHERE id = $1
      `, [req.params.id, ip, opId]);
    }
    await pool.query(`
      UPDATE threat_events
      SET status = $2,
          resolved_at = CASE WHEN $3::boolean THEN NOW() ELSE resolved_at END,
          notes = CASE WHEN notes IS NULL OR notes = '' THEN $4 ELSE notes || E'\\n' || $4 END
      WHERE id = $1
    `, [req.params.id, newStatus, ['dismissed', 'reported_law_enf', 'monitoring'].includes(newStatus), note]);
  }

  r.post('/admin/soc/:id/take', gate, express.urlencoded({ extended: false }), async (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';
    const opId = req.operator?.id || null;
    await pool.query(`UPDATE threat_events SET assignee_ip = $2, assignee_operator_id = $3, assignee_taken_at = NOW() WHERE id = $1`, [req.params.id, ip, opId]);
    await audit(req, 'soc_take', { targetType: 'threat_event', targetId: req.params.id });
    res.redirect('/admin/soc');
  });
  r.post('/admin/soc/:id/ack', gate, express.urlencoded({ extended: false }), async (req, res) => {
    await _socAction(req, 'ack', 'reviewing', true);
    await audit(req, 'soc_ack', { targetType: 'threat_event', targetId: req.params.id });
    res.redirect('/admin/soc');
  });
  r.post('/admin/soc/:id/dismiss', gate, express.urlencoded({ extended: false }), async (req, res) => {
    await _socAction(req, 'dismiss', 'dismissed', true);
    await audit(req, 'soc_dismiss', { targetType: 'threat_event', targetId: req.params.id });
    res.redirect('/admin/soc');
  });
  r.post('/admin/soc/:id/escalate-le', gate, express.urlencoded({ extended: false }), async (req, res) => {
    await _socAction(req, 'escalate-LE', 'reported_law_enf', true);
    await audit(req, 'soc_le_escalate', { targetType: 'threat_event', targetId: req.params.id });
    res.redirect('/admin/soc');
  });

  // ── /admin/leads ──────────────────────────────────────────────────
  // Beta-access form submissions. Operator follows up manually; once
  // provisioned, mark status=converted via the /admin/leads/:id action.
  r.get('/admin/leads', gate, async (req, res) => {
    const flash = req.query.ok ? `<div style="background:#1a4a1a;color:#7fff7f;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.ok)}</div>` : '';
    const q = await pool.query(`
      SELECT id, campaign_name, contact_name, contact_email, role, state, message, ip,
             status, contacted_at, provisioned_customer_id, created_at
      FROM beta_leads
      ORDER BY created_at DESC
      LIMIT 200
    `);
    const statusPill = (s) => {
      const colors = { new: '#1a3a5c', contacted: '#3d301a', qualified: '#2a5a8c', converted: '#1a4a1a', declined: '#5e0e16', spam: '#3d301a' };
      const fg = { new: '#cfe5ff', contacted: '#d8902f', qualified: '#cfe5ff', converted: '#7fff7f', declined: '#ff7f7f', spam: '#d8902f' };
      return `<span class="status-pill" style="background:${colors[s] || '#1c2330'};color:${fg[s] || '#8b949e'}">${escapeHtml(s)}</span>`;
    };
    const rows = q.rows.map(l => {
      // Build the prefilled-provision URL so "Convert" goes straight there.
      const provisionParams = new URLSearchParams();
      provisionParams.set('lead_id', l.id);
      provisionParams.set('name', l.campaign_name);
      provisionParams.set('contact_email', l.contact_email);
      provisionParams.set('alert_email', l.contact_email);
      provisionParams.set('digest_email', l.contact_email);
      if (l.state) provisionParams.set('state', l.state);
      const convertHref = `/admin/provision?${provisionParams.toString()}`;
      const convertedLink = l.provisioned_customer_id
        ? `<a href="/admin/customers/${l.provisioned_customer_id}" style="font-size:11px">→ customer</a>`
        : `<a href="${escapeHtml(convertHref)}" style="background:#1a4a1a;color:#7fff7f;padding:3px 8px;border-radius:3px;font-size:11px;text-decoration:none;font-weight:600">+ Convert</a>`;
      return `
      <tr>
        <td><strong>${escapeHtml(l.campaign_name)}</strong>${l.state ? ` <span class="muted">(${escapeHtml(l.state)})</span>` : ''}</td>
        <td>${escapeHtml(l.contact_name || '—')}<br><span class="muted" style="font-size:11px">${escapeHtml(l.role || '')}</span></td>
        <td><a href="mailto:${escapeHtml(l.contact_email)}">${escapeHtml(l.contact_email)}</a></td>
        <td>${statusPill(l.status)}<br>${convertedLink}</td>
        <td class="muted">${ago(l.created_at)}</td>
        <td class="muted" style="max-width:280px">${escapeHtml((l.message || '').slice(0, 200))}</td>
        <td>
          ${['contacted', 'qualified', 'converted', 'declined', 'spam'].map(s => `
            <form method="POST" action="/admin/leads/${l.id}/status" style="display:inline">
              <input type="hidden" name="status" value="${s}">
              <button type="submit" style="background:#1c2330;color:#e6edf3;border:0;padding:3px 7px;border-radius:3px;cursor:pointer;font-size:10px;${l.status === s ? 'opacity:0.4' : ''}">→ ${s}</button>
            </form>
          `).join(' ')}
        </td>
      </tr>
    `;
    }).join('');
    const body = `
      <h1>Beta-access leads</h1>
      <div class="muted">Submissions from the public landing-page form.</div>
      ${flash}
      ${q.rowCount ? `<table style="margin-top:14px">
        <thead><tr><th>Campaign</th><th>Contact</th><th>Email</th><th>Status</th><th>Submitted</th><th>Message</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="muted" style="margin-top:14px">No leads yet. Form submissions land here automatically.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('leads', body, req.operator));
  });

  r.post('/admin/leads/:id/status', gate, express.urlencoded({ extended: false }), async (req, res) => {
    const newStatus = req.body.status;
    if (!['new', 'contacted', 'qualified', 'converted', 'declined', 'spam'].includes(newStatus)) return res.redirect('/admin/leads?err=Bad+status');
    const setContactedAt = ['contacted', 'qualified', 'converted', 'declined'].includes(newStatus);
    await pool.query(`
      UPDATE beta_leads SET status = $1, contacted_at = CASE WHEN $2::boolean AND contacted_at IS NULL THEN NOW() ELSE contacted_at END WHERE id = $3
    `, [newStatus, setContactedAt, req.params.id]);
    await audit(req, 'lead_status', { targetType: 'beta_lead', targetId: req.params.id, details: { new_status: newStatus } });
    res.redirect('/admin/leads?ok=Lead+status+updated');
  });

  // ── /admin/operators ──────────────────────────────────────────────
  // Operator CRUD. Role is advisory only in v1 (all operators have full
  // /admin access). Future: enforce viewer-only / analyst-only on
  // specific routes via req.operator.role.
  r.get('/admin/operators', gate, async (req, res) => {
    const flash = req.query.ok ? `<div style="background:#1a4a1a;color:#7fff7f;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.ok)}</div>` : '';
    const errFlash = req.query.err ? `<div style="background:#5e0e16;color:#fff;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.err)}</div>` : '';
    const q = await pool.query(`
      SELECT id, email, name, role, active, last_login_at, login_count, created_at
      FROM operators ORDER BY active DESC, created_at DESC
    `);
    const rows = q.rows.map(o => `
      <tr>
        <td><strong>${escapeHtml(o.name)}</strong>${req.operator?.id === o.id ? ' <span class="muted" style="font-size:11px">(you)</span>' : ''}</td>
        <td>${escapeHtml(o.email)}</td>
        <td><span class="status-pill" style="background:#1a3a5c;color:#cfe5ff">${escapeHtml(o.role)}</span></td>
        <td>${o.active ? '<span class="pill ok">active</span>' : '<span class="pill" style="background:#3d301a;color:#d8902f">disabled</span>'}</td>
        <td class="muted">${o.last_login_at ? ago(o.last_login_at) : 'never'}<div class="muted" style="font-size:11px">${o.login_count} logins</div></td>
        <td class="muted">${fmtTime(o.created_at)}</td>
        <td>
          <form method="POST" action="/admin/operators/${o.id}/toggle" style="display:inline">
            <button type="submit" class="secondary" style="background:#1c2330;color:#e6edf3;border:0;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px">${o.active ? 'disable' : 'enable'}</button>
          </form>
        </td>
      </tr>
    `).join('');
    const body = `
      <h1>Operators</h1>
      <div class="muted">Members of the Sentinel SOC team. Login at <code>/admin/login</code>.</div>
      ${flash}${errFlash}
      ${q.rowCount ? `<table style="margin-top:14px">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th>Created</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="muted" style="margin-top:14px">No operators yet. Bootstrap with <code>node scripts/add-operator.js</code>.</div>'}

      <h2 style="margin-top:32px">Add operator</h2>
      <form method="POST" action="/admin/operators" style="background:#0e1422;padding:16px;border:1px solid #1c2330;border-radius:6px;max-width:500px">
        <div style="margin-bottom:10px"><label style="display:block;color:#8b949e;font-size:12px;margin-bottom:4px">Name</label><input type="text" name="name" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:8px 10px;border-radius:3px;width:100%;font-size:13px"></div>
        <div style="margin-bottom:10px"><label style="display:block;color:#8b949e;font-size:12px;margin-bottom:4px">Email</label><input type="email" name="email" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:8px 10px;border-radius:3px;width:100%;font-size:13px"></div>
        <div style="margin-bottom:10px"><label style="display:block;color:#8b949e;font-size:12px;margin-bottom:4px">Initial password (≥ 8 chars)</label><input type="text" name="password" required minlength="8" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:8px 10px;border-radius:3px;width:100%;font-size:13px;font-family:monospace"></div>
        <div style="margin-bottom:10px"><label style="display:block;color:#8b949e;font-size:12px;margin-bottom:4px">Role (advisory only in v1)</label><select name="role" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:8px 10px;border-radius:3px;width:100%;font-size:13px"><option value="analyst">analyst</option><option value="admin">admin</option><option value="viewer">viewer</option></select></div>
        <button type="submit" style="background:#4f9af0;color:#fff;border:0;padding:8px 14px;border-radius:3px;cursor:pointer">Add</button>
      </form>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('operators', body, req.operator));
  });

  r.post('/admin/operators', gate, express.urlencoded({ extended: false }), async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.redirect('/admin/operators?err=All+fields+required');
    if (password.length < 8) return res.redirect('/admin/operators?err=Password+must+be+%E2%89%A5+8+chars');
    try {
      const passwordHash = await opAuth.hashPassword(password);
      const useRole = ['admin', 'analyst', 'viewer'].includes(role) ? role : 'analyst';
      const r2 = await pool.query(`
        INSERT INTO operators (email, name, password_hash, role, active)
        VALUES ($1, $2, $3, $4, TRUE)
        ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = TRUE
        RETURNING id, (xmax = 0) AS inserted
      `, [String(email).toLowerCase().trim(), name, passwordHash, useRole]);
      await audit(req, r2.rows[0].inserted ? 'operator_create' : 'operator_update', { targetType: 'operator', targetId: r2.rows[0].id, details: { email, role: useRole } });
      res.redirect('/admin/operators?ok=Operator+saved.+Send+credentials+via+secure+channel.');
    } catch (e) {
      res.redirect('/admin/operators?err=' + encodeURIComponent(e.message.slice(0, 100)));
    }
  });

  r.post('/admin/operators/:id/toggle', gate, express.urlencoded({ extended: false }), async (req, res) => {
    if (req.operator?.id === req.params.id) {
      return res.redirect('/admin/operators?err=Cannot+disable+yourself');
    }
    await pool.query(`UPDATE operators SET active = NOT active WHERE id = $1`, [req.params.id]);
    await audit(req, 'operator_toggle', { targetType: 'operator', targetId: req.params.id });
    res.redirect('/admin/operators?ok=Operator+toggled');
  });

  // ── /admin/audit ──────────────────────────────────────────────────
  // Operator action history. Last 200 actions, newest first.
  r.get('/admin/audit', gate, async (req, res) => {
    const q = await pool.query(`
      SELECT id, actor, action, target_type, target_id, details, ip, created_at
      FROM operator_audit
      ORDER BY created_at DESC
      LIMIT 200
    `);
    const rows = q.rows.map(a => `
      <tr>
        <td class="muted">${ago(a.created_at)}</td>
        <td><span class="status-pill" style="background:#1a3a5c;color:#cfe5ff">${escapeHtml(a.action)}</span></td>
        <td>${escapeHtml(a.target_type || '—')}</td>
        <td><code style="font-size:11px">${escapeHtml((a.target_id || '').slice(0, 12))}${a.target_id && a.target_id.length > 12 ? '…' : ''}</code></td>
        <td class="muted">${escapeHtml(a.actor)}</td>
        <td class="muted">${escapeHtml(a.ip || '—')}</td>
        <td><pre style="font-size:11px;max-height:80px;overflow:auto;background:#0a0f1a;border:1px solid #1c2330;border-radius:3px;padding:6px">${escapeHtml(a.details ? JSON.stringify(a.details, null, 2).slice(0, 400) : '—')}</pre></td>
      </tr>
    `).join('');
    const body = `
      <h1>Operator audit log</h1>
      <div class="muted">Last 200 admin actions. Recorded automatically on every write.</div>
      ${q.rowCount ? `<table style="margin-top:14px">
        <thead><tr><th>When</th><th>Action</th><th>Target type</th><th>Target ID</th><th>Actor</th><th>IP</th><th>Details</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="muted" style="margin-top:14px">No actions logged yet.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('audit', body, req.operator));
  });

  // ── /admin/threats ────────────────────────────────────────────────
  r.get('/admin/threats', gate, async (req, res) => {
    const q = await pool.query(`
      SELECT te.id, te.tier, te.status, te.created_at, te.alerted_at, te.resolved_at,
             m.body_excerpt, m.source, m.source_url,
             c.name AS customer_name, t.name AS target_name
      FROM threat_events te
      JOIN mentions m ON m.id = te.mention_id
      JOIN customers c ON c.id = te.customer_id
      LEFT JOIN targets t ON t.id = te.target_id
      ORDER BY te.tier DESC, te.created_at DESC LIMIT 100
    `);
    const rows = q.rows.map(t => `
      <tr>
        <td>T${t.tier}</td>
        <td>${escapeHtml(t.customer_name)}</td>
        <td>${escapeHtml(t.target_name || '—')}</td>
        <td>${escapeHtml(t.source)}</td>
        <td class="muted">${escapeHtml((t.body_excerpt || '').slice(0, 140))}</td>
        <td><span class="pill ${t.status === 'open' || t.status === 'reviewing' ? 'err' : 'ok'}">${escapeHtml(t.status)}</span></td>
        <td class="muted">${ago(t.created_at)}</td>
      </tr>
    `).join('');
    const body = `<h1>All threat events (last 100)</h1>
      ${q.rowCount ? `<table><thead><tr><th>Tier</th><th>Customer</th><th>Target</th><th>Source</th><th>Excerpt</th><th>Status</th><th>Detected</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted">No threat events.</div>'}`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('threats', body, req.operator));
  });

  return r;
}

module.exports = build;
