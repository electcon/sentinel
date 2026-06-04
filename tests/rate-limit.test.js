// tests/rate-limit.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyBucket, PER_MIN } = require('../routes/api');

// Fresh bucket helper. The middleware initializes new buckets to
// { tokens: PER_MIN, last: now } — replicate that here.
function fresh(now) { return { tokens: PER_MIN, last: now }; }

test('applyBucket: fresh bucket → allowed, remaining=PER_MIN-1', () => {
  const now = 1_700_000_000_000;
  const b = fresh(now);
  const r = applyBucket(b, now, PER_MIN);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, PER_MIN - 1);
  // Reset time should be in the next minute (within 60s of now).
  assert.ok(r.reset >= Math.floor(now / 1000));
  assert.ok(r.reset <= Math.floor(now / 1000) + 61);
});

test('applyBucket: depletes after PER_MIN consecutive calls in same instant', () => {
  let now = 1_700_000_000_000;
  const b = fresh(now);
  for (let i = 0; i < PER_MIN; i++) {
    const r = applyBucket(b, now, PER_MIN);
    assert.equal(r.allowed, true, 'call ' + i + ' should be allowed');
  }
  // Next call without time elapsed → denied.
  const r = applyBucket(b, now, PER_MIN);
  assert.equal(r.allowed, false);
  assert.equal(r.remaining, 0);
  assert.ok(r.retryAfter >= 1);
});

test('applyBucket: refills 1 token per second (60/min)', () => {
  let now = 1_700_000_000_000;
  const b = fresh(now);
  // Drain the bucket.
  for (let i = 0; i < PER_MIN; i++) applyBucket(b, now, PER_MIN);
  assert.equal(applyBucket(b, now, PER_MIN).allowed, false);
  // Advance 1.1s — should grant 1 token.
  now += 1100;
  const r = applyBucket(b, now, PER_MIN);
  assert.equal(r.allowed, true);
});

test('applyBucket: cap refill at PER_MIN even after a long idle', () => {
  let now = 1_700_000_000_000;
  const b = fresh(now);
  // Drain to 0.
  for (let i = 0; i < PER_MIN; i++) applyBucket(b, now, PER_MIN);
  // Idle for an hour.
  now += 60 * 60 * 1000;
  const r = applyBucket(b, now, PER_MIN);
  assert.equal(r.allowed, true);
  // After consuming 1, remaining should be PER_MIN - 1, not more.
  assert.equal(r.remaining, PER_MIN - 1);
});

test('applyBucket: retryAfter is at least 1s after immediate denial', () => {
  let now = 1_700_000_000_000;
  const b = fresh(now);
  for (let i = 0; i < PER_MIN; i++) applyBucket(b, now, PER_MIN);
  const r = applyBucket(b, now, PER_MIN);
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfter >= 1, 'retryAfter must be ≥ 1s');
  assert.ok(r.retryAfter <= 2, 'retryAfter should be small for a freshly-drained bucket');
});

test('applyBucket: reset = epoch-sec when bucket would be full again', () => {
  let now = 1_700_000_000_000;
  const b = fresh(now);
  // Drain PER_MIN-5 tokens → 5 tokens remain (after the 5th-from-end call,
  // tokens are decremented to PER_MIN-1, ..., 5). So there are (PER_MIN-5)
  // seconds of refill needed to get back to full.
  for (let i = 0; i < PER_MIN - 5; i++) applyBucket(b, now, PER_MIN);
  // After consuming one more (the test call), tokens = 4, so reset is
  // (PER_MIN - 4) = 56 seconds ahead.
  const r1 = applyBucket(b, now, PER_MIN);
  const resetIn1 = r1.reset - Math.floor(now / 1000);
  // Allow some tolerance for ceil rounding.
  assert.ok(resetIn1 >= PER_MIN - 5 && resetIn1 <= PER_MIN - 3,
    `expected ~${PER_MIN - 4}s, got ${resetIn1}`);

  // Drain further → reset still ≤ PER_MIN seconds out.
  for (let i = 0; i < 4; i++) applyBucket(b, now, PER_MIN);
  const r2 = applyBucket(b, now, PER_MIN);
  const resetIn2 = r2.reset - Math.floor(now / 1000);
  assert.ok(resetIn2 > resetIn1, 'reset should advance as bucket drains further');
  assert.ok(resetIn2 <= PER_MIN + 1, 'reset always within one full window');
});

test('applyBucket: remaining reported with floor (no fractional tokens)', () => {
  let now = 1_700_000_000_000;
  const b = fresh(now);
  for (let i = 0; i < PER_MIN; i++) applyBucket(b, now, PER_MIN);
  // Advance 500ms — bucket has 0.5 tokens → still denied (< 1).
  now += 500;
  const r = applyBucket(b, now, PER_MIN);
  assert.equal(r.allowed, false);
  // Advance another 500ms — bucket has 1 token → allowed; floor(remaining) = 0.
  now += 500;
  const r2 = applyBucket(b, now, PER_MIN);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);
});

test('applyBucket: independent buckets do not interfere', () => {
  const now = 1_700_000_000_000;
  const a = fresh(now);
  const b = fresh(now);
  for (let i = 0; i < PER_MIN; i++) applyBucket(a, now, PER_MIN);
  // a is drained; b is fresh.
  assert.equal(applyBucket(a, now, PER_MIN).allowed, false);
  assert.equal(applyBucket(b, now, PER_MIN).allowed, true);
});
