// lib/auth.js
// Customer auth: scrypt password hashing + signed-cookie sessions.
// One customer = one shared password (chief of staff + ops can share).
// Self-serve signup is v2; v1 onboarding is via scripts/provision-customer.js.

'use strict';

const crypto = require('crypto');

const SESSION_COOKIE = 'sentinel_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.SMOKE_TOKEN || '';

// ── Password hashing (scrypt, built into Node — no bcrypt dep) ─────
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 16;

async function hashPassword(password) {
  if (!password || password.length < 8) throw new Error('password must be ≥ 8 chars');
  const salt = crypto.randomBytes(SCRYPT_SALT_LEN);
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => {
      if (err) return reject(err); resolve(key);
    });
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!password || !stored || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const N = parseInt(parts[1], 10), r = parseInt(parts[2], 10), p = parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, { N, r, p }, (err, key) => {
      if (err) return reject(err); resolve(key);
    });
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// ── Session cookies (signed payload, HTTP-only, secure in prod) ────
function signSession({ customerId, expiresAt }) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET not set');
  const payload = JSON.stringify({ c: customerId, e: expiresAt });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySession(token) {
  if (!token || !SESSION_SECRET) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); }
  catch (_) { return null; }
  if (!payload || !payload.c || !payload.e) return null;
  if (payload.e < Date.now()) return null;
  return { customerId: payload.c, expiresAt: payload.e };
}

function setSessionCookie(res, customerId) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const token = signSession({ customerId, expiresAt });
  const isProd = process.env.NODE_ENV === 'production';
  const cookie = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    isProd ? 'Secure' : '',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ].filter(Boolean).join('; ');
  res.append('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookie = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    isProd ? 'Secure' : '',
    'SameSite=Lax',
    'Max-Age=0'
  ].filter(Boolean).join('; ');
  res.append('Set-Cookie', cookie);
}

function readSessionCookie(req) {
  const header = req.headers.cookie || '';
  const parts = header.split(/; */);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    if (name === SESSION_COOKIE) {
      try { return decodeURIComponent(p.slice(eq + 1).trim()); } catch (_) { return null; }
    }
  }
  return null;
}

// Express middleware: attaches req.customer if a valid session exists,
// otherwise redirects to /login (for HTML routes) or returns 401 (for /api).
function requireCustomerAuth(pool) {
  return async function (req, res, next) {
    const token = readSessionCookie(req);
    const sess = verifySession(token);
    if (!sess) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    try {
      const r = await pool.query('SELECT id, name, alert_email, digest_email, status FROM customers WHERE id = $1', [sess.customerId]);
      if (!r.rowCount) {
        clearSessionCookie(res);
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'session invalid' });
        return res.redirect('/login');
      }
      req.customer = r.rows[0];
      next();
    } catch (e) {
      next(e);
    }
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
  requireCustomerAuth,
  SESSION_COOKIE
};
