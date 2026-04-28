// lib/operator-auth.js
// Multi-operator authentication for /admin and /admin/soc. Separate
// session cookie from the customer-side auth (different cookie name +
// path) so a customer can't access /admin even if their session is
// valid on /dashboard, and vice-versa.
//
// scrypt password hashing — same params as lib/auth.js so we can swap
// helpers if needed.

'use strict';

const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./auth');

const SESSION_COOKIE = 'sentinel_op_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;     // 24h — shorter than customer (90d) since operator access is higher-stakes
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.SMOKE_TOKEN || '';

function signSession({ operatorId, expiresAt }) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET not set');
  const payload = JSON.stringify({ o: operatorId, e: expiresAt });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySession(token) {
  if (!token || !SESSION_SECRET) return null;
  const [b64, sig] = String(token).split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let p; try { p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!p || !p.o || !p.e) return null;
  if (p.e < Date.now()) return null;
  return { operatorId: p.o, expiresAt: p.e };
}

function setSessionCookie(res, operatorId) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const tok = signSession({ operatorId, expiresAt });
  const isProd = process.env.NODE_ENV === 'production';
  res.append('Set-Cookie', [
    `${SESSION_COOKIE}=${encodeURIComponent(tok)}`,
    'Path=/admin',
    'HttpOnly',
    isProd ? 'Secure' : '',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ].filter(Boolean).join('; '));
}

function clearSessionCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  res.append('Set-Cookie', [
    `${SESSION_COOKIE}=`,
    'Path=/admin',
    'HttpOnly',
    isProd ? 'Secure' : '',
    'SameSite=Lax',
    'Max-Age=0'
  ].filter(Boolean).join('; '));
}

function readSessionCookie(req) {
  const header = req.headers.cookie || '';
  for (const p of header.split(/; */)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq).trim() === SESSION_COOKIE) {
      try { return decodeURIComponent(p.slice(eq + 1).trim()); } catch (_) { return null; }
    }
  }
  return null;
}

// Look up an operator by email + verify password. Returns the operator
// row or null. login_count + last_login_at are updated on success.
async function authenticate(pool, email, password) {
  const e = String(email || '').toLowerCase().trim();
  if (!e || !password) return null;
  const r = await pool.query(`SELECT id, email, name, password_hash, role, active FROM operators WHERE LOWER(email) = $1 LIMIT 1`, [e]);
  if (!r.rowCount || !r.rows[0].active) return null;
  const op = r.rows[0];
  const ok = await verifyPassword(password, op.password_hash);
  if (!ok) return null;
  pool.query('UPDATE operators SET last_login_at = NOW(), login_count = login_count + 1 WHERE id = $1', [op.id]).catch(() => {});
  return { id: op.id, email: op.email, name: op.name, role: op.role };
}

// Express middleware. Tries the operator session cookie FIRST; falls
// back to ADMIN_PASSWORD Basic auth if no operator session present
// (bootstrap path so the user isn't locked out before creating their
// first operator account). Either way, attaches req.operator with
// at minimum {name, role}; bootstrap operator gets name='admin'.
function requireOperator(pool) {
  return async function (req, res, next) {
    // Path 1: operator session cookie
    const tok = readSessionCookie(req);
    const sess = verifySession(tok);
    if (sess) {
      try {
        const r = await pool.query('SELECT id, email, name, role, active FROM operators WHERE id = $1', [sess.operatorId]);
        if (r.rowCount && r.rows[0].active) {
          req.operator = r.rows[0];
          return next();
        }
      } catch (_) { /* fall through to bootstrap */ }
    }

    // Path 2: Bootstrap Basic auth via ADMIN_PASSWORD. Only used until
    // first real operator is created; identity is 'bootstrap'.
    const expected = process.env.ADMIN_PASSWORD || '';
    const header = req.headers.authorization || '';
    if (expected && header.startsWith('Basic ')) {
      let creds;
      try { creds = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch (_) { creds = ''; }
      const [, password] = creds.split(/:(.*)/);
      if (password) {
        const a = Buffer.from(password); const b = Buffer.from(expected);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          req.operator = { id: null, email: null, name: 'bootstrap', role: 'admin', bootstrap: true };
          return next();
        }
      }
    }

    // No valid session and no valid bootstrap — challenge.
    if (req.path.startsWith('/admin/login') || req.path.startsWith('/admin/logout')) {
      // Login routes themselves are public; only requireOperator-gated
      // routes redirect / challenge.
      return next();
    }
    if (req.method === 'GET' && req.accepts('html')) {
      return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
    }
    res.set('WWW-Authenticate', 'Basic realm="Sentinel admin"');
    return res.status(401).send('auth required');
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  authenticate,
  requireOperator,
  SESSION_COOKIE
};
