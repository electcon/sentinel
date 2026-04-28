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
const { sendThreatAlert, generateWebhookSecret } = require('../lib/alert');

// Capture a reviewer disposition into classifier_feedback. Best-effort —
// log failures but don't block the action. Called from both the
// review-queue action POST and the threats action POST.
async function recordClassifierFeedback(pool, { mentionId, customerId, action, actor, note }) {
  try {
    const m = await pool.query(`
      SELECT m.threat_tier, m.classifier_v, m.source, t.kind AS target_kind
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.id = $1 AND m.customer_id = $2
      LIMIT 1
    `, [mentionId, customerId]);
    if (!m.rowCount) return;
    const c = await pool.query(`
      SELECT model, confidence FROM classifications
      WHERE mention_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [mentionId]);
    await pool.query(`
      INSERT INTO classifier_feedback (
        mention_id, customer_id,
        original_tier, original_confidence, original_model, original_prompt_v,
        reviewer_action, reviewer_actor, reviewer_note,
        source, target_kind
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      mentionId, customerId,
      m.rows[0].threat_tier, c.rows[0]?.confidence ?? null, c.rows[0]?.model ?? null, m.rows[0].classifier_v,
      action, actor, (note || '').slice(0, 1000),
      m.rows[0].source, m.rows[0].target_kind
    ]);
  } catch (e) {
    console.error('[classifier_feedback] write failed:', e.message);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Per-IP login rate limit. In-memory counter — fine for single dyno.
// 10 failed attempts per IP per 10 minutes locks out for 30 min.
const _loginAttempts = new Map();
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;

function loginRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!ip) return next();
  const now = Date.now();
  let entry = _loginAttempts.get(ip);
  if (!entry) { entry = { count: 0, firstAt: now, lockedUntil: 0 }; _loginAttempts.set(ip, entry); }
  if (entry.lockedUntil > now) {
    return res.status(429).send('Too many login attempts. Try again in ~30 minutes.');
  }
  if (now - entry.firstAt > LOCKOUT_WINDOW_MS) { entry.count = 0; entry.firstAt = now; }
  entry.count++;
  if (entry.count > LOCKOUT_THRESHOLD) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    return res.status(429).send('Too many login attempts. Try again in ~30 minutes.');
  }
  next();
}

// Periodically prune the rate-limit map so it doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _loginAttempts.entries()) {
    if (e.lockedUntil < now && now - e.firstAt > LOCKOUT_WINDOW_MS) _loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref?.();

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

