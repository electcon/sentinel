// tests/api-key-middleware.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { requireApiKey, generateKey } = require('../lib/api-key');

// Mock req/res helpers — Node 'http' style enough to satisfy the middleware.
function mkReq(headers = {}) {
  return { headers, _attached: {} };
}
function mkRes() {
  const res = {
    statusCode: 200,
    body: null,
    set(k, v) { this.headers = this.headers || {}; this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(obj) { this.body = obj; return this; },
    send(b) { this.body = b; return this; }
  };
  return res;
}

// Tiny pg-pool stub — accepts a programmable response per query.
function mkPool({ rows = [], rowCount = null, throwError = null } = {}) {
  return {
    queryCalls: [],
    async query(sql, params) {
      this.queryCalls.push({ sql, params });
      if (throwError) throw throwError;
      // Best-effort tracking UPDATE — return empty.
      if (/UPDATE api_keys/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows, rowCount: rowCount ?? rows.length };
    }
  };
}

test('requireApiKey: 401 when no Authorization header', async () => {
  const mw = requireApiKey(mkPool());
  const req = mkReq();
  const res = mkRes();
  await mw(req, res, () => assert.fail('next() should not be called'));
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Authorization/);
});

test('requireApiKey: 401 when Authorization header is not Bearer', async () => {
  const mw = requireApiKey(mkPool());
  const req = mkReq({ authorization: 'Basic abc' });
  const res = mkRes();
  await mw(req, res, () => assert.fail('next() should not be called'));
  assert.equal(res.statusCode, 401);
});

test('requireApiKey: 401 when token format is wrong (not sk_ + 32 hex)', async () => {
  const mw = requireApiKey(mkPool());
  for (const bad of ['Bearer abc', 'Bearer sk_short', 'Bearer sk_zzzz', 'Bearer pk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    const res = mkRes();
    await mw(mkReq({ authorization: bad }), res, () => assert.fail('next() should not be called: ' + bad));
    assert.equal(res.statusCode, 401, bad);
    assert.match(res.body.error, /format/);
  }
});

test('requireApiKey: 401 when token does not match any active key', async () => {
  const mw = requireApiKey(mkPool({ rows: [], rowCount: 0 }));
  const { fullKey } = generateKey();
  const res = mkRes();
  await mw(mkReq({ authorization: 'Bearer ' + fullKey }), res, () => assert.fail('next() should not be called'));
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /invalid or revoked/);
});

test('requireApiKey: passes + attaches req.customer + req.apiKey on hit', async () => {
  const { fullKey } = generateKey();
  const pool = mkPool({
    rows: [{
      api_key_id: 'ak-1',
      label: 'My SIEM key',
      scopes: ['read'],
      active: true,
      customer_id: 'cust-1',
      customer_name: 'Test Customer',
      customer_status: 'active'
    }],
    rowCount: 1
  });
  const mw = requireApiKey(pool);
  const req = mkReq({ authorization: 'Bearer ' + fullKey });
  const res = mkRes();
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  assert.equal(nexted, true, 'next() should be called on auth pass');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(req.apiKey, { id: 'ak-1', label: 'My SIEM key', scopes: ['read'] });
  assert.equal(req.customer.id, 'cust-1');
  assert.equal(req.customer.name, 'Test Customer');
  assert.equal(req.customer.status, 'active');
});

test('requireApiKey: 500 on backend error (does not leak stack)', async () => {
  const mw = requireApiKey(mkPool({ throwError: new Error('connection terminated unexpectedly') }));
  const { fullKey } = generateKey();
  const res = mkRes();
  await mw(mkReq({ authorization: 'Bearer ' + fullKey }), res, () => assert.fail('next() should not be called'));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'auth backend error');
  // Make sure the underlying error message isn't echoed.
  assert.doesNotMatch(JSON.stringify(res.body), /connection terminated/);
});

test('requireApiKey: scopes default to ["read"] when DB row has null scopes', async () => {
  const { fullKey } = generateKey();
  const pool = mkPool({
    rows: [{
      api_key_id: 'ak-2', label: '', scopes: null, active: true,
      customer_id: 'c', customer_name: '', customer_status: 'beta'
    }],
    rowCount: 1
  });
  const mw = requireApiKey(pool);
  const req = mkReq({ authorization: 'Bearer ' + fullKey });
  const res = mkRes();
  await mw(req, res, () => {});
  assert.deepEqual(req.apiKey.scopes, ['read']);
});

test('requireApiKey: SQL filter excludes inactive keys + suspended customers (verified via query string)', async () => {
  const pool = mkPool({ rows: [], rowCount: 0 });
  const mw = requireApiKey(pool);
  const { fullKey } = generateKey();
  await mw(mkReq({ authorization: 'Bearer ' + fullKey }), mkRes(), () => {});
  const sql = pool.queryCalls[0]?.sql || '';
  assert.match(sql, /k\.active = TRUE/);
  assert.match(sql, /c\.status IN \('beta', 'active'\)/);
});
