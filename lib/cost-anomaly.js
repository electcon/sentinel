// lib/cost-anomaly.js
// Detect runaway classifier spend. A customer hit by a hostile flood
// can rack up 100x their normal Anthropic bill in a single hour. We
// want to know about it before it shows up on the credit card.
//
// Pure detection logic separated from DB access so it can be tested.
//
// Inputs (all integer micro-USD):
//   cost_24h         — what the customer spent in the last 24h
//   median_daily_30d — median daily spend over the prior 30 days,
//                      EXCLUDING the most recent 24h window (so a real
//                      anomaly doesn't drag the median up to mask itself
//                      on the next run)
//   threshold        — { ratio, abs_floor_micro }
//                      ratio: required cost_24h / median ratio (default 10)
//                      abs_floor_micro: cost_24h must exceed this floor;
//                      protects against false positives when both numbers
//                      are tiny (default $1.00 = 1_000_000 micro)
//   abs_jump_micro   — absolute jump trigger; fires even at low ratio if
//                      cost_24h - median > abs_jump_micro. Catches the
//                      case where median is $0 (new customer / quiet day)
//                      but spend suddenly appeared. Default $5 = 5_000_000
//                      micro.
//
// Returns { is_anomaly, ratio, jump_micro, reason } where:
//   ratio:         cost_24h / max(median, 1) — `Infinity` when median=0
//   jump_micro:    cost_24h - median
//   reason:        'ratio' | 'abs_jump' | null

'use strict';

const DEFAULT_RATIO = 10;
const DEFAULT_ABS_FLOOR_MICRO = 1_000_000;     // $1.00
const DEFAULT_ABS_JUMP_MICRO  = 5_000_000;     // $5.00

function detect({ cost_24h, median_daily_30d, threshold, abs_jump_micro } = {}) {
  const c   = Math.max(0, +cost_24h || 0);
  const m   = Math.max(0, +median_daily_30d || 0);
  const t   = threshold || {};
  const reqRatio = +t.ratio || DEFAULT_RATIO;
  const floor    = t.abs_floor_micro != null ? +t.abs_floor_micro : DEFAULT_ABS_FLOOR_MICRO;
  const jumpReq  = abs_jump_micro != null ? +abs_jump_micro : DEFAULT_ABS_JUMP_MICRO;

  const ratio    = m > 0 ? c / m : (c > 0 ? Infinity : 0);
  const jump     = c - m;

  // No anomaly if absolute spend is below the floor — protects against
  // 100x-of-pennies false positives.
  if (c < floor) return { is_anomaly: false, ratio, jump_micro: jump, reason: null };

  if (ratio >= reqRatio) return { is_anomaly: true, ratio, jump_micro: jump, reason: 'ratio' };
  if (jump >= jumpReq)   return { is_anomaly: true, ratio, jump_micro: jump, reason: 'abs_jump' };
  return { is_anomaly: false, ratio, jump_micro: jump, reason: null };
}

// Compute median from a sorted array of numbers. Empty → 0.
function median(values) {
  if (!values || !values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = {
  detect,
  median,
  DEFAULT_RATIO,
  DEFAULT_ABS_FLOOR_MICRO,
  DEFAULT_ABS_JUMP_MICRO
};