function layout({ title, customer, body, active, flash, reviewQueueCount }) {
  const reviewCount = reviewQueueCount != null ? reviewQueueCount : (customer && customer.reviewQueueCount) || 0;
  const navLink = (href, label, key, badge) =>
    `<a href="${href}" class="${active === key ? 'active' : ''}">${escapeHtml(label)}${badge ? ` <span style="background:#a07f1a;color:#fff;padding:1px 6px;border-radius:8px;font-size:11px;font-weight:600">${badge}</span>` : ''}</a>`;
  const flashBanner = flash
    ? `<div style="background:${flash.kind === 'err' ? '#5e0e16' : '#1a4a1a'};color:#fff;padding:10px 16px;text-align:center;font-size:14px">${escapeHtml(flash.text)}</div>`
    : '';
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
    ${navLink('/dashboard/review-queue', 'review queue', 'review-queue', reviewCount > 0 ? reviewCount : null)}
    ${navLink('/dashboard/mentions', 'mentions', 'mentions')}
    ${navLink('/dashboard/settings', 'settings', 'settings')}
  </div>
  <div class="right">
    ${escapeHtml(customer.name)} ·
    <a href="/logout">log out</a>
  </div>
</div>` : ''}
${flashBanner}
<div class="container">
${body}
</div>
<footer>Sentinel · a product of Parallax Advisory LLC · monitoring tool, not a security service. Best-effort classification can miss credible threats. Customers retain responsibility for security posture and law-enforcement coordination.</footer>
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

  // After auth, attach the pending-review count to req.customer so
  // every layout() call shows the nav badge. Single small query per
  // render — index `mentions_review_pending` makes it cheap.
  async function withReviewCount(req, res, next) {
    try {
      const q = await pool.query(`SELECT COUNT(*)::int AS n FROM mentions WHERE customer_id = $1 AND review_status = 'pending'`, [req.customer.id]);
      req.customer.reviewQueueCount = q.rows[0].n;
    } catch (_) { req.customer.reviewQueueCount = 0; }
    next();
  }
  const authed = [auth, withReviewCount];

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

  r.post('/login', express.urlencoded({ extended: false }), loginRateLimit, async (req, res) => {
    const email = (req.body.email || '').toLowerCase().trim();
    const password = req.body.password || '';
    const next = req.body.next || '/dashboard';
    if (!email || !password) return res.redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
    try {
      // Match by ANY of contact_email / alert_email / digest_email — campaign teams
      // share one shared password but multiple staff emails.
      // Require password_hash to defend against unprovisioned rows.
      // If multiple customers match, prefer the most-recently-active by mentions.
      const q = await pool.query(`
        SELECT c.id, c.password_hash
        FROM customers c
        LEFT JOIN (SELECT customer_id, MAX(ingested_at) AS last_at FROM mentions GROUP BY customer_id) m ON m.customer_id = c.id
        WHERE c.password_hash IS NOT NULL
          AND (LOWER(c.contact_email) = $1 OR LOWER(c.alert_email) = $1 OR LOWER(c.digest_email) = $1)
        ORDER BY m.last_at DESC NULLS LAST, c.created_at DESC
        LIMIT 1
      `, [email]);
      if (!q.rowCount || !q.rows[0].password_hash) return res.redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
      const ok = await verifyPassword(password, q.rows[0].password_hash);
      if (!ok) return res.redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
      setSessionCookie(res, q.rows[0].id);
      // Record last login for ops visibility — best-effort, don't block.
      pool.query(`UPDATE customers SET last_login_at = NOW(), login_count = login_count + 1 WHERE id = $1`, [q.rows[0].id]).catch(() => {});
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
  r.get('/dashboard', authed, async (req, res) => {
    const customerId = req.customer.id;

    // Per-worker most-recent run, for the system-health panel.
    const workerNames = ['reddit', 'bluesky', 'rss', 'x', 'alert', 'digest'];
    const workerHealth = await pool.query(`
      SELECT DISTINCT ON (worker_name) worker_name, started_at, finished_at, duration_ms, ok, summary, error
      FROM worker_runs
      WHERE worker_name = ANY($1)
      ORDER BY worker_name, started_at DESC
    `, [workerNames]);
    const workerByName = {};
    for (const w of workerHealth.rows) workerByName[w.worker_name] = w;

    // 14-day mention volume by tier, for the chart.
    const chartRaw = await pool.query(`
      SELECT date_trunc('day', ingested_at)::date AS day, COALESCE(threat_tier, 1) AS tier, COUNT(*)::int AS n
      FROM mentions
      WHERE customer_id = $1 AND ingested_at >= NOW() - INTERVAL '14 days'
      GROUP BY 1, 2
      ORDER BY 1
    `, [customerId]);

    // Per-target risk: 30d activity + threats + repeat offenders, summed
    // into a transparent score. Visible on the dashboard so customers
    // know which target needs attention.
    //   score = mentions + (3 × T2+) + (10 × threats) + repeat_offender_bonus
    // Tiers:  ≥ 100 high · ≥ 40 elevated · ≥ 10 moderate · < 10 low
    const targetRisk = await pool.query(`
      SELECT t.id, t.name, t.kind,
             COALESCE(m.total, 0)::int          AS mentions_30d,
             COALESCE(m.t2plus, 0)::int         AS t2plus_30d,
             COALESCE(te.n, 0)::int             AS threats_30d,
             COALESCE(o.n, 0)::int              AS repeat_authors_30d,
             COALESCE(m.last_at, NULL)          AS last_mention_at
      FROM targets t
      LEFT JOIN (
        SELECT target_id,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE threat_tier >= 2) AS t2plus,
               MAX(ingested_at) AS last_at
        FROM mentions
        WHERE customer_id = $1 AND ingested_at > NOW() - INTERVAL '30 days'
        GROUP BY target_id
      ) m ON m.target_id = t.id
      LEFT JOIN (
        SELECT target_id, COUNT(*) AS n FROM threat_events
        WHERE customer_id = $1 AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY target_id
      ) te ON te.target_id = t.id
      LEFT JOIN (
        SELECT target_id, COUNT(DISTINCT author_handle) AS n
        FROM mentions
        WHERE customer_id = $1
          AND ingested_at > NOW() - INTERVAL '30 days'
          AND author_handle IS NOT NULL AND author_handle <> ''
          AND threat_tier >= 2
        GROUP BY target_id
        HAVING COUNT(*) FILTER (WHERE threat_tier >= 2) >= 3
      ) o ON o.target_id = t.id
      WHERE t.customer_id = $1
      ORDER BY t.name
    `, [customerId]);

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

    const ago = (d) => {
      if (!d) return 'never';
      const ms = Date.now() - new Date(d).getTime();
      if (ms < 60_000) return Math.floor(ms / 1000) + 's ago';
      if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
      if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
      return Math.floor(ms / 86_400_000) + 'd ago';
    };

    // Build 14-day chart: stacked SVG bars by tier.
    const chartHtml = renderVolumeChart(chartRaw.rows);
    // Per-worker expected interval (seconds) — used to detect stale data.
    // If last run is older than 2× interval, flag as stale.
    const WORKER_INTERVAL_SECONDS = {
      alert: 60, bluesky: 300, x: 300, reddit: 600, rss: 900, digest: 1800
    };
    const isStale = (name, w) => {
      if (!w) return true;
      const expected = WORKER_INTERVAL_SECONDS[name];
      if (!expected) return false;
      const ageSec = Math.floor((Date.now() - new Date(w.started_at).getTime()) / 1000);
      return ageSec > expected * 2;
    };

    const healthChip = (name) => {
      const w = workerByName[name];
      if (!w) return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#5b6573"></span><span style="color:#8b949e;font-weight:500;width:64px">${escapeHtml(name)}</span><span class="muted">never run</span></div>`;
      const stale = isStale(name, w);
      const dotColor = !w.ok ? '#a82a2a' : stale ? '#d8902f' : '#3a9c3a';
      const staleLabel = stale ? ' · <strong style="color:#d8902f">STALE</strong>' : '';
      const summary = w.summary && typeof w.summary === 'object' ? w.summary : null;
      const summaryBits = summary ? Object.entries(summary).filter(([k]) => !k.includes('_details')).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
      return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 0">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor}"></span>
        <span style="color:#e6edf3;font-weight:500;width:64px">${escapeHtml(name)}</span>
        <span class="muted">${ago(w.started_at)} · ${w.duration_ms || 0}ms${staleLabel}${w.error ? ' · ERROR: ' + escapeHtml(w.error.slice(0, 80)) : ''}</span>
        ${summaryBits ? `<span class="muted" style="margin-left:auto">${escapeHtml(summaryBits)}</span>` : ''}
      </div>`;
    };

    // First-login welcome banner if customer has zero data ingested.
    // Triggered when both: 0 mentions in 24h AND no open threats AND
    // no review-queue items. Tells the customer their account is wired
    // and what to expect rather than showing empty tables.
    const isFirstLogin = total24 === 0 && threats.rowCount === 0 && (req.customer.reviewQueueCount || 0) === 0;
    const targetCount = await pool.query('SELECT COUNT(*)::int AS n FROM targets WHERE customer_id = $1', [customerId]);
    const onboardingBanner = isFirstLogin
      ? `<div style="background:linear-gradient(180deg, #1a3a5c 0%, #0e1422 100%);border:1px solid #2a5a8c;border-radius:8px;padding:24px;margin-bottom:18px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div style="width:32px;height:32px;border-radius:50%;background:#3a9c3a;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:600">✓</div>
            <h2 style="margin:0;font-size:18px;text-transform:none;letter-spacing:0;color:#e6edf3">Account is live</h2>
          </div>
          <div style="font-size:14px;color:#cdd5e0;line-height:1.6">
            <p style="margin:0 0 10px">Sentinel is now scanning <strong>Reddit, Bluesky, news (Google News), X, and Telegram</strong> for mentions of your ${targetCount.rows[0].n} target${targetCount.rows[0].n === 1 ? '' : 's'}. The first mentions usually appear within <strong>15&ndash;30 minutes</strong>.</p>
            <p style="margin:0 0 10px"><strong>What to expect:</strong></p>
            <ul style="margin:0 0 12px;padding-left:20px">
              <li><strong>Tier 1</strong> (noise): visible in <a href="/dashboard/mentions">mentions</a> &mdash; no alerts. This is the bulk of activity.</li>
              <li><strong>Tier 2</strong> (hostile rhetoric): lands in your <a href="/dashboard/review-queue">review queue</a> for human triage. We aim to surface ~5&ndash;20% of mentions here.</li>
              <li><strong>Tier 3+</strong> (credible threats): real-time email alert + lands in your <a href="/dashboard/threats">threat queue</a>. Target latency: under 5 min.</li>
            </ul>
            <p style="margin:0 0 4px"><strong>Next steps:</strong></p>
            <ul style="margin:0 0 4px;padding-left:20px">
              <li>Visit <a href="/dashboard/settings">Settings</a> to add team-member emails or webhook routes (Slack/PagerDuty/etc.)</li>
              <li>Refresh this page in 30 minutes to see initial activity</li>
              <li>Daily digest emails arrive every morning even on quiet days</li>
            </ul>
          </div>
        </div>` : '';

    const body = `
      <h1>Overview</h1>
      <div class="muted">${escapeHtml(req.customer.name)} — last 24 hours</div>

      ${onboardingBanner}

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
        <div class="card">
          <div class="muted" style="margin-bottom:6px">System health</div>
          ${workerNames.map(healthChip).join('')}
        </div>
      </div>

      ${(() => {
        if (!targetRisk.rowCount) return '';
        const riskLabel = (s) => s >= 100 ? 'high' : s >= 40 ? 'elevated' : s >= 10 ? 'moderate' : 'low';
        const riskColors = { high: '#7a1019', elevated: '#a04400', moderate: '#7a4a0a', low: '#1c2330' };
        const riskFg = { high: '#ff7080', elevated: '#e57e3a', moderate: '#d8902f', low: '#8b949e' };
        const rows = targetRisk.rows.map(t => {
          const score = (t.mentions_30d || 0) + 3 * (t.t2plus_30d || 0) + 10 * (t.threats_30d || 0) + 5 * (t.repeat_authors_30d || 0);
          const lvl = riskLabel(score);
          const since = t.last_mention_at ? ago(t.last_mention_at) : 'never';
          const kindBadge = t.kind === 'opponent'
            ? ' <span style="background:#3d2050;color:#c89dff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;letter-spacing:.04em">OPPONENT</span>'
            : ` <span class="muted">(${escapeHtml(t.kind || 'candidate')})</span>`;
          return `<tr>
            <td><strong>${escapeHtml(t.name)}</strong>${kindBadge}</td>
            <td>${t.mentions_30d}</td>
            <td>${t.t2plus_30d}</td>
            <td>${t.threats_30d}</td>
            <td>${t.repeat_authors_30d}</td>
            <td><span class="pill" style="background:${riskColors[lvl]};color:${riskFg[lvl]}">${lvl}</span> <span class="muted" style="font-size:11px">${score}</span></td>
            <td class="muted">${since}</td>
          </tr>`;
        }).join('');
        return `
        <h2>Per-target activity — last 30 days</h2>
        <div class="muted" style="font-size:12px;margin-bottom:8px">Score = mentions + 3×T2+ + 10×threats + 5×repeat-authors. Pill: low &lt; 10 · moderate ≥ 10 · elevated ≥ 40 · high ≥ 100.</div>
        <table>
          <thead><tr><th>Target</th><th>Mentions</th><th>T2+</th><th>Threats</th><th>Repeat authors</th><th>Risk</th><th>Last seen</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      })()}

      <h2>Mention volume — last 14 days</h2>
      ${chartHtml}

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
  r.get('/dashboard/threats', authed, async (req, res) => {
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
  r.get('/dashboard/threats/:id', authed, async (req, res) => {
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
      <button type="submit" name="status" value="${s.value}" class="${s.value === 'dismissed' ? 'danger' : 'secondary'}">→ ${escapeHtml(s.label)}</button>
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
          <div>resolved</div><div>${fmtTime(t.resolved_at)}</div>
          <div>url</div><div><a href="${escapeHtml(t.source_url)}" target="_blank" rel="noopener">${escapeHtml(t.source_url || '—')}</a></div>
          <div>evidence</div><div><code>${escapeHtml(t.s3_key || '—')}</code></div>
        </div>
      </div>

      <h2>Content</h2>
      <div class="body-excerpt">${escapeHtml(t.body_excerpt || '')}</div>

      <h2>Classifier rationale</h2>
      <div class="body-excerpt">${escapeHtml(t.rationale || '—')}</div>

      <h2>Update status</h2>
      <form method="POST" action="/dashboard/threats/${t.id}/action">
        <div class="field">
          <label for="note">Note (optional — adds to the audit trail)</label>
          <textarea id="note" name="note" rows="2" style="width:100%;background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;font-family:inherit;font-size:14px" placeholder="Why this disposition?"></textarea>
        </div>
        <div class="actions">${statusButtons}</div>
      </form>

      ${t.notes ? `<h2>Notes / audit trail</h2>
        <div class="body-excerpt" style="font-size:13px">${escapeHtml(t.notes)}</div>` : ''}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Threat', customer: req.customer, body, active: 'threats' }));
  });

  r.post('/dashboard/threats/:id/action', authed, express.urlencoded({ extended: false }), async (req, res) => {
    const newStatus = req.body.status;
    const note = (req.body.note || '').trim().slice(0, 1000);
    const valid = STATUS_OPTIONS.map(s => s.value);
    if (!valid.includes(newStatus)) return res.status(400).send('bad status');
    const isResolved = ['dismissed', 'reported_law_enf', 'monitoring'].includes(newStatus);
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    const actor = req.customer.name || req.customer.id;
    const entry = `[${stamp}] [${actor}] → ${newStatus}${note ? ' — ' + note : ''}`;
    await pool.query(`
      UPDATE threat_events
      SET status = $2,
          resolved_at = CASE WHEN $3::boolean THEN NOW() ELSE resolved_at END,
          notes = CASE WHEN notes IS NULL OR notes = '' THEN $4 ELSE notes || E'\\n' || $4 END
      WHERE id = $1 AND customer_id = $5
    `, [req.params.id, newStatus, isResolved, entry, req.customer.id]);

    // Capture as classifier feedback (ground truth for drift detection).
    // Look up the underlying mention so we record against it, not the threat_event.
    const ev = await pool.query('SELECT mention_id FROM threat_events WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id]);
    if (ev.rowCount) {
      await recordClassifierFeedback(pool, {
        mentionId: ev.rows[0].mention_id,
        customerId: req.customer.id,
        action: newStatus,
        actor,
        note
      });
    }

    res.redirect(`/dashboard/threats/${req.params.id}`);
  });

  // ── Mentions list (paginated, searchable) ──────────────────────────
  r.get('/dashboard/mentions', authed, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const tierFilter = req.query.tier;
    const sourceFilter = req.query.source;
    const kindFilter = req.query.kind;
    const search = (req.query.q || '').trim().slice(0, 200);
    const args = [req.customer.id];
    const wheres = [];
    if (tierFilter && /^[1-4]$/.test(tierFilter)) {
      args.push(parseInt(tierFilter, 10));
      wheres.push(`m.threat_tier = $${args.length}`);
    }
    if (sourceFilter && /^[a-z_]+$/i.test(sourceFilter)) {
      args.push(sourceFilter);
      wheres.push(`m.source = $${args.length}`);
    }
    if (kindFilter === 'opponent') {
      wheres.push(`t.kind = 'opponent'`);
    } else if (kindFilter === 'own') {
      wheres.push(`(t.kind IS NULL OR t.kind <> 'opponent')`);
    }
    if (search) {
      args.push('%' + search + '%');
      wheres.push(`m.body_excerpt ILIKE $${args.length}`);
    }
    const whereClause = wheres.length ? 'AND ' + wheres.join(' AND ') : '';
    args.push(limit);
    const q = await pool.query(`
      SELECT m.id, m.threat_tier, m.tier_bumped, m.original_tier, m.bump_reason,
             m.source, m.source_url, m.posted_at, m.body_excerpt, m.rationale,
             t.name AS target_name
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.customer_id = $1 ${whereClause}
      ORDER BY m.ingested_at DESC
      LIMIT $${args.length}
    `, args);

    const baseQs = (overrides) => {
      const params = new URLSearchParams();
      const tier = overrides.tier !== undefined ? overrides.tier : tierFilter;
      const source = overrides.source !== undefined ? overrides.source : sourceFilter;
      const kindf = overrides.kind !== undefined ? overrides.kind : kindFilter;
      const q = overrides.q !== undefined ? overrides.q : search;
      if (tier && tier !== 'all') params.set('tier', tier);
      if (source && source !== 'all') params.set('source', source);
      if (kindf && kindf !== 'all') params.set('kind', kindf);
      if (q) params.set('q', q);
      return params.toString() ? '?' + params.toString() : '';
    };

    const filterPill = (kind, val, label) => {
      const active = kind === 'tier' ? (tierFilter || 'all') === val
                    : kind === 'source' ? (sourceFilter || 'all') === val
                    : kind === 'kind' ? (kindFilter || 'all') === val : false;
      const overrides = {};
      overrides[kind] = val === 'all' ? '' : val;
      return `<a href="/dashboard/mentions${baseQs(overrides)}" class="pill" style="background:${active ? '#4f9af0' : '#1c2330'};color:${active ? '#fff' : '#8b949e'};margin-right:6px;">${escapeHtml(label)}</a>`;
    };

    const rows = q.rows.map(m => `
      <tr>
        <td>${tierPill(m.threat_tier)}${m.tier_bumped ? ` <span title="Auto-bumped from T${m.original_tier || '?'} (${escapeHtml(m.bump_reason || '')})" style="background:#5e0e16;color:#ff7f7f;padding:1px 5px;border-radius:2px;font-size:9px;font-weight:600;letter-spacing:.05em">BUMP</span>` : ''}</td>
        <td>${escapeHtml(m.target_name || '—')}</td>
        <td>${escapeHtml(m.source)}</td>
        <td>${escapeHtml((m.body_excerpt || '').slice(0, 140))}</td>
        <td>${fmtTime(m.posted_at)}</td>
        <td><a href="/dashboard/mentions/${m.id}">open</a></td>
      </tr>
    `).join('');

    const body = `
      <h1>Mentions</h1>
      <form method="GET" action="/dashboard/mentions" style="margin:14px 0">
        <input type="text" name="q" value="${escapeHtml(search)}" placeholder="Search mention text…" style="max-width:320px;display:inline-block;width:auto;margin-right:8px">
        ${tierFilter ? `<input type="hidden" name="tier" value="${escapeHtml(tierFilter)}">` : ''}
        ${sourceFilter ? `<input type="hidden" name="source" value="${escapeHtml(sourceFilter)}">` : ''}
        <button type="submit" class="secondary">Search</button>
        ${(search || tierFilter || sourceFilter) ? `<a href="/dashboard/mentions" class="muted" style="margin-left:10px">clear</a>` : ''}
      </form>
      <div style="margin:8px 0">
        <span class="muted" style="font-size:12px;margin-right:8px">tier:</span>
        ${filterPill('tier', 'all', 'all')}
        ${[4, 3, 2, 1].map(t => filterPill('tier', String(t), `T${t}`)).join('')}
      </div>
      <div style="margin:8px 0">
        <span class="muted" style="font-size:12px;margin-right:8px">source:</span>
        ${filterPill('source', 'all', 'all')}
        ${['reddit','bluesky','rss','x','telegram','truthsocial','synth'].map(s => filterPill('source', s, s)).join('')}
      </div>
      <div style="margin:8px 0">
        <span class="muted" style="font-size:12px;margin-right:8px">target type:</span>
        ${filterPill('kind', 'all', 'all')}
        ${filterPill('kind', 'own', 'own targets')}
        ${filterPill('kind', 'opponent', 'opponents')}
      </div>
      <div class="muted" style="margin-top:14px;font-size:12px">${q.rowCount} result${q.rowCount === 1 ? '' : 's'}${search ? ' matching "' + escapeHtml(search) + '"' : ''}</div>
      ${q.rowCount ? `<table style="margin-top:8px">
        <thead><tr><th>Tier</th><th>Target</th><th>Source</th><th>Excerpt</th><th>Posted</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">No mentions match these filters.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Mentions', customer: req.customer, body, active: 'mentions' }));
  });

  // ── Compliance report (HTML for print-to-PDF + JSON for systems) ─
  // Single-page packet a customer hands to outside counsel or LE after
  // an incident. Date-bounded; defaults to last 30 days.
  // Format: `?format=html` (default) | `?format=json`
  // Print: customer hits Ctrl-P / Cmd-P → "Save as PDF". Print stylesheet
  // is opinionated about page breaks and contrast.
  r.get('/dashboard/compliance-report', authed, async (req, res) => {
    const today = new Date(); today.setUTCHours(23, 59, 59, 999);
    const defaultFrom = new Date(today.getTime() - 30 * 86400 * 1000);
    defaultFrom.setUTCHours(0, 0, 0, 0);
    const fromIso = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : defaultFrom.toISOString().slice(0, 10);
    const toIso = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : today.toISOString().slice(0, 10);
    const from = new Date(fromIso + 'T00:00:00.000Z');
    const to = new Date(toIso + 'T23:59:59.999Z');
    const customerId = req.customer.id;

    const [targets, mentionTotals, threats, reviews, sources] = await Promise.all([
      pool.query(`SELECT id, kind, name, aliases, search_terms FROM targets WHERE customer_id = $1 ORDER BY kind, name`, [customerId]),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE threat_tier = 4)::int AS t4,
          COUNT(*) FILTER (WHERE threat_tier = 3)::int AS t3,
          COUNT(*) FILTER (WHERE threat_tier = 2)::int AS t2,
          COUNT(*) FILTER (WHERE threat_tier = 1)::int AS t1,
          COUNT(*) FILTER (WHERE tier_bumped = TRUE)::int AS bumped
        FROM mentions WHERE customer_id = $1 AND ingested_at >= $2 AND ingested_at <= $3
      `, [customerId, from, to]),
      pool.query(`
        SELECT te.id, te.tier, te.status, te.created_at, te.alerted_at, te.resolved_at, te.notes,
               m.body_excerpt, m.source, m.source_id, m.source_url, m.author_handle, m.posted_at, m.s3_key,
               t.name AS target_name, t.kind AS target_kind
        FROM threat_events te
        JOIN mentions m ON m.id = te.mention_id
        LEFT JOIN targets t ON t.id = te.target_id
        WHERE te.customer_id = $1 AND te.created_at >= $2 AND te.created_at <= $3
        ORDER BY te.tier DESC, te.created_at ASC
      `, [customerId, from, to]),
      pool.query(`
        SELECT m.id, m.threat_tier, m.original_tier, m.body_excerpt, m.source, m.source_url, m.posted_at,
               m.author_handle, m.review_status, m.reviewed_at, m.reviewed_by, m.review_notes,
               t.name AS target_name
        FROM mentions m
        LEFT JOIN targets t ON t.id = m.target_id
        WHERE m.customer_id = $1 AND m.review_status IS NOT NULL
          AND m.reviewed_at >= $2 AND m.reviewed_at <= $3
        ORDER BY m.reviewed_at DESC
      `, [customerId, from, to]),
      pool.query(`
        SELECT source, COUNT(*)::int AS n FROM mentions
        WHERE customer_id = $1 AND ingested_at >= $2 AND ingested_at <= $3
        GROUP BY source ORDER BY n DESC
      `, [customerId, from, to])
    ]);

    if (req.query.format === 'json') {
      return res.json({
        customer: { id: req.customer.id, name: req.customer.name },
        coverage: { from: fromIso, to: toIso, sources_active: sources.rows },
        targets: targets.rows,
        mention_totals: mentionTotals.rows[0],
        threat_events: threats.rows,
        reviewed_mentions: reviews.rows,
        generated_at: new Date().toISOString(),
        report_kind: 'compliance.v1'
      });
    }

    const m = mentionTotals.rows[0];
    const targetSection = targets.rows.length
      ? targets.rows.map(t => `<tr><td>${escapeHtml(t.kind || 'candidate')}</td><td>${escapeHtml(t.name)}</td><td>${escapeHtml((t.aliases||[]).join(', ') || '—')}</td><td>${escapeHtml((t.search_terms||[]).join(', ') || '—')}</td></tr>`).join('')
      : '<tr><td colspan="4" style="color:#999">No targets configured.</td></tr>';

    const sourcesSection = sources.rows.length
      ? sources.rows.map(s => `<tr><td>${escapeHtml(s.source)}</td><td style="text-align:right">${s.n}</td></tr>`).join('')
      : '<tr><td colspan="2" style="color:#999">No mentions in period.</td></tr>';

    const tierLabelMap = { 4: 'Tier 4 — imminent violence', 3: 'Tier 3 — credible threat / doxxing', 2: 'Tier 2 — hostile rhetoric', 1: 'Tier 1 — noise' };

    const threatRows = threats.rows.length
      ? threats.rows.map((t, i) => `
        <div class="threat-event" style="page-break-inside:avoid">
          <h3 style="margin:18px 0 4px">#${i + 1} — Tier ${t.tier} · ${escapeHtml(t.target_name || '—')} · ${escapeHtml(t.target_kind || 'candidate')}</h3>
          <table class="kv">
            <tr><td>Tier</td><td><strong>${escapeHtml(tierLabelMap[t.tier] || ('Tier ' + t.tier))}</strong></td></tr>
            <tr><td>Status</td><td>${escapeHtml(t.status)}</td></tr>
            <tr><td>Source</td><td>${escapeHtml(t.source)} · ${escapeHtml(t.author_handle || 'unknown author')}</td></tr>
            <tr><td>URL</td><td style="word-break:break-all">${escapeHtml(t.source_url || '—')}</td></tr>
            <tr><td>Posted at</td><td>${fmtTime(t.posted_at)}</td></tr>
            <tr><td>Detected by Sentinel</td><td>${fmtTime(t.created_at)}</td></tr>
            <tr><td>Alert sent</td><td>${fmtTime(t.alerted_at)}</td></tr>
            <tr><td>Resolved</td><td>${fmtTime(t.resolved_at)}</td></tr>
            <tr><td>Evidence archive key</td><td><code style="font-size:11px">${escapeHtml(t.s3_key || 'not archived')}</code></td></tr>
          </table>
          <div class="quote" style="margin-top:6px">${escapeHtml((t.body_excerpt || '').slice(0, 1000))}</div>
          ${t.notes ? `<div class="notes"><strong>Audit trail:</strong><pre>${escapeHtml(t.notes)}</pre></div>` : ''}
        </div>
      `).join('')
      : '<p style="color:#666">No threat events in this period.</p>';

    const reviewRows = reviews.rows.length
      ? `<table class="data"><thead><tr><th>Disposition</th><th>Tier</th><th>Target</th><th>Excerpt</th><th>Reviewed by</th><th>Reviewed at</th></tr></thead><tbody>` +
        reviews.rows.map(r => `<tr>
          <td>${escapeHtml(r.review_status)}</td>
          <td>T${r.threat_tier}${r.original_tier && r.original_tier !== r.threat_tier ? ` (was T${r.original_tier})` : ''}</td>
          <td>${escapeHtml(r.target_name || '—')}</td>
          <td>${escapeHtml((r.body_excerpt || '').slice(0, 140))}</td>
          <td>${escapeHtml(r.reviewed_by || '—')}</td>
          <td>${fmtTime(r.reviewed_at)}</td>
        </tr>`).join('') + '</tbody></table>'
      : '<p style="color:#666">No reviewer dispositions in this period.</p>';

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Compliance report — ${escapeHtml(req.customer.name)}</title>
<style>
  body { font-family: 'Times New Roman', Times, serif; color: #111; max-width: 850px; margin: 0 auto; padding: 32px; line-height: 1.5; background: #fff; }
  h1 { font-size: 22pt; margin: 0 0 4pt; }
  h2 { font-size: 14pt; margin: 18pt 0 6pt; padding-bottom: 4pt; border-bottom: 1px solid #999; page-break-after: avoid; }
  h3 { font-size: 12pt; margin: 12pt 0 6pt; }
  .header-meta { color: #555; font-size: 11pt; margin-bottom: 6pt; }
  .conf-stamp { display: inline-block; padding: 4pt 10pt; border: 2pt solid #7a1019; color: #7a1019; font-weight: 700; font-size: 10pt; letter-spacing: .1em; margin-bottom: 12pt; }
  table { width: 100%; border-collapse: collapse; font-size: 11pt; margin: 8pt 0; }
  table.kv td:first-child { width: 28%; color: #555; padding: 3pt 6pt; vertical-align: top; }
  table.kv td:last-child { padding: 3pt 6pt; }
  table.data th, table.data td { border: 1px solid #999; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  table.data th { background: #eee; font-weight: 600; }
  .quote { border-left: 3pt solid #7a4a0a; padding: 6pt 10pt; margin: 6pt 0; background: #fafafa; font-style: italic; white-space: pre-wrap; }
  .notes pre { background: #f5f5f5; padding: 6pt; font-size: 10pt; white-space: pre-wrap; font-family: inherit; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10pt; margin: 8pt 0; }
  .summary-grid > div { border: 1px solid #ccc; padding: 8pt; }
  .summary-grid .n { font-size: 18pt; font-weight: 700; color: #111; }
  .summary-grid .lbl { color: #555; font-size: 10pt; }
  .footer { margin-top: 24pt; padding-top: 12pt; border-top: 1px solid #ccc; font-size: 9pt; color: #555; }
  .toolbar { background: #f0f0f0; border: 1px solid #ccc; padding: 12pt; border-radius: 4pt; margin-bottom: 18pt; display: flex; align-items: center; gap: 12pt; }
  .toolbar form { display: flex; gap: 8pt; align-items: center; }
  .toolbar input[type=date] { padding: 4pt 6pt; border: 1px solid #999; border-radius: 3pt; }
  .toolbar button, .toolbar a { background: #1a3a5c; color: #fff; padding: 6pt 14pt; border-radius: 3pt; text-decoration: none; border: 0; cursor: pointer; font-size: 11pt; }
  @media print {
    .toolbar, .no-print { display: none !important; }
    body { padding: 0; }
    h2 { page-break-before: auto; }
    .threat-event { page-break-inside: avoid; }
  }
</style>
</head><body>

<div class="toolbar no-print">
  <form method="GET" action="/dashboard/compliance-report">
    <label>From <input type="date" name="from" value="${escapeHtml(fromIso)}"></label>
    <label>To <input type="date" name="to" value="${escapeHtml(toIso)}"></label>
    <button type="submit">Update</button>
  </form>
  <button type="button" onclick="window.print()">Print / Save as PDF</button>
  <a href="/dashboard/compliance-report?format=json&from=${escapeHtml(fromIso)}&to=${escapeHtml(toIso)}">JSON</a>
  <a href="/dashboard">← back</a>
</div>

<div class="conf-stamp">CONFIDENTIAL — ATTORNEY WORK PRODUCT</div>
<h1>Sentinel Compliance Report</h1>
<div class="header-meta">
  <strong>${escapeHtml(req.customer.name)}</strong><br>
  Period: ${escapeHtml(fromIso)} → ${escapeHtml(toIso)}<br>
  Generated: ${escapeHtml(new Date().toISOString())}<br>
  Provider: Parallax Advisory LLC · sentinel.parallaxadvisory.llc
</div>

<h2>1. Coverage</h2>
<p>This report covers automated monitoring of public social-media and news content for mentions of the targets listed below, during the period stated. Sources actively ingested for this customer during the period:</p>
<table class="data">
  <thead><tr><th>Source</th><th style="text-align:right">Mentions</th></tr></thead>
  <tbody>${sourcesSection}</tbody>
</table>

<h3>Targets monitored</h3>
<table class="data">
  <thead><tr><th>Kind</th><th>Name</th><th>Aliases</th><th>Search terms</th></tr></thead>
  <tbody>${targetSection}</tbody>
</table>

<h2>2. Activity summary</h2>
<div class="summary-grid">
  <div><div class="n">${m.total}</div><div class="lbl">Total mentions</div></div>
  <div><div class="n">${m.t4}</div><div class="lbl">Tier 4 (imminent)</div></div>
  <div><div class="n">${m.t3}</div><div class="lbl">Tier 3 (credible)</div></div>
  <div><div class="n">${m.t2}</div><div class="lbl">Tier 2 (hostile)</div></div>
</div>
<p style="font-size: 10pt; color: #555;">Tier 1 (noise): ${m.t1} · Auto-tier-bumped (repeat-offender heuristic): ${m.bumped}</p>

<h2>3. Threat events</h2>
<p style="font-size: 10pt; color: #555;">All threat events of any tier raised during the reporting period, with timeline, audit trail, and evidence keys. Each event corresponds to one S3-archived raw payload retrievable on request from Parallax Advisory LLC for legal or law-enforcement coordination.</p>
${threatRows}

<h2>4. Tier-2 review dispositions</h2>
<p style="font-size: 10pt; color: #555;">Hostile-rhetoric mentions reviewed and dispositioned by the customer's team during the period.</p>
${reviewRows}

<h2>5. Methodology</h2>
<p style="font-size: 10pt;">Sentinel ingests public posts via documented platform-search interfaces (Reddit anonymous .json, Bluesky AT-Proto public search and Jetstream firehose, Google News RSS, twitterapi.io, Telegram t.me/s/ public preview, TruthSocial Mastodon-API v2). Each post containing a mention of one of the targets above (alias-matched) is classified by an LLM (Anthropic Claude Haiku 4.5) against a 4-tier rubric (noise → hostile rhetoric → credible threat / doxxing → imminent violence). Conservative-bias setting bumps borderline cases up one tier; the same author repeating tier-2-or-above content within 30 days is auto-bumped one tier. Raw payloads are preserved in AWS S3 with 30-day Standard / 90-day Glacier lifecycle.</p>

<div class="footer">
  Sentinel — a product of Parallax Advisory LLC. Sentinel is a monitoring tool, not a security service. Best-effort classification can miss credible threats. Customers retain responsibility for security posture, law-enforcement coordination, and physical safety. Generated automatically; no human review of report contents prior to delivery. Data accuracy as of generated_at timestamp.
</div>

</body></html>`);
  });

  // ── CSV export for mentions ────────────────────────────────────────
  r.get('/dashboard/mentions.csv', authed, async (req, res) => {
    const tierFilter = req.query.tier;
    const sourceFilter = req.query.source;
    const search = (req.query.q || '').trim().slice(0, 200);
    const args = [req.customer.id];
    const wheres = [];
    if (tierFilter && /^[1-4]$/.test(tierFilter)) {
      args.push(parseInt(tierFilter, 10));
      wheres.push(`m.threat_tier = $${args.length}`);
    }
    if (sourceFilter && /^[a-z_]+$/i.test(sourceFilter)) {
      args.push(sourceFilter);
      wheres.push(`m.source = $${args.length}`);
    }
    if (search) {
      args.push('%' + search + '%');
      wheres.push(`m.body_excerpt ILIKE $${args.length}`);
    }
    const whereClause = wheres.length ? 'AND ' + wheres.join(' AND ') : '';
    const q = await pool.query(`
      SELECT m.id, m.threat_tier, m.sentiment, m.source, m.source_id, m.source_url,
             m.author_handle, m.posted_at, m.ingested_at, m.body_excerpt, m.rationale,
             m.classifier_v, m.s3_key, t.name AS target_name, t.kind AS target_kind
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.customer_id = $1 ${whereClause}
      ORDER BY m.ingested_at DESC
      LIMIT 5000
    `, args);
    const cols = ['id','threat_tier','sentiment','source','source_id','source_url','author_handle',
                  'posted_at','ingested_at','body_excerpt','rationale','classifier_v','s3_key',
                  'target_name','target_kind'];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sentinel-mentions-${new Date().toISOString().slice(0,10)}.csv"`);
    res.write(cols.join(',') + '\n');
    for (const row of q.rows) res.write(cols.map(c => csvCell(row[c])).join(',') + '\n');
    res.end();
  });

  r.get('/dashboard/threats.csv', authed, async (req, res) => {
    const q = await pool.query(`
      SELECT te.id, te.tier, te.status, te.created_at, te.alerted_at, te.resolved_at, te.notes,
             m.source, m.source_url, m.author_handle, m.posted_at, m.body_excerpt,
             t.name AS target_name, t.kind AS target_kind
      FROM threat_events te
      JOIN mentions m ON m.id = te.mention_id
      LEFT JOIN targets t ON t.id = te.target_id
      WHERE te.customer_id = $1
      ORDER BY te.tier DESC, te.created_at DESC
      LIMIT 5000
    `, [req.customer.id]);
    const cols = ['id','tier','status','created_at','alerted_at','resolved_at','notes',
                  'source','source_url','author_handle','posted_at','body_excerpt',
                  'target_name','target_kind'];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sentinel-threats-${new Date().toISOString().slice(0,10)}.csv"`);
    res.write(cols.join(',') + '\n');
    for (const row of q.rows) res.write(cols.map(c => csvCell(row[c])).join(',') + '\n');
    res.end();
  });

  // ── Targets bulk import ────────────────────────────────────────────
  r.post('/dashboard/targets/bulk-import', authed, express.urlencoded({ extended: false, limit: '256kb' }), async (req, res) => {
    const text = (req.body.bulk || '').trim();
    if (!text) return res.redirect('/dashboard/settings?err=No+input');

    let parsed;
    let format;
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) parsed = [parsed];
        format = 'json';
      } catch (e) {
        return res.redirect('/dashboard/settings?err=Invalid+JSON%3A+' + encodeURIComponent(e.message.slice(0, 80)));
      }
    } else {
      // Plaintext: each non-empty line is a target name. No aliases or search_terms.
      parsed = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(name => ({ name, kind: 'candidate' }));
      format = 'plaintext';
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const t of parsed) {
      if (!t || !t.name) { skipped++; continue; }
      const kindRaw = String(t.kind || 'candidate').trim();
      const kind = ['candidate','family','staff','surrogate','opponent'].includes(kindRaw) ? kindRaw : 'candidate';
      const aliases = Array.isArray(t.aliases) ? t.aliases : [];
      const search_terms = Array.isArray(t.search_terms) ? t.search_terms : [];
      const r2 = await pool.query(`
        INSERT INTO targets (customer_id, kind, name, aliases, search_terms)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
        ON CONFLICT (customer_id, name) DO UPDATE
        SET kind = EXCLUDED.kind, aliases = EXCLUDED.aliases, search_terms = EXCLUDED.search_terms
        RETURNING (xmax = 0) AS inserted
      `, [req.customer.id, kind, t.name, JSON.stringify(aliases), JSON.stringify(search_terms)]);
      if (r2.rows[0].inserted) created++; else updated++;
    }
    res.redirect(`/dashboard/settings?ok=Imported+${created}+new+%2F+${updated}+updated+%28${format}%29${skipped ? '+%2F+' + skipped + '+skipped' : ''}`);
  });

  // ── Mention detail ─────────────────────────────────────────────────
  r.get('/dashboard/mentions/:id', authed, async (req, res) => {
    const q = await pool.query(`
      SELECT m.*, t.name AS target_name, t.kind AS target_kind
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.id = $1 AND m.customer_id = $2
      LIMIT 1
    `, [req.params.id, req.customer.id]);
    if (!q.rowCount) return res.status(404).send('not found');
    const m = q.rows[0];

    const bumpBanner = m.tier_bumped
      ? `<div style="background:#3d301a;border-left:3px solid #d8902f;padding:10px 14px;margin:14px 0;font-size:13px">
           <strong style="color:#d8902f">⚠ Auto-tier-bumped:</strong> classifier originally rated this T${m.original_tier ?? '?'};
           bumped to T${m.threat_tier} because <code>${escapeHtml(m.bump_reason || '')}</code>.
           This is the author-watch repeat-offender heuristic.
         </div>` : '';
    const body = `
      <a href="/dashboard/mentions" class="muted">← all mentions</a>
      <h1 style="margin-top:14px">${tierPill(m.threat_tier)} ${escapeHtml(m.target_name || '—')}</h1>
      <div class="muted">${escapeHtml(TIER_LABELS[m.threat_tier] || '')}</div>
      ${bumpBanner}

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

  // ── Tier-2 review queue ───────────────────────────────────────────
  // Tier-2 mentions land here (per THREAT_TAXONOMY: hostile rhetoric
  // without specific threats). Reviewer dismisses, escalates to T3,
  // or files under "ongoing campaign" for trend tracking.
  r.get('/dashboard/review-queue', authed, async (req, res) => {
    const filter = req.query.filter || 'pending';
    const valid = ['pending', 'dismissed', 'escalated', 'ongoing_campaign', 'all'];
    const useFilter = valid.includes(filter) ? filter : 'pending';
    const args = [req.customer.id];
    let where = '';
    if (useFilter !== 'all') {
      args.push(useFilter);
      where = `AND m.review_status = $${args.length}`;
    } else {
      where = `AND m.review_status IS NOT NULL`;
    }
    const q = await pool.query(`
      SELECT m.id, m.threat_tier, m.source, m.source_url, m.posted_at, m.body_excerpt,
             m.rationale, m.review_status, m.reviewed_at, m.reviewed_by,
             t.name AS target_name
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.customer_id = $1 ${where}
      ORDER BY m.ingested_at ASC
      LIMIT 200
    `, args);

    const filterPill = (val, label) =>
      `<a href="/dashboard/review-queue?filter=${val}" class="pill" style="background:${useFilter === val ? '#a07f1a' : '#1c2330'};color:${useFilter === val ? '#fff' : '#8b949e'};margin-right:6px">${escapeHtml(label)}</a>`;

    const rows = q.rows.map(m => `
      <tr>
        <td>${tierPill(m.threat_tier)}</td>
        <td>${escapeHtml(m.target_name || '—')}</td>
        <td>${escapeHtml(m.source)}</td>
        <td>${escapeHtml((m.body_excerpt || '').slice(0, 160))}</td>
        <td class="muted">${fmtTime(m.posted_at)}</td>
        <td><span class="status-pill">${escapeHtml(m.review_status || '—')}</span></td>
        <td><a href="/dashboard/review-queue/${m.id}">open</a></td>
      </tr>
    `).join('');

    const body = `
      <h1>Review queue</h1>
      <div class="muted">Tier-2 mentions per the classifier. Reviewer dismisses, escalates to T3 (real-time alert), or files under ongoing-campaign for trend tracking.</div>
      <div style="margin:18px 0">
        ${filterPill('pending', 'pending')}
        ${filterPill('escalated', 'escalated')}
        ${filterPill('dismissed', 'dismissed')}
        ${filterPill('ongoing_campaign', 'ongoing campaign')}
        ${filterPill('all', 'all')}
      </div>
      <div class="muted" style="font-size:12px">${q.rowCount} mention${q.rowCount === 1 ? '' : 's'}</div>
      ${q.rowCount ? `<table style="margin-top:8px">
        <thead><tr><th>Tier</th><th>Target</th><th>Source</th><th>Excerpt</th><th>Posted</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">Nothing in this filter.</div>'}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Review queue', customer: req.customer, body, active: 'review-queue' }));
  });

  r.get('/dashboard/review-queue/:id', authed, async (req, res) => {
    const q = await pool.query(`
      SELECT m.*, t.name AS target_name, t.kind AS target_kind
      FROM mentions m
      LEFT JOIN targets t ON t.id = m.target_id
      WHERE m.id = $1 AND m.customer_id = $2
      LIMIT 1
    `, [req.params.id, req.customer.id]);
    if (!q.rowCount) return res.status(404).send('not found');
    const m = q.rows[0];

    const isPending = m.review_status === 'pending';
    const actions = isPending ? `
      <form method="POST" action="/dashboard/review-queue/${m.id}/action">
        <div class="field">
          <label for="note">Note (optional — adds to audit trail)</label>
          <textarea id="note" name="note" rows="2" style="width:100%;background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;font-family:inherit;font-size:14px" placeholder="Why this disposition?"></textarea>
        </div>
        <div class="actions">
          <button type="submit" name="action" value="dismissed" class="secondary">Dismiss (not actionable)</button>
          <button type="submit" name="action" value="ongoing_campaign" class="secondary">File under ongoing campaign</button>
          <button type="submit" name="action" value="escalated" class="danger">Escalate to Tier 3 (real-time alert)</button>
        </div>
      </form>
    ` : `<div class="muted">Already reviewed: <strong>${escapeHtml(m.review_status)}</strong>${m.reviewed_at ? ` at ${fmtTime(m.reviewed_at)}` : ''}${m.reviewed_by ? ` by ${escapeHtml(m.reviewed_by)}` : ''}.</div>`;

    const body = `
      <a href="/dashboard/review-queue" class="muted">← review queue</a>
      <h1 style="margin-top:14px">${tierPill(m.threat_tier)} ${escapeHtml(m.target_name || '—')}</h1>
      <div class="muted">Tier 2 — hostile rhetoric · status: ${escapeHtml(m.review_status || '—')}</div>

      <div class="card" style="margin-top:20px">
        <div class="key-value">
          <div>target</div><div>${escapeHtml(m.target_name || '—')} (${escapeHtml(m.target_kind || '—')})</div>
          <div>source</div><div>${escapeHtml(m.source)}</div>
          <div>author</div><div>${escapeHtml(m.author_handle || '—')}</div>
          <div>posted</div><div>${fmtTime(m.posted_at)}</div>
          <div>ingested</div><div>${fmtTime(m.ingested_at)}</div>
          <div>url</div><div><a href="${escapeHtml(m.source_url)}" target="_blank" rel="noopener">${escapeHtml(m.source_url || '—')}</a></div>
          <div>evidence</div><div><code>${escapeHtml(m.s3_key || '—')}</code></div>
        </div>
      </div>

      <h2>Content</h2>
      <div class="body-excerpt">${escapeHtml(m.body_excerpt || '')}</div>

      <h2>Classifier rationale</h2>
      <div class="body-excerpt">${escapeHtml(m.rationale || '—')}</div>

      <h2>Action</h2>
      ${actions}

      ${m.review_notes ? `<h2>Audit trail</h2>
        <div class="body-excerpt" style="font-size:13px">${escapeHtml(m.review_notes)}</div>` : ''}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Review', customer: req.customer, body, active: 'review-queue' }));
  });

  r.post('/dashboard/review-queue/:id/action', authed, express.urlencoded({ extended: false }), async (req, res) => {
    const action = req.body.action;
    const note = (req.body.note || '').trim().slice(0, 1000);
    const valid = ['dismissed', 'escalated', 'ongoing_campaign'];
    if (!valid.includes(action)) return res.status(400).send('bad action');
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    const actor = req.customer.name || req.customer.id;
    const entry = `[${stamp}] [${actor}] → ${action}${note ? ' — ' + note : ''}`;

    // Update mention review state.
    await pool.query(`
      UPDATE mentions
      SET review_status = $2,
          reviewed_at = NOW(),
          reviewed_by = $3,
          review_notes = CASE WHEN review_notes IS NULL OR review_notes = '' THEN $4 ELSE review_notes || E'\\n' || $4 END
      WHERE id = $1 AND customer_id = $5
    `, [req.params.id, action, actor, entry, req.customer.id]);

    // Capture as classifier feedback (ground truth for drift detection).
    await recordClassifierFeedback(pool, { mentionId: req.params.id, customerId: req.customer.id, action, actor, note });

    // If escalated, create a tier-3 threat_event so the alert worker
    // picks it up. Idempotent: skip if one already exists.
    if (action === 'escalated') {
      const existing = await pool.query('SELECT id FROM threat_events WHERE mention_id = $1 LIMIT 1', [req.params.id]);
      if (!existing.rowCount) {
        const m = await pool.query('SELECT target_id FROM mentions WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id]);
        await pool.query(`
          INSERT INTO threat_events (mention_id, customer_id, target_id, tier, status)
          VALUES ($1, $2, $3, 3, 'open')
        `, [req.params.id, req.customer.id, m.rows[0]?.target_id || null]);
      }
    }
    res.redirect('/dashboard/review-queue');
  });

  // ── Settings: targets + emails + password ─────────────────────────
  r.get('/dashboard/settings', authed, async (req, res) => {
    const targets = await pool.query(`
      SELECT id, kind, name, aliases, search_terms FROM targets
      WHERE customer_id = $1 ORDER BY kind, name
    `, [req.customer.id]);

    const targetRows = targets.rows.map(t => `
      <tr>
        <td><span class="status-pill">${escapeHtml(t.kind || 'candidate')}</span></td>
        <td><strong>${escapeHtml(t.name)}</strong></td>
        <td>${escapeHtml((Array.isArray(t.aliases) ? t.aliases : []).join(', ') || '—')}</td>
        <td>${escapeHtml((Array.isArray(t.search_terms) ? t.search_terms : []).join(', ') || '—')}</td>
        <td><a href="/dashboard/targets/${t.id}">edit</a></td>
        <td>
          <form method="POST" action="/dashboard/targets/${t.id}/delete" onsubmit="return confirm('Delete target ${escapeHtml(t.name)}? This stops monitoring it but does not delete past mentions.');" style="display:inline">
            <button type="submit" class="danger" style="padding:4px 8px;font-size:12px">delete</button>
          </form>
        </td>
      </tr>
    `).join('');

    const flash = req.query.ok ? { kind: 'ok', text: req.query.ok } : (req.query.err ? { kind: 'err', text: req.query.err } : null);

    const body = `
      <h1>Settings</h1>
      <div class="muted">${escapeHtml(req.customer.name)}</div>

      <h2>Monitoring targets</h2>
      ${targets.rowCount ? `<table>
        <thead><tr><th>Kind</th><th>Name</th><th>Aliases</th><th>Search terms</th><th></th><th></th></tr></thead>
        <tbody>${targetRows}</tbody>
      </table>` : '<div class="empty">No targets yet.</div>'}
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
        <a href="/dashboard/targets/new"><button type="button">+ Add target</button></a>
        <a href="/dashboard/mentions.csv"><button type="button" class="secondary">↓ Export mentions CSV</button></a>
        <a href="/dashboard/threats.csv"><button type="button" class="secondary">↓ Export threats CSV</button></a>
        <a href="/dashboard/compliance-report"><button type="button" class="secondary">📄 Compliance report (print to PDF)</button></a>
      </div>

      <h2>Bulk import targets</h2>
      <form method="POST" action="/dashboard/targets/bulk-import">
        <div class="muted" style="margin-bottom:6px;font-size:13px">
          Paste a JSON array of target objects, OR one target name per line. JSON supports the full schema:
          <code style="background:#0a0f1a;padding:2px 6px;border-radius:3px">{"kind":"candidate","name":"Jane Doe","aliases":["Doe"],"search_terms":["Jane Doe"]}</code>
        </div>
        <div class="field">
          <textarea name="bulk" rows="6" placeholder='Either:&#10;Jane Doe&#10;John Smith&#10;&#10;Or:&#10;[&#10;  {"kind":"candidate","name":"Jane Doe","aliases":["Doe"],"search_terms":["Jane Doe"]},&#10;  {"kind":"family","name":"John Doe"}&#10;]' style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px 12px;border-radius:4px;font-size:13px;width:100%;font-family:monospace"></textarea>
        </div>
        <button type="submit" class="secondary">Import</button>
      </form>

      <h2>Alert routes</h2>
      <div class="muted" style="font-size:13px;margin-bottom:10px">
        Route Tier-3+ alerts to additional destinations (Slack/PagerDuty/Discord webhook, extra emails).
        If no routes are configured here, alerts go to <code style="background:#0a0f1a;padding:2px 6px;border-radius:3px">${escapeHtml(req.customer.alert_email || 'alert email below')}</code>.
      </div>
      ${await renderAlertRoutes(pool, req.customer.id)}
      <details style="margin-top:14px">
        <summary style="cursor:pointer;color:#4f9af0;font-size:14px;padding:8px 0">+ Add alert route</summary>
        <form method="POST" action="/dashboard/settings/alert-routes" style="margin-top:10px;background:#0e1422;padding:14px;border:1px solid #1c2330;border-radius:6px">
          <div class="field">
            <label for="channel">Channel</label>
            <select id="channel" name="channel" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
              <option value="email">email</option>
              <option value="webhook">webhook (Slack / PagerDuty / Discord / custom)</option>
            </select>
          </div>
          <div class="field">
            <label for="destination">Destination (email address OR webhook URL)</label>
            <input id="destination" name="destination" type="text" required placeholder="ops@campaign.com  OR  https://hooks.slack.com/services/..." style="font-size:13px;font-family:monospace">
          </div>
          <div class="field">
            <label for="label">Label (optional, for your reference)</label>
            <input id="label" name="label" type="text" placeholder="Slack #threats">
          </div>
          <div class="field">
            <label for="min_tier">Minimum tier</label>
            <select id="min_tier" name="min_tier" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px;border-radius:4px;width:100%;font-size:14px">
              <option value="3" selected>Tier 3+ (credible threats and above)</option>
              <option value="4">Tier 4 only (imminent violence)</option>
            </select>
          </div>
          <button type="submit">Add route</button>
        </form>
      </details>

      <h2>Alert + digest emails</h2>
      <form method="POST" action="/dashboard/settings/emails">
        <div class="field">
          <label for="contact_email">Contact email (login + general)</label>
          <input id="contact_email" name="contact_email" type="email" value="${escapeHtml(req.customer.contact_email || '')}" required>
        </div>
        <div class="field">
          <label for="alert_email">Tier 3+ alert email (real-time)</label>
          <input id="alert_email" name="alert_email" type="email" value="${escapeHtml(req.customer.alert_email || '')}" required>
        </div>
        <div class="field">
          <label for="digest_email">Daily digest email (7am UTC)</label>
          <input id="digest_email" name="digest_email" type="email" value="${escapeHtml(req.customer.digest_email || '')}" required>
        </div>
        <button type="submit">Save</button>
      </form>

      <h2>Change password</h2>
      <form method="POST" action="/dashboard/settings/password">
        <div class="field">
          <label for="current_password">Current password</label>
          <input id="current_password" name="current_password" type="password" required>
        </div>
        <div class="field">
          <label for="new_password">New password (≥ 8 chars)</label>
          <input id="new_password" name="new_password" type="password" required minlength="8">
        </div>
        <div class="field">
          <label for="confirm_password">Confirm new password</label>
          <input id="confirm_password" name="confirm_password" type="password" required minlength="8">
        </div>
        <button type="submit">Change password</button>
      </form>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Settings', customer: req.customer, body, active: 'settings', flash }));
  });

  r.post('/dashboard/settings/emails', authed, express.urlencoded({ extended: false }), async (req, res) => {
    const c = req.body.contact_email?.trim();
    const a = req.body.alert_email?.trim();
    const d = req.body.digest_email?.trim();
    if (!c || !a || !d) return res.redirect('/dashboard/settings?err=All+fields+required');
    await pool.query(`UPDATE customers SET contact_email = $1, alert_email = $2, digest_email = $3 WHERE id = $4`,
      [c, a, d, req.customer.id]);
    res.redirect('/dashboard/settings?ok=Emails+updated');
  });

  // ── Alert routes management ────────────────────────────────────────
  r.post('/dashboard/settings/alert-routes', authed, express.urlencoded({ extended: false }), async (req, res) => {
    const channel = req.body.channel;
    const destination = (req.body.destination || '').trim();
    const label = (req.body.label || '').trim() || null;
    const minTier = parseInt(req.body.min_tier, 10) || 3;
    if (!['email', 'webhook'].includes(channel)) return res.redirect('/dashboard/settings?err=Invalid+channel');
    if (!destination) return res.redirect('/dashboard/settings?err=Destination+required');
    if (channel === 'email' && !/.+@.+\..+/.test(destination)) return res.redirect('/dashboard/settings?err=Invalid+email');
    if (channel === 'webhook' && !/^https?:\/\//i.test(destination)) return res.redirect('/dashboard/settings?err=Webhook+URL+must+start+with+http(s)');
    if (![3, 4].includes(minTier)) return res.redirect('/dashboard/settings?err=Invalid+tier');
    const secret = channel === 'webhook' ? generateWebhookSecret() : null;
    await pool.query(`
      INSERT INTO alert_routes (customer_id, channel, destination, min_tier, label, secret, active)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
    `, [req.customer.id, channel, destination, minTier, label, secret]);
    res.redirect('/dashboard/settings?ok=Alert+route+added' + (channel === 'webhook' ? '+%E2%80%94+secret+shown+once+below' : ''));
  });

  r.post('/dashboard/settings/alert-routes/:id/delete', authed, express.urlencoded({ extended: false }), async (req, res) => {
    await pool.query('DELETE FROM alert_routes WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id]);
    res.redirect('/dashboard/settings?ok=Alert+route+removed');
  });

  r.post('/dashboard/settings/alert-routes/:id/toggle', authed, express.urlencoded({ extended: false }), async (req, res) => {
    await pool.query('UPDATE alert_routes SET active = NOT active WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id]);
    res.redirect('/dashboard/settings?ok=Alert+route+toggled');
  });

  r.post('/dashboard/settings/alert-routes/:id/rotate-secret', authed, express.urlencoded({ extended: false }), async (req, res) => {
    const newSecret = generateWebhookSecret();
    await pool.query('UPDATE alert_routes SET secret = $1 WHERE id = $2 AND customer_id = $3 AND channel = \'webhook\'', [newSecret, req.params.id, req.customer.id]);
    res.redirect('/dashboard/settings?ok=Webhook+secret+rotated+%E2%80%94+update+your+receiver');
  });

  // Send a synthetic test alert through the route (handy for verifying
  // a webhook endpoint integration before the first real threat fires).
  r.post('/dashboard/settings/alert-routes/:id/test', authed, express.urlencoded({ extended: false }), async (req, res) => {
    const q = await pool.query('SELECT * FROM alert_routes WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id]);
    if (!q.rowCount) return res.redirect('/dashboard/settings?err=Route+not+found');
    const route = q.rows[0];
    const out = await sendThreatAlert({
      channel: route.channel,
      destination: route.destination,
      secret: route.secret,
      customerId: req.customer.id,
      eventId: 'test-' + Date.now(),
      tier: 3,
      target: { name: '(synthetic test target)', kind: 'candidate' },
      customer: { name: req.customer.name },
      mention: {
        source: 'synth',
        source_url: 'https://example.com/synth',
        body_excerpt: 'This is a Sentinel test alert. If you received this, your alert route is working.',
        posted_at: new Date(),
        author_handle: 'sentinel-test',
        s3_key: null
      },
      rationale: 'Synthetic test fired from the dashboard'
    });
    if (out.ok) {
      await pool.query('UPDATE alert_routes SET last_sent_at = NOW(), last_error = NULL WHERE id = $1', [route.id]);
      res.redirect('/dashboard/settings?ok=Test+alert+sent' + (out.dryRun ? '+%28dry-run%3A+RESEND_API_KEY+not+set%29' : ''));
    } else {
      await pool.query('UPDATE alert_routes SET last_error = $2 WHERE id = $1', [route.id, out.error?.slice(0, 500)]);
      res.redirect('/dashboard/settings?err=' + encodeURIComponent('Test failed: ' + out.error?.slice(0, 100)));
    }
  });

  r.post('/dashboard/settings/password', authed, express.urlencoded({ extended: false }), async (req, res) => {
    const cur = req.body.current_password || '';
    const next = req.body.new_password || '';
    const confirm = req.body.confirm_password || '';
    if (!cur || !next || next !== confirm) return res.redirect('/dashboard/settings?err=Passwords+do+not+match');
    if (next.length < 8) return res.redirect('/dashboard/settings?err=Password+must+be+%E2%89%A5+8+chars');
    const q = await pool.query('SELECT password_hash FROM customers WHERE id = $1', [req.customer.id]);
    const ok = await verifyPassword(cur, q.rows[0]?.password_hash || '');
    if (!ok) return res.redirect('/dashboard/settings?err=Current+password+wrong');
    const hash = await hashPassword(next);
    await pool.query('UPDATE customers SET password_hash = $1 WHERE id = $2', [hash, req.customer.id]);
    res.redirect('/dashboard/settings?ok=Password+changed');
  });

  // ── Target add/edit/delete ─────────────────────────────────────────
  r.get('/dashboard/targets/new', authed, (req, res) => {
    const body = renderTargetForm({ kind: 'candidate', name: '', aliases: [], search_terms: [] }, '/dashboard/targets/new', 'New target');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'New target', customer: req.customer, body, active: 'settings' }));
  });

  r.post('/dashboard/targets/new', authed, express.urlencoded({ extended: false }), async (req, res) => {
    const t = parseTargetForm(req.body);
    if (!t.name) return res.redirect('/dashboard/settings?err=Target+name+required');
    await pool.query(`
      INSERT INTO targets (customer_id, kind, name, aliases, search_terms)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      ON CONFLICT (customer_id, name) DO UPDATE
      SET kind = EXCLUDED.kind, aliases = EXCLUDED.aliases, search_terms = EXCLUDED.search_terms
    `, [req.customer.id, t.kind, t.name, JSON.stringify(t.aliases), JSON.stringify(t.search_terms)]);
    res.redirect('/dashboard/settings?ok=Target+saved');
  });

  r.get('/dashboard/targets/:id', authed, async (req, res) => {
    const q = await pool.query(`SELECT id, kind, name, aliases, search_terms FROM targets WHERE id = $1 AND customer_id = $2`, [req.params.id, req.customer.id]);
    if (!q.rowCount) return res.status(404).send('not found');
    const t = q.rows[0];
    const body = renderTargetForm({
      kind: t.kind || 'candidate',
      name: t.name,
      aliases: Array.isArray(t.aliases) ? t.aliases : [],
      search_terms: Array.isArray(t.search_terms) ? t.search_terms : []
    }, `/dashboard/targets/${t.id}`, 'Edit target');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(layout({ title: 'Edit target', customer: req.customer, body, active: 'settings' }));
  });

  r.post('/dashboard/targets/:id', authed, express.urlencoded({ extended: false }), async (req, res) => {
    const t = parseTargetForm(req.body);
    if (!t.name) return res.redirect(`/dashboard/targets/${req.params.id}?err=Target+name+required`);
    await pool.query(`
      UPDATE targets SET kind = $1, name = $2, aliases = $3::jsonb, search_terms = $4::jsonb
      WHERE id = $5 AND customer_id = $6
    `, [t.kind, t.name, JSON.stringify(t.aliases), JSON.stringify(t.search_terms), req.params.id, req.customer.id]);
    res.redirect('/dashboard/settings?ok=Target+saved');
  });

  r.post('/dashboard/targets/:id/delete', authed, express.urlencoded({ extended: false }), async (req, res) => {
    // Soft-delete via status would be nicer; for v1 hard-delete is fine,
    // but only if no mentions reference it (otherwise FK breaks).
    // The mentions FK has no ON DELETE, so we set target_id to NULL on
    // those mentions before dropping the target row.
    await pool.query('UPDATE mentions SET target_id = NULL WHERE target_id = $1 AND customer_id = $2', [req.params.id, req.customer.id]);
    await pool.query('UPDATE threat_events SET target_id = NULL WHERE target_id = $1 AND customer_id = $2', [req.params.id, req.customer.id]);
    await pool.query('DELETE FROM targets WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id]);
    res.redirect('/dashboard/settings?ok=Target+deleted');
  });

  return r;
}

async function renderAlertRoutes(pool, customerId) {
  const q = await pool.query(`
    SELECT id, channel, destination, min_tier, active, label, secret, last_sent_at, last_error, created_at
    FROM alert_routes
    WHERE customer_id = $1
    ORDER BY created_at DESC
  `, [customerId]);
  if (!q.rowCount) {
    return '<div class="empty">No custom alert routes. Tier-3+ alerts go to your default alert email.</div>';
  }
  const fmt = (d) => {
    if (!d) return '—';
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  };
  const rows = q.rows.map(r => {
    const isWebhook = r.channel === 'webhook';
    const channelPill = `<span class="status-pill" style="background:${isWebhook ? '#1a3a5c' : '#1c2330'};color:#cfe5ff">${escapeHtml(r.channel)}</span>`;
    const active = r.active ? '<span class="status-pill" style="background:#1a4a1a;color:#7fff7f">active</span>' : '<span class="status-pill" style="background:#3d301a;color:#d8902f">paused</span>';
    const secretBlock = isWebhook && r.secret ? `<div class="muted" style="margin-top:6px;font-size:12px">
      <strong>HMAC secret</strong> (verify <code>X-Sentinel-Signature: sha256=&lt;hmac&gt;</code> against the request body):
      <div style="background:#0a0f1a;padding:6px 10px;border:1px solid #1c2330;border-radius:3px;font-family:monospace;word-break:break-all;margin-top:4px">${escapeHtml(r.secret)}</div>
    </div>` : '';
    const lastError = r.last_error ? `<div class="muted" style="color:#ff7080;font-size:12px;margin-top:6px"><strong>last error:</strong> ${escapeHtml(r.last_error.slice(0, 200))}</div>` : '';
    return `<div class="card" style="margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        ${channelPill}
        <strong style="font-size:14px">${escapeHtml(r.label || r.destination)}</strong>
        <span class="muted" style="font-size:12px">≥ Tier ${r.min_tier}</span>
        ${active}
        <span style="margin-left:auto" class="muted">last sent: ${fmt(r.last_sent_at)}</span>
      </div>
      ${r.label ? `<div class="muted" style="margin-top:4px;font-size:12px;font-family:monospace;word-break:break-all">${escapeHtml(r.destination)}</div>` : ''}
      ${secretBlock}
      ${lastError}
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <form method="POST" action="/dashboard/settings/alert-routes/${r.id}/test"><button type="submit" class="secondary" style="padding:4px 10px;font-size:12px">Send test</button></form>
        <form method="POST" action="/dashboard/settings/alert-routes/${r.id}/toggle"><button type="submit" class="secondary" style="padding:4px 10px;font-size:12px">${r.active ? 'Pause' : 'Resume'}</button></form>
        ${isWebhook ? `<form method="POST" action="/dashboard/settings/alert-routes/${r.id}/rotate-secret" onsubmit="return confirm('Rotate the HMAC secret? You will need to update your receiver.');"><button type="submit" class="secondary" style="padding:4px 10px;font-size:12px">Rotate secret</button></form>` : ''}
        <form method="POST" action="/dashboard/settings/alert-routes/${r.id}/delete" onsubmit="return confirm('Delete this alert route?');"><button type="submit" class="danger" style="padding:4px 10px;font-size:12px">Delete</button></form>
      </div>
    </div>`;
  }).join('');
  return rows;
}

function parseTargetForm(body) {
  const kindRaw = String(body.kind || '').trim();
  const kind = ['candidate', 'family', 'staff', 'surrogate', 'opponent'].includes(kindRaw) ? kindRaw : 'candidate';
  return {
    kind,
    name: String(body.name || '').trim(),
    aliases: csvSplit(body.aliases),
    search_terms: csvSplit(body.search_terms)
  };
}

// Server-rendered 14-day stacked bar chart. Pure SVG, no JS, works
// inside strict CSP. Input: rows of { day, tier, n }.
function renderVolumeChart(rows) {
  const W = 760, H = 160, PAD = 36;
  const days = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  // Index: day → { 1: n, 2: n, 3: n, 4: n }
  const byDay = new Map();
  for (const d of days) byDay.set(d, { 1: 0, 2: 0, 3: 0, 4: 0 });
  for (const r of rows) {
    const key = (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10);
    if (byDay.has(key)) byDay.get(key)[Math.max(1, Math.min(4, r.tier || 1))] += r.n;
  }
  const totals = days.map(d => Object.values(byDay.get(d)).reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const barWidth = (W - 2 * PAD) / days.length;
  const tierColors = { 1: '#5b6573', 2: '#a07f1a', 3: '#7a4a0a', 4: '#7a1019' };

  let bars = '';
  let labels = '';
  let yGrid = '';
  // Y-axis grid lines.
  for (let i = 0; i <= 4; i++) {
    const y = PAD + (H - 2 * PAD) * (i / 4);
    const value = Math.round(max * (1 - i / 4));
    yGrid += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="#1c2330" stroke-width="1"/>`;
    yGrid += `<text x="${PAD - 6}" y="${y + 4}" font-size="10" fill="#5b6573" text-anchor="end">${value}</text>`;
  }
  days.forEach((d, i) => {
    const counts = byDay.get(d);
    const x = PAD + i * barWidth;
    let yCursor = H - PAD;
    for (const tier of [1, 2, 3, 4]) {
      const n = counts[tier];
      if (!n) continue;
      const h = ((H - 2 * PAD) * n) / max;
      bars += `<rect x="${x + 4}" y="${yCursor - h}" width="${barWidth - 8}" height="${h}" fill="${tierColors[tier]}"><title>${d} · T${tier}: ${n}</title></rect>`;
      yCursor -= h;
    }
    // X-axis labels: every other day to avoid clutter.
    if (i % 2 === 0) {
      labels += `<text x="${x + barWidth / 2}" y="${H - PAD + 14}" font-size="10" fill="#5b6573" text-anchor="middle">${d.slice(5)}</text>`;
    }
  });

  const legend = `<g transform="translate(${PAD}, 10)">
    ${[1, 2, 3, 4].map((t, idx) => `
      <rect x="${idx * 80}" y="0" width="10" height="10" fill="${tierColors[t]}"/>
      <text x="${idx * 80 + 14}" y="9" font-size="11" fill="#8b949e">T${t}</text>
    `).join('')}
  </g>`;

  return `<div style="background:#0e1422;border:1px solid #1c2330;border-radius:6px;padding:10px;margin-bottom:14px;overflow-x:auto">
    <svg viewBox="0 0 ${W} ${H + 30}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block;max-height:200px">
      ${yGrid}
      ${bars}
      ${labels}
      ${legend}
    </svg>
  </div>`;
}

// CSV cell escaper. Wraps anything containing comma, quote, or newline in
// double quotes; doubles internal quotes per RFC 4180.
function csvCell(v) {
  if (v == null) return '';
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvSplit(s) {
  return String(s || '')
    .split(/[\n,]/)
    .map(x => x.trim())
    .filter(Boolean);
}

function renderTargetForm(t, action, title) {
  return `
    <a href="/dashboard/settings" class="muted">← settings</a>
    <h1 style="margin-top:14px">${escapeHtml(title)}</h1>
    <form method="POST" action="${escapeHtml(action)}">
      <div class="field">
        <label for="kind">Kind</label>
        <select id="kind" name="kind" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px 12px;border-radius:4px;font-size:14px;width:100%">
          ${['candidate','family','staff','surrogate','opponent'].map(k => `<option value="${k}" ${t.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="name">Full name</label>
        <input id="name" name="name" type="text" value="${escapeHtml(t.name)}" required placeholder="Jane Doe">
      </div>
      <div class="field">
        <label for="aliases">Aliases (comma- or newline-separated; matched against post body, NOT used for search queries)</label>
        <textarea id="aliases" name="aliases" rows="2" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px 12px;border-radius:4px;font-size:14px;width:100%;font-family:inherit">${escapeHtml((t.aliases || []).join(', '))}</textarea>
      </div>
      <div class="field">
        <label for="search_terms">Search terms (multi-word phrases used to query Reddit / Bluesky / Google News / X)</label>
        <textarea id="search_terms" name="search_terms" rows="2" style="background:#0a0f1a;border:1px solid #1c2330;color:#e6edf3;padding:10px 12px;border-radius:4px;font-size:14px;width:100%;font-family:inherit">${escapeHtml((t.search_terms || []).join(', '))}</textarea>
      </div>
      <button type="submit">Save</button>
      <a href="/dashboard/settings" style="margin-left:10px"><button type="button" class="secondary">Cancel</button></a>
    </form>
  `;
}

module.exports = build;
