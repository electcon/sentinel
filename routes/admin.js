// routes/admin.js
// Internal admin view for the Sentinel operator (David). HTTP Basic
// auth gated by ADMIN_PASSWORD env var. If unset, all /admin routes
// 404. No customer auth — this is the operator's omniscient view.

'use strict';

const crypto = require('crypto');
const express = require('express');
const { hashPassword } = require('../lib/auth');

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

function basicAuthGate(req, res) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) { res.status(404).send('not found'); return false; }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) { challenge(res); return false; }
  let creds;
  try { creds = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch (_) { challenge(res); return false; }
  const [, password] = creds.split(/:(.*)/);
  if (!password) { challenge(res); return false; }
  // Constant-time compare.
  const a = Buffer.from(password); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { challenge(res); return false; }
  return true;
}
function challenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="Sentinel admin"');
  res.status(401).send('auth required');
}

function adminPage(title, body) {
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
</div>
<div class="container">
${body}
</div>
</body></html>`;
}

function build(pool) {
  const r = express.Router();

  function gate(req, res, next) {
    if (!basicAuthGate(req, res)) return;
    next();
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
    const body = `
      <h1>Sentinel — admin overview</h1>
      <div class="muted">${customers.rowCount} customer${customers.rowCount === 1 ? '' : 's'} · ${mentions24h.rows[0].n} mentions · ${threats24h.rows[0].n} threat events · ${errors24h.rows[0].n} worker errors (24h)</div>
      ${staleBanner}

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
    res.send(adminPage('overview', body));
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
    const rows = r2.rows.map(c => `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong><div class="muted">${escapeHtml(c.id)}</div></td>
        <td><span class="pill ok">${escapeHtml(c.status)}</span></td>
        <td>${c.target_count}</td>
        <td>${c.mention_count}</td>
        <td class="muted">${escapeHtml(c.contact_email)}</td>
        <td class="muted">${escapeHtml(c.alert_email)}</td>
        <td class="muted">${escapeHtml(c.digest_email)}</td>
        <td class="muted">${fmtTime(c.created_at)}</td>
        <td>${c.password_hash ? '<span class="pill ok">set</span>' : '<span class="pill err">no pw</span>'}</td>
        <td><a href="/admin/customers/${c.id}">open</a></td>
      </tr>
    `).join('');
    const body = `
      <h1>Customers</h1>
      ${flash}
      <div style="margin:14px 0"><a href="/admin/provision"><button style="background:#4f9af0;color:#fff;border:0;padding:8px 14px;border-radius:4px;cursor:pointer;font-size:13px">+ Provision new customer</button></a></div>
      <table>
        <thead><tr><th>Name / ID</th><th>Status</th><th>Targets</th><th>Mentions</th><th>Contact</th><th>Alert</th><th>Digest</th><th>Created</th><th>PW</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('customers', body));
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
    const body = `
      <a href="/admin/customers" class="muted">← all customers</a>
      <h1 style="margin-top:14px">${escapeHtml(cust.name)}</h1>
      <div class="muted">${escapeHtml(cust.id)}</div>
      ${flash}
      <div class="card" style="margin-top:14px">
        <div class="muted">contact: ${escapeHtml(cust.contact_email)}</div>
        <div class="muted">alert: ${escapeHtml(cust.alert_email)}</div>
        <div class="muted">digest: ${escapeHtml(cust.digest_email)}</div>
        <div class="muted">status: ${escapeHtml(cust.status)} · created: ${fmtTime(cust.created_at)} · last digest: ${fmtTime(cust.last_digest_at)}</div>
      </div>
      <h2>Targets (${targets.rowCount})</h2>
      ${targets.rowCount ? `<table><thead><tr><th>Kind</th><th>Name</th><th>Aliases</th><th>Search terms</th></tr></thead><tbody>${targetRows}</tbody></table>` : '<div class="muted">No targets.</div>'}
      <h2>Recent mentions (${recent.rowCount})</h2>
      ${recent.rowCount ? `<table><thead><tr><th>Tier</th><th>Target</th><th>Source</th><th>Excerpt</th><th>Posted</th></tr></thead><tbody>${mentionRows}</tbody></table>` : '<div class="muted">No mentions.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('customer', body));
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
    res.send(adminPage('workers', body));
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
    res.send(adminPage('errors', body));
  });

  // ── /admin/provision (create or update customer via web form) ────
  r.get('/admin/provision', gate, (req, res) => {
    const flash = req.query.ok ? `<div style="background:#1a4a1a;color:#7fff7f;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.ok)}</div>` : '';
    const err = req.query.err ? `<div style="background:#5e0e16;color:#fff;padding:10px;margin-bottom:14px;border-radius:4px">${escapeHtml(req.query.err)}</div>` : '';
    const body = `
      <a href="/admin" style="color:#8b949e;font-size:13px">← admin overview</a>
      <h1 style="margin-top:14px">Provision customer</h1>
      <p style="color:#8b949e;font-size:13px">Idempotent: if a customer with the same name exists, this updates it (preserves mentions/threats).</p>
      ${flash}${err}
      <form method="POST" action="/admin/provision">
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Customer name (e.g., "Jolly for Governor")</label>
          <input type="text" name="name" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Contact email (used for login)</label>
          <input type="email" name="contact_email" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Alert email (tier 3+ real-time)</label>
          <input type="email" name="alert_email" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Digest email (daily summary)</label>
          <input type="email" name="digest_email" required style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
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
          <label style="display:block;color:#8b949e;font-size:13px;margin-bottom:6px">Targets — one per line OR JSON array</label>
          <textarea name="targets" rows="10" placeholder='Either:&#10;Cinde Warmington&#10;Tom Sherman (her partner)&#10;&#10;Or:&#10;[&#10;  {"kind":"candidate","name":"Cinde Warmington","aliases":["Warmington"],"search_terms":["Cinde Warmington"]},&#10;  {"kind":"family","name":"Tom Sherman"}&#10;]' style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:13px;font-family:monospace"></textarea>
        </div>
        <button type="submit" style="background:#4f9af0;color:#fff;border:0;padding:10px 20px;border-radius:4px;font-size:14px;cursor:pointer">Provision</button>
      </form>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(adminPage('Provision customer', body));
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
        await pool.query(`UPDATE customers SET contact_email=$2, alert_email=$3, digest_email=$4, status=$5, password_hash=$6 WHERE id=$1`,
          [customerId, contact_email, alert_email, digest_email, useStatus, passwordHash]);
      } else {
        const ins = await pool.query(`INSERT INTO customers (name, contact_email, alert_email, digest_email, status, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [name, contact_email, alert_email, digest_email, useStatus, passwordHash]);
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
      const note = `${existing.rowCount > 0 ? 'updated' : 'created'} customer; ${created} new + ${updated} updated targets. Send credentials to ${contact_email} via secure channel.`;
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
    res.send(adminPage('classifier quality', body));
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
    res.send(adminPage('threats', body));
  });

  return r;
}

module.exports = build;
