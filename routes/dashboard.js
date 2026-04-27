// routes/dashboard.js
// Customer-facing dashboard. Server-rendered HTML. One page per
// view, plain forms, no JS framework. Mount at root from server.js
// so the routes are at /login, /logout, /dashboard, /dashboard/...
//
// Pages:
//   /login                          GET  + POST
//   /logout                         GET
//   /dashboard                      GET  — main view (open threats + recent mentions)
//   /dashboard/threats              GET  — full threat queue
//   /dashboard/threats/:id          GET  + POST  — detail + status update
//   /dashboard/mentions             GET  — paginated mentions
//   /dashboard/mentions/:id         GET  — full mention detail

'use strict';

const express = require('express');
const {
  hashPassword, verifyPassword,
  setSessionCookie, clearSessionCookie,
  requireCustomerAuth
} = require('../lib/auth');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TIER_LABELS = {
  4: 'Tier 4 — imminent violence',
  3: 'Tier 3 — credible threat / doxxing',
  2: 'Tier 2 — hostile rhetoric',
  1: 'Tier 1 — noise'
};
const TIER_COLORS = { 4: '#7a1019', 3: '#7a4a0a', 2: '#a07f1a', 1: '#5b6573' };

const STATUS_OPTIONS = [
  { value: 'open',                label: 'open' },
  { value: 'reviewing',           label: 'reviewing' },
  { value: 'reported_platform',   label: 'reported to platform' },
  { value: 'reported_law_enf',    label: 'reported to law enforcement' },
  { value: 'monitoring',          label: 'monitoring' },
  { value: 'dismissed',           label: 'dismissed' }
];

function layout({ title, customer, body, active }) {
  const navLink = (href, label, key) =>
    `<a href="${href}" class="${active === key ? 'active' : ''}">${escapeHtml(label)}</a>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Sentinel</title>
<style>
  *,*::before,*::after { box-sizing: border-box; }
  body { margin:0; font-family: Inter, system-ui, -apple-system, sans-serif; background:#0a0f1a; color:#e6edf3; }
  a { color:#4f9af0; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .nav { background:#0e1422; border-bottom:1px solid #1c2330; padding:14px 28px; display:flex; align-items:center; gap:24px; }
  .nav .brand { font-weight:600; letter-spacing:.05em; }
  .nav .links { display:flex; gap:18px; }
  .nav a { color:#8b949e; }
  .nav a.active, .nav a:hover { color:#e6edf3; }
  .nav .right { margin-left:auto; color:#8b949e; font-size:13px; }
  .container { max-width:1100px; margin:0 auto; padding:32px 28px; }
  h1 { margin:0 0 4px; font-size:24px; }
  h2 { margin:24px 0 8px; font-size:16px; text-transform:uppercase; letter-spacing:.05em; color:#8b949e; }
  .muted { color:#8b949e; font-size:13px; }
  .card { background:#0e1422; border:1px solid #1c2330; border-radius:6px; padding:18px; margin-bottom:14px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; }
  .tier-1 { background:#1c2330; color:#8b949e; }
  .tier-2 { background:#3d301a; color:#d8902f; }
  .tier-3 { background:#4a2210; color:#e57e3a; }
  .tier-4 { background:#5e0e16; color:#ff7080; }
  .status-pill { background:#1c2330; color:#8b949e; padding:2px 8px; border-radius:4px; font-size:11px; }
  table { border-collapse:collapse; width:100%; }
  th,td { padding:8px 12px; text-align:left; border-bottom:1px solid #1c2330; font-size:14px; }
  th { color:#8b949e; font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.05em; background:#0e1422; }
  tr:hover { background:#10182a; }
  pre, .body-excerpt { background:#0a0f1a; border:1px solid #1c2330; border-radius:4px; padding:12px; white-space:pre-wrap; font-family:inherit; font-size:14px; line-height:1.5; }
  form { display:inline; }
  button, input[type=submit] { background:#4f9af0; color:#fff; border:0; padding:8px 14px; border-radius:4px; cursor:pointer; font-size:13px; font-weight:500; }
  button.secondary { background:#1c2330; color:#e6edf3; }
  button.danger { background:#5e0e16; }
  input[type=text], input[type=email], input[type=password] { background:#0a0f1a; border:1px solid #1c2330; color:#e6edf3; padding:10px 12px; border-radius:4px; font-size:14px; width:100%; }
  label { display:block; margin-bottom:6px; font-size:13px; color:#8b949e; }
  .field { margin-bottom:14px; }
  .empty { color:#8b949e; font-size:13px; padding:18px; text-align:center; background:#0e1422; border-radius:6px; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .stack { display:flex; flex-direction:column; gap:8px; }
  .row { display:flex; gap:24px; flex-wrap:wrap; }
  .row > * { flex:1 1 240px; }
  .key-value { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; font-size:14px; }
  .key-value > div:nth-child(2n+1) { color:#8b949e; }
  .badge-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  footer { text-align:center; color:#5b6573; font-size:11px; padding:32px; }
</style>
</head><body>
${customer ? `
<div class="nav">
  <div class="brand">SENTINEL</div>
  <div class="links">
    ${navLink('/dashboard', 'overview', 'overview')}
    ${navLink('/dashboard/threats', 'threats', 'threats')}
    ${navLink('/dashboard/mentions', 'mentions', 'mentions')}
  </div>
  <div class="right">
    ${escapeHtml(customer.name)} ·
    <a href="/logout">log out</a>
  </div>
</div>` : ''}
<div class="container">
${body}
</div>
<footer>Sentinel is a monitoring tool, not a security service. Best-effort classification can miss credible threats. Customers retain responsibility for security posture and law-enforcement coordination.</footer>
</body></html>`;
}

