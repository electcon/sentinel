// tests/auth.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Set SESSION_SECRET before requiring lib/auth so signSession works.
process.env.SESSION_SECRET = 'test-secret-do-not-use-in-prod';

const {
  hashPassword, verifyPassword,
  signSession, verifySession
} = require('../lib/auth');

test('hashPassword + verifyPassword round-trip', async () => {
  const hash = await hashPassword('correct-horse-battery');
  assert.ok(hash.startsWith('scrypt$'));
  assert.ok(await verifyPassword('correct-horse-battery', hash));
  assert.ok(!(await verifyPassword('wrong-password', hash)));
});

test('hashPassword: rejects short passwords', async () => {
  await assert.rejects(() => hashPassword('short'));
  await assert.rejects(() => hashPassword(''));
});

test('verifyPassword: rejects malformed stored hash', async () => {
  assert.ok(!(await verifyPassword('any', '')));
  assert.ok(!(await verifyPassword('any', 'not-scrypt-format')));
  assert.ok(!(await verifyPassword('any', 'scrypt$bad$format')));
});

test('hashPassword: different salts produce different hashes', async () => {
  const h1 = await hashPassword('same-password-1');
  const h2 = await hashPassword('same-password-1');
  assert.notEqual(h1, h2);
  // But both verify the same plaintext.
  assert.ok(await verifyPassword('same-password-1', h1));
  assert.ok(await verifyPassword('same-password-1', h2));
});

test('signSession + verifySession round-trip', () => {
  const exp = Date.now() + 60_000;
  const token = signSession({ customerId: 'cust-1', expiresAt: exp });
  const sess = verifySession(token);
  assert.equal(sess.customerId, 'cust-1');
  assert.equal(sess.expiresAt, exp);
});

test('verifySession: rejects expired tokens', () => {
  const expired = signSession({ customerId: 'cust-1', expiresAt: Date.now() - 1000 });
  assert.equal(verifySession(expired), null);
});

test('verifySession: rejects tampered tokens', () => {
  const exp = Date.now() + 60_000;
  const token = signSession({ customerId: 'cust-1', expiresAt: exp });
  // Flip a character in the payload portion.
  const tampered = 'X' + token.slice(1);
  assert.equal(verifySession(tampered), null);
});

test('verifySession: rejects bad signature', () => {
  const exp = Date.now() + 60_000;
  const token = signSession({ customerId: 'cust-1', expiresAt: exp });
  const [b64, sig] = token.split('.');
  const tampered = b64 + '.' + sig.slice(0, -1) + 'X';
  assert.equal(verifySession(tampered), null);
});

test('verifySession: handles missing/empty token', () => {
  assert.equal(verifySession(null), null);
  assert.equal(verifySession(''), null);
  assert.equal(verifySession('not.a.token'), null);
});
