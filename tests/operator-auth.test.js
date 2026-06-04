// tests/operator-auth.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// SESSION_SECRET is read at module-load time, so set it before requiring.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { signSession, verifySession } = require('../lib/operator-auth');

test('signSession + verifySession: round-trip a fresh session', () => {
  const exp = Date.now() + 60_000;
  const tok = signSession({ operatorId: 42, expiresAt: exp });
  const sess = verifySession(tok);
  assert.ok(sess, 'session should verify');
  assert.equal(sess.operatorId, 42);
  assert.equal(sess.expiresAt, exp);
});

test('verifySession: rejects expired sessions', () => {
  const tok = signSession({ operatorId: 1, expiresAt: Date.now() - 1 });
  assert.equal(verifySession(tok), null);
});

test('verifySession: rejects tampered payload', () => {
  const tok = signSession({ operatorId: 1, expiresAt: Date.now() + 60_000 });
  const [b64, sig] = tok.split('.');
  // Flip a byte in payload — sig will no longer match.
  const tampered = b64.slice(0, -1) + (b64.slice(-1) === 'a' ? 'b' : 'a') + '.' + sig;
  assert.equal(verifySession(tampered), null);
});

test('verifySession: rejects tampered signature', () => {
  const tok = signSession({ operatorId: 1, expiresAt: Date.now() + 60_000 });
  const [b64, sig] = tok.split('.');
  const tampered = b64 + '.' + sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');
  assert.equal(verifySession(tampered), null);
});

test('verifySession: rejects malformed tokens', () => {
  assert.equal(verifySession(null), null);
  assert.equal(verifySession(''), null);
  assert.equal(verifySession('not-a-token'), null);
  assert.equal(verifySession('.'), null);
  assert.equal(verifySession('a.b.c'), null);
});

test('verifySession: rejects token signed with a different secret', () => {
  // Sign with current secret, then swap secret and try to verify.
  const tok = signSession({ operatorId: 1, expiresAt: Date.now() + 60_000 });
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'other-secret';
  // Re-require to pick up new secret.
  const p = require.resolve('../lib/operator-auth');
  delete require.cache[p];
  const fresh = require('../lib/operator-auth');
  try {
    assert.equal(fresh.verifySession(tok), null);
  } finally {
    process.env.SESSION_SECRET = prev;
    delete require.cache[p];
    require('../lib/operator-auth');
  }
});

test('signSession: distinct operatorIds produce distinct tokens', () => {
  const exp = Date.now() + 60_000;
  const a = signSession({ operatorId: 1, expiresAt: exp });
  const b = signSession({ operatorId: 2, expiresAt: exp });
  assert.notEqual(a, b);
});

test('signSession: same inputs produce identical tokens (deterministic HMAC)', () => {
  const exp = Date.now() + 60_000;
  const a = signSession({ operatorId: 7, expiresAt: exp });
  const b = signSession({ operatorId: 7, expiresAt: exp });
  assert.equal(a, b);
});
