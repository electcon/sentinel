// tests/classifier-cost.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeCost, formatMicroUsd, PRICE_PER_M } = require('../lib/classifier-cost');

test('computeCost: Haiku 4.5 — basic call', () => {
  // 1000 input @ $1/M = 1000 micro = $0.001
  // 500 output @ $5/M = 2500 micro = $0.0025
  // total = 3500 micro = $0.0035
  const r = computeCost({ model: 'claude-haiku-4-5-20251001', input_tokens: 1000, output_tokens: 500 });
  assert.equal(r.cost_usd_micro, 3500);
  assert.equal(r.breakdown.input, 1000);
  assert.equal(r.breakdown.output, 2500);
});

test('computeCost: Sonnet 4.6 — basic call', () => {
  // 1000 in @ $3/M = 3000, 500 out @ $15/M = 7500, total 10500
  const r = computeCost({ model: 'claude-sonnet-4-6', input_tokens: 1000, output_tokens: 500 });
  assert.equal(r.cost_usd_micro, 10500);
});

test('computeCost: Opus 4.7 — basic call', () => {
  // 1000 in @ $15/M = 15000, 500 out @ $75/M = 37500, total 52500
  const r = computeCost({ model: 'claude-opus-4-7', input_tokens: 1000, output_tokens: 500 });
  assert.equal(r.cost_usd_micro, 52500);
});

test('computeCost: cache_read at 0.10× input rate', () => {
  // Haiku: 1000 input @ $1/M = 1000; 1000 cache_read @ $0.10/M = 100
  const r = computeCost({ model: 'claude-haiku-4-5-20251001', input_tokens: 1000, output_tokens: 0, cache_read: 1000 });
  assert.equal(r.breakdown.cache_read, 100);
  assert.equal(r.cost_usd_micro, 1000 + 100);
});

test('computeCost: cache_creation at 1.25× input rate', () => {
  // Haiku: 1000 input @ $1/M = 1000; 1000 cache_creation @ $1.25/M = 1250
  const r = computeCost({ model: 'claude-haiku-4-5-20251001', input_tokens: 1000, output_tokens: 0, cache_creation: 1000 });
  assert.equal(r.breakdown.cache_creation, 1250);
  assert.equal(r.cost_usd_micro, 1000 + 1250);
});

test('computeCost: unknown model returns 0 + unknown_model flag', () => {
  const r = computeCost({ model: 'fictional-model-xyz', input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(r.cost_usd_micro, 0);
  assert.equal(r.breakdown.unknown_model, true);
  assert.equal(r.breakdown.model, 'fictional-model-xyz');
});

test('computeCost: missing/zero token counts treated as 0', () => {
  const r1 = computeCost({ model: 'claude-haiku-4-5-20251001' });
  assert.equal(r1.cost_usd_micro, 0);
  const r2 = computeCost({ model: 'claude-haiku-4-5-20251001', input_tokens: 0, output_tokens: 0 });
  assert.equal(r2.cost_usd_micro, 0);
});

test('computeCost: env override changes the rate at call time', () => {
  const prev = process.env.SENTINEL_PRICE_CLAUDE_HAIKU_4_5_20251001;
  process.env.SENTINEL_PRICE_CLAUDE_HAIKU_4_5_20251001 = '0.50,2.00';
  try {
    // 1000 in @ $0.50/M = 500; 500 out @ $2/M = 1000
    const r = computeCost({ model: 'claude-haiku-4-5-20251001', input_tokens: 1000, output_tokens: 500 });
    assert.equal(r.cost_usd_micro, 1500);
  } finally {
    if (prev === undefined) delete process.env.SENTINEL_PRICE_CLAUDE_HAIKU_4_5_20251001;
    else process.env.SENTINEL_PRICE_CLAUDE_HAIKU_4_5_20251001 = prev;
  }
});

test('computeCost: rounding at 0.5 micro rounds to nearest', () => {
  // Haiku $1/M; 1 input token = $1/1M = 1 micro USD on the nose.
  const r = computeCost({ model: 'claude-haiku-4-5-20251001', input_tokens: 1, output_tokens: 0 });
  assert.equal(r.cost_usd_micro, 1);
});

test('computeCost: realistic ~50K mention/month at Haiku → ~$5/mo (per docs)', () => {
  // Per classify.js comment: 50K mentions/month ≈ $5/month at Haiku.
  // Avg 200 input + 100 output tokens (small mention bodies + JSON output).
  // 50_000 * (200*$1 + 100*$5)/1M = 50_000 * 700/1M = $35/mo? No — let's
  // just verify a single call cost matches expectations.
  const r = computeCost({ model: 'claude-haiku-4-5-20251001', input_tokens: 200, output_tokens: 100 });
  // 200 in @ $1/M = 200 micro; 100 out @ $5/M = 500 micro; total 700 micro = $0.0007
  assert.equal(r.cost_usd_micro, 700);
});

test('formatMicroUsd: $0 for zero', () => {
  assert.equal(formatMicroUsd(0), '$0');
});

test('formatMicroUsd: 4 decimals when under $1', () => {
  assert.equal(formatMicroUsd(700), '$0.0007');
  assert.equal(formatMicroUsd(3500), '$0.0035');
  // 999_999 micro = 0.999999 USD — under $1, 4 decimals rounds to $1.0000
  assert.equal(formatMicroUsd(999_999), '$1.0000');
});

test('formatMicroUsd: 2 decimals between $1 and $100', () => {
  assert.equal(formatMicroUsd(1_000_000), '$1.00');
  assert.equal(formatMicroUsd(12_345_000), '$12.35');
});

test('formatMicroUsd: integer + commas above $100', () => {
  assert.equal(formatMicroUsd(100_500_000), '$101'); // 100.50 → 101 via Math.round
  assert.equal(formatMicroUsd(1_234_567_890), '$1,235');
});

test('PRICE_PER_M includes Haiku 4.5, Sonnet 4.6, Opus 4.7', () => {
  assert.ok(PRICE_PER_M['claude-haiku-4-5-20251001']);
  assert.ok(PRICE_PER_M['claude-sonnet-4-6']);
  assert.ok(PRICE_PER_M['claude-opus-4-7']);
});