function tierPill(tier) {
  const t = tier || 1;
  return `<span class="pill tier-${t}">T${t}</span>`;
}

function statusPill(status) {
  return `<span class="status-pill">${escapeHtml(status || 'open')}</span>`;
}

function fmtTime(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function build(pool) {
  const r = express.Router();
  const auth = requireCustomerAuth(pool);

  // ── Login / logout ─────────────────────────────────────────────────
  r.get('/login', (req, res) => {
    const next = req.query.next || '/dashboard';
    const err = req.query.err === '1' ? '<div class="muted" style="color:#ff7080;margin-bottom:12px">Invalid email or password.</div>' : '';
    const body = `
      <div style="max-width:400px;margin:80px auto">
        <h1 style="text-align:center;margin-bottom:24px">SENTINEL</h1>
        <div class="card">
          ${err}
          <form method="POST" action="/login">
            <input type="hidden" name="next" value="${escapeHtml(next)}">
            <div class="field">
              <label for="email">Email (any address you registered)</label>
              <input id="email" name="email" type="email" required autofocus>
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" required>
            </div>
            <button type="submit" style="width:100%">Log in</button>
          </form>
        </div>
        <div class="muted" style="text-align:center;margin-top:18px">
          Don't have an account? Contact your Sentinel onboarding rep.
        </div>
      </div>`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Log in', customer: null, body, active: 'login' }));
  });

  r.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const email = (req.body.email || '').toLowerCase().trim();
    const password = req.body.password || '';
    const next = req.body.next || '/dashboard';
    if (!email || !password) return res.redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
    try {
      // Match by ANY of contact_email / alert_email / digest_email — campaign teams
      // share one shared password but multiple staff emails.
      const q = await pool.query(`
        SELECT id, password_hash FROM customers
        WHERE LOWER(contact_email) = $1 OR LOWER(alert_email) = $1 OR LOWER(digest_email) = $1
        LIMIT 1
      `, [email]);
      if (!q.rowCount || !q.rows[0].password_hash) return res.redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
      const ok = await verifyPassword(password, q.rows[0].password_hash);
      if (!ok) return res.redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
      setSessionCookie(res, q.rows[0].id);
      res.redirect(next.startsWith('/') ? next : '/dashboard');
    } catch (e) {
      res.status(500).send('login error: ' + escapeHtml(e.message));
    }
  });

  r.get('/logout', (req, res) => {
    clearSessionCookie(res);
    res.redirect('/login');
  });

  // ── Dashboard overview ─────────────────────────────────────────────
  r.get('/dashboard', auth, async (req, res) => {
    const customerId = req.customer.id;

    const [threats, recent, counts] = await Promise.all([
      pool.query(`
        SELECT te.id, te.tier, te.status, te.created_at, te.alerted_at,
               m.body_excerpt, m.source, m.source_url, t.name AS target_name
        FROM threat_events te
        JOIN mentions m ON m.id = te.mention_id
        LEFT JOIN targets t ON t.id = te.target_id
        WHERE te.customer_id = $1
          AND te.status NOT IN ('dismissed', 'reported_law_enf', 'monitoring')
        ORDER BY te.tier DESC, te.created_at DESC
        LIMIT 25
      `, [customerId]),
      pool.query(`
        SELECT m.id, m.threat_tier, m.source, m.source_url, m.posted_at, m.body_excerpt,
               t.name AS target_name
        FROM mentions m
        LEFT JOIN targets t ON t.id = m.target_id
        WHERE m.customer_id = $1
        ORDER BY m.ingested_at DESC
        LIMIT 20
      `, [customerId]),
      pool.query(`
        SELECT COALESCE(threat_tier, 0) AS tier, COUNT(*)::int AS n
        FROM mentions
        WHERE customer_id = $1 AND ingested_at >= NOW() - INTERVAL '24 hours'
        GROUP BY 1
      `, [customerId])
    ]);

    const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let total24 = 0;
    for (const r of counts.rows) { if (r.tier >= 1 && r.tier <= 4) tierCounts[r.tier] = r.n; total24 += r.n; }

    const threatRows = threats.rows.map(t => `
      <tr>
        <td>${tierPill(t.tier)}</td>
        <td>${escapeHtml(t.target_name || '—')}</td>
        <td>${escapeHtml(t.source)}</td>
        <td>${escapeHtml((t.body_excerpt || '').slice(0, 140))}</td>
        <td>${fmtTime(t.created_at)}</td>
        <td>${statusPill(t.status)}</td>
        <td><a href="/dashboard/threats/${t.id}">open</a></td>
      </tr>
    `).join('');

    const recentRows = recent.rows.map(m => `
      <tr>
        <td>${tierPill(m.threat_tier)}</td>
        <td>${escapeHtml(m.target_name || '—')}</td>
        <td>${escapeHtml(m.source)}</td>
        <td>${escapeHtml((m.body_excerpt || '').slice(0, 100))}</td>
        <td>${fmtTime(m.posted_at)}</td>
        <td><a href="/dashboard/mentions/${m.id}">open</a></td>
      </tr>
    `).join('');

    const body = `
      <h1>Overview</h1>
      <div class="muted">${escapeHtml(req.customer.name)} — last 24 hours</div>

      <div class="row" style="margin-top:24px;">
        <div class="card">
          <div class="muted" style="margin-bottom:6px">Open threat queue</div>
          <div style="font-size:32px;font-weight:600">${threats.rowCount}</div>
        </div>
        <div class="card">
          <div class="muted" style="margin-bottom:6px">Mentions (24h)</div>
          <div style="font-size:32px;font-weight:600">${total24}</div>
          <div class="muted" style="margin-top:6px;font-size:12px">
            T4: ${tierCounts[4]} · T3: ${tierCounts[3]} · T2: ${tierCounts[2]} · T1: ${tierCounts[1]}
          </div>
        </div>
      </div>

      <h2>Open threats</h2>
      ${threats.rowCount ? `<table>
        <thead><tr><th>Tier</th><th>Target</th><th>Source</th><th>Excerpt</th><th>Detected</th><th>Status</th><th></th></tr></thead>
        <tbody>${threatRows}</tbody>
      </table>` : '<div class="empty">No open threats. Threats appear here when the classifier flags tier 3+ content.</div>'}

      <h2>Recent mentions</h2>
      ${recent.rowCount ? `<table>
        <thead><tr><th>Tier</th><th>Target</th><th>Source</th><th>Excerpt</th><th>Posted</th><th></th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>` : '<div class="empty">No mentions yet. Sources scan every 5–15 minutes.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Overview', customer: req.customer, body, active: 'overview' }));
  });

  // ── Threat queue (full list, all statuses) ─────────────────────────
  r.get('/dashboard/threats', auth, async (req, res) => {
    const status = req.query.status || 'all';
    const valid = STATUS_OPTIONS.map(s => s.value).concat(['all']);
    const useStatus = valid.includes(status) ? status : 'all';

    const where = useStatus === 'all' ? '' : `AND te.status = $2`;
    const args = useStatus === 'all' ? [req.customer.id] : [req.customer.id, useStatus];

    const r2 = await pool.query(`
      SELECT te.id, te.tier, te.status, te.created_at, te.alerted_at,
             m.body_excerpt, m.source, m.source_url, t.name AS target_name
      FROM threat_events te
      JOIN mentions m ON m.id = te.mention_id
      LEFT JOIN targets t ON t.id = te.target_id
      WHERE te.customer_id = $1 ${where}
      ORDER BY te.tier DESC, te.created_at DESC
      LIMIT 200
    `, args);

    const filterPill = (val, label) =>
      `<a href="/dashboard/threats?status=${val}" class="pill" style="background:${useStatus === val ? '#4f9af0' : '#1c2330'};color:${useStatus === val ? '#fff' : '#8b949e'};margin-right:6px;">${escapeHtml(label)}</a>`;

    const rows = r2.rows.map(t => `
      <tr>
        <td>${tierPill(t.tier)}</td>
        <td>${escapeHtml(t.target_name || '—')}</td>
        <td>${escapeHtml(t.source)}</td>
        <td>${escapeHtml((t.body_excerpt || '').slice(0, 160))}</td>
        <td>${fmtTime(t.created_at)}</td>
        <td>${statusPill(t.status)}</td>
        <td><a href="/dashboard/threats/${t.id}">open</a></td>
      </tr>
    `).join('');

    const body = `
      <h1>Threat queue</h1>
      <div style="margin:16px 0">
        ${filterPill('all', 'all')}
        ${STATUS_OPTIONS.map(s => filterPill(s.value, s.label)).join('')}
      </div>
      ${r2.rowCount ? `<table>
        <thead><tr><th>Tier</th><th>Target</th><th>Source</th><th>Excerpt</th><th>Detected</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">No threats with this filter.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Threats', customer: req.customer, body, active: 'threats' }));
  });

  // ── Threat detail + status update ──────────────────────────────────
  r.get('/dashboard/threats/:id', auth, async (req, res) => {
    const q = await pool.query(`
      SELECT te.*, m.body_excerpt, m.source, m.source_url, m.s3_key, m.posted_at, m.author_handle, m.rationale,
             t.name AS target_name, t.kind AS target_kind
      FROM threat_events te
      JOIN mentions m ON m.id = te.mention_id
      LEFT JOIN targets t ON t.id = te.target_id
      WHERE te.id = $1 AND te.customer_id = $2
      LIMIT 1
    `, [req.params.id, req.customer.id]);
    if (!q.rowCount) return res.status(404).send('not found');
    const t = q.rows[0];

    const statusButtons = STATUS_OPTIONS.filter(s => s.value !== t.status).map(s => `
      <form method="POST" action="/dashboard/threats/${t.id}/action">
        <input type="hidden" name="status" value="${s.value}">
        <button type="submit" class="${s.value === 'dismissed' ? 'danger' : 'secondary'}">→ ${escapeHtml(s.label)}</button>
      </form>
    `).join(' ');

    const body = `
      <a href="/dashboard/threats" class="muted">← all threats</a>
      <h1 style="margin-top:14px">${tierPill(t.tier)} ${escapeHtml(t.target_name || '—')}</h1>
      <div class="muted">${escapeHtml(TIER_LABELS[t.tier] || '')} · current status: ${statusPill(t.status)}</div>

      <div class="card" style="margin-top:20px">
        <div class="key-value">
          <div>target</div><div>${escapeHtml(t.target_name || '—')} (${escapeHtml(t.target_kind || '—')})</div>
          <div>source</div><div>${escapeHtml(t.source)}</div>
          <div>author</div><div>${escapeHtml(t.author_handle || '—')}</div>
          <div>posted</div><div>${fmtTime(t.posted_at)}</div>
          <div>detected</div><div>${fmtTime(t.created_at)}</div>
          <div>alerted</div><div>${fmtTime(t.alerted_at)}</div>
          <div>url</div><div><a href="${escapeHtml(t.source_url)}" target="_blank" rel="noopener">${escapeHtml(t.source_url || '—')}</a></div>
          <div>evidence</div><div><code>${escapeHtml(t.s3_key || '—')}</code></div>
        </div>
      </div>

      <h2>Content</h2>
      <div class="body-excerpt">${escapeHtml(t.body_excerpt || '')}</div>

      <h2>Classifier rationale</h2>
      <div class="body-excerpt">${escapeHtml(t.rationale || '—')}</div>

      <h2>Status</h2>
      <div class="actions">${statusButtons}</div>
      ${t.notes ? `<h2>Notes</h2><div class="body-excerpt">${escapeHtml(t.notes)}</div>` : ''}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Threat', customer: req.customer, body, active: 'threats' }));
  });

  r.post('/dashboard/threats/:id/action', auth, express.urlencoded({ extended: false }), async (req, res) => {
    const newStatus = req.body.status;
    const valid = STATUS_OPTIONS.map(s => s.value);
    if (!valid.includes(newStatus)) return res.status(400).send('bad status');
    const isResolved = ['dismissed', 'reported_law_enf', 'monitoring'].includes(newStatus);
    await pool.query(`
      UPDATE threat_events
      SET status = $2,
          resolved_at = CASE WHEN $3::boolean THEN NOW() ELSE resolved_at END
      WHERE id = $1 AND customer_id = $4
    `, [req.params.id, newStatus, isResolved, req.customer.id]);
    res.redirect(`/dashboard/threats/${req.params.id}`);
  });

  // ── Mentions list (paginated) ──────────────────────────────────────
  r.get('/dashboard/mentions', auth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const tierFilter = req.query.tier;
    const args = [req.customer.id];
    let where = '';
    if (tierFilter && /^[1-4]$/.test(tierFilter)) {
      where = 'AND m.threat_tier = $2';
      args.push(parseInt(tierFilter, 10));
    }
    args.push(limit);
    const q = await pool.query(`
      SELECT m.id, m.threat_tier, m.source, m.source_url, m.posted_at, m.body_excerpt, m.rationale,
             t.name AS target_name
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.customer_id = $1 ${where}
      ORDER BY m.ingested_at DESC
      LIMIT $${args.length}
    `, args);

    const filterPill = (val, label) =>
      `<a href="/dashboard/mentions${val === 'all' ? '' : '?tier=' + val}" class="pill" style="background:${(tierFilter || 'all') === val ? '#4f9af0' : '#1c2330'};color:${(tierFilter || 'all') === val ? '#fff' : '#8b949e'};margin-right:6px;">${escapeHtml(label)}</a>`;

    const rows = q.rows.map(m => `
      <tr>
        <td>${tierPill(m.threat_tier)}</td>
        <td>${escapeHtml(m.target_name || '—')}</td>
        <td>${escapeHtml(m.source)}</td>
        <td>${escapeHtml((m.body_excerpt || '').slice(0, 140))}</td>
        <td>${fmtTime(m.posted_at)}</td>
        <td><a href="/dashboard/mentions/${m.id}">open</a></td>
      </tr>
    `).join('');

    const body = `
      <h1>Mentions</h1>
      <div style="margin:16px 0">
        ${filterPill('all', 'all tiers')}
        ${[4, 3, 2, 1].map(t => filterPill(String(t), `T${t}`)).join('')}
      </div>
      ${q.rowCount ? `<table>
        <thead><tr><th>Tier</th><th>Target</th><th>Source</th><th>Excerpt</th><th>Posted</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">No mentions yet.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Mentions', customer: req.customer, body, active: 'mentions' }));
  });

  // ── Mention detail ─────────────────────────────────────────────────
  r.get('/dashboard/mentions/:id', auth, async (req, res) => {
    const q = await pool.query(`
      SELECT m.*, t.name AS target_name, t.kind AS target_kind
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.id = $1 AND m.customer_id = $2
      LIMIT 1
    `, [req.params.id, req.customer.id]);
    if (!q.rowCount) return res.status(404).send('not found');
    const m = q.rows[0];

    const body = `
      <a href="/dashboard/mentions" class="muted">← all mentions</a>
      <h1 style="margin-top:14px">${tierPill(m.threat_tier)} ${escapeHtml(m.target_name || '—')}</h1>
      <div class="muted">${escapeHtml(TIER_LABELS[m.threat_tier] || '')}</div>

      <div class="card" style="margin-top:20px">
        <div class="key-value">
          <div>source</div><div>${escapeHtml(m.source)}</div>
          <div>author</div><div>${escapeHtml(m.author_handle || '—')}</div>
          <div>posted</div><div>${fmtTime(m.posted_at)}</div>
          <div>ingested</div><div>${fmtTime(m.ingested_at)}</div>
          <div>url</div><div><a href="${escapeHtml(m.source_url)}" target="_blank" rel="noopener">${escapeHtml(m.source_url || '—')}</a></div>
          <div>evidence</div><div><code>${escapeHtml(m.s3_key || '—')}</code></div>
          <div>classifier</div><div>${escapeHtml(m.classifier_v || '—')}</div>
          <div>sentiment</div><div>${m.sentiment ?? '—'}</div>
        </div>
      </div>

      <h2>Content</h2>
      <div class="body-excerpt">${escapeHtml(m.body_excerpt || '')}</div>

      <h2>Classifier rationale</h2>
      <div class="body-excerpt">${escapeHtml(m.rationale || '—')}</div>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Mention', customer: req.customer, body, active: 'mentions' }));
  });

  return r;
}

module.exports = build;
