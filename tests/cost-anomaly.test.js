// tests/cost-anomaly.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detect, median, DEFAULT_RATIO, DEFAULT_ABS_FLOOR_MICRO, DEFAULT_ABS_JUMP_MICRO } = require('../lib/cost-anomaly');

// $X in micro-USD shorthand.
const $ = (n) => Math.round(n * 1_000_000);

test('detect: no anomaly when cost is at the historical median', () => {
  const r = detect({ cost_24h: $(2.50), median_daily_30d: $(2.50) });
  assert.equal(r.is_anomaly, false);
  assert.equal(r.ratio, 1);
});

test('detect: 10x ratio with cost above floor → ratio anomaly', () => {
  const r = detect({ cost_24h: $(50), median_daily_30d: $(5) });
  assert.equal(r.is_anomaly, true);
  assert.equal(r.reason, 'ratio');
  assert.equal(r.ratio, 10);
});

test('detect: 9x ratio with small abs jump → no anomaly', () => {
  // ratio 9 (under default 10), jump $4 (under default $5 jump trigger)
  const r = detect({ cost_24h: $(4.50), median_daily_30d: $(0.50) });
  // Above the $1 floor, but ratio 9 fails to clear the 10x bar AND
  // jump $4 fails to clear the $5 abs_jump bar.
  assert.equal(r.is_anomaly, false);
  assert.equal(r.reason, null);
});

test('detect: tiny absolute spend below floor never alerts (no 100x-pennies false positive)', () => {
  const r = detect({ cost_24h: $(0.10), median_daily_30d: $(0.001) });
  // 100x ratio but only $0.10 absolute — under the $1 floor.
  assert.equal(r.is_anomaly, false);
});

test('detect: absolute jump triggers even at low ratio', () => {
  const r = detect({ cost_24h: $(8), median_daily_30d: $(2) });
  // Ratio 4x — under default. But jump = $6 ≥ default $5.
  assert.equal(r.is_anomaly, true);
  assert.equal(r.reason, 'abs_jump');
});

test('detect: median=0 + cost_24h above floor → ratio Infinity → ratio reason', () => {
  const r = detect({ cost_24h: $(2.50), median_daily_30d: 0 });
  // Above floor ($1), ratio is Infinity, hits ratio threshold first.
  assert.equal(r.is_anomaly, true);
  assert.equal(r.reason, 'ratio');
  assert.equal(r.ratio, Infinity);
});

test('detect: median=0 + cost_24h below floor → no anomaly even at infinite ratio', () => {
  const r = detect({ cost_24h: $(0.50), median_daily_30d: 0 });
  assert.equal(r.is_anomaly, false);
});

test('detect: cost=0 + median=0 → ratio 0, no anomaly', () => {
  const r = detect({ cost_24h: 0, median_daily_30d: 0 });
  assert.equal(r.is_anomaly, false);
  assert.equal(r.ratio, 0);
});

test('detect: custom threshold overrides defaults', () => {
  // 5x with $0.50 floor and $2 jump
  const r = detect({
    cost_24h: $(0.60),
    median_daily_30d: $(0.10),
    threshold: { ratio: 5, abs_floor_micro: $(0.50) },
    abs_jump_micro: $(2)
  });
  assert.equal(r.is_anomaly, true);
  assert.equal(r.reason, 'ratio');
});

test('detect: handles negative or invalid input by clamping to 0', () => {
  const r = detect({ cost_24h: -100, median_daily_30d: -50 });
  assert.equal(r.is_anomaly, false);
});

test('detect: returns numeric ratio and jump even when no anomaly', () => {
  const r = detect({ cost_24h: $(3), median_daily_30d: $(2) });
  assert.equal(r.is_anomaly, false);
  assert.equal(r.ratio, 1.5);
  assert.equal(r.jump_micro, $(1));
});

test('detect: jump_micro can be negative (today below median)', () => {
  const r = detect({ cost_24h: $(1), median_daily_30d: $(5) });
  assert.equal(r.is_anomaly, false);
  assert.equal(r.jump_micro, $(-4));
});

test('median: empty array → 0', () => {
  assert.equal(median([]), 0);
  assert.equal(median(null), 0);
});

test('median: odd count → middle value', () => {
  assert.equal(median([1, 5, 3]), 3);
  assert.equal(median([10, 1, 5, 3, 8]), 5);
});

test('median: even count → mean of two middle values', () => {
  assert.equal(median([1, 3, 5, 7]), 4);
  assert.equal(median([2, 4]), 3);
});

test('median: handles real micro-USD-shaped values', () => {
  const days = [$(0.50), $(0.75), $(1.00), $(1.25), $(2.00), $(2.50), $(50)];  // last is anomaly day
  // Excluding the anomaly: [.50, .75, 1.00, 1.25, 2.00, 2.50] — median = (1.00 + 1.25)/2 = 1.125
  const m = median(days.slice(0, 6));
  assert.equal(m, $(1.125));
});

test('integration: anomaly day, median computed from prior 30 days', () => {
  const prior30 = Array(30).fill(0).map((_, i) => $(0.50 + (i % 3) * 0.25));   // $0.50–$1.00 range
  const anomalyDay = $(20);
  const m = median(prior30);
  const r = detect({ cost_24h: anomalyDay, median_daily_30d: m });
  assert.equal(r.is_anomaly, true);
  assert.equal(r.reason, 'ratio');
});

test('exports defaults for callers that want to use them', () => {
  assert.equal(DEFAULT_RATIO, 10);
  assert.equal(DEFAULT_ABS_FLOOR_MICRO, 1_000_000);
  assert.equal(DEFAULT_ABS_JUMP_MICRO,  5_000_000);
});
