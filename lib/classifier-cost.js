// lib/classifier-cost.js
// Per-call Anthropic / OpenRouter cost computation. Stores cost in
// integer micro-USD (1 micro = 1e-6 USD) to avoid floating-point drift
// across thousands of rows. A $0.0001 classify call = 100 micro-USD.
//
// Pricing source: Anthropic public price list, snapshotted 2026-04-29.
// Override any model via env: SENTINEL_PRICE_<MODEL>=input_per_M,output_per_M
// (USD per million tokens).
//
// Table covers the models Sentinel actually uses. Unknown models return
// cost_usd_micro = 0 (logged as unknown_model in the row); operators
// can backfill once pricing is added.

'use strict';

// USD per million tokens. [input_rate, output_rate].
// cache_read = 0.10x input; cache_creation = 1.25x input.
const PRICE_PER_M = {
  // Anthropic
  'claude-haiku-4-5':                [1.00,  5.00],
  'claude-haiku-4-5-20251001':       [1.00,  5.00],
  'claude-sonnet-4-6':               [3.00, 15.00],
  'claude-opus-4-7':                 [15.00, 75.00],
  'claude-3-5-haiku-20241022':       [0.80,  4.00],
  'claude-3-5-sonnet-20241022':      [3.00, 15.00],
  // Common OpenRouter routes — best-effort. OpenRouter response
  // sometimes omits per-call cost; we fall back to model lookup.
  'anthropic/claude-haiku-4-5':      [1.00,  5.00],
  'anthropic/claude-sonnet-4-6':     [3.00, 15.00],
  'meta-llama/llama-3.3-70b-instruct': [0.40, 0.40],
  'mistralai/mistral-large':         [2.00,  6.00],
  'openai/gpt-4o-mini':              [0.15,  0.60],
};

// Read env override at call time (not module init) so the override
// can be flipped without restarting.
function envOverride(model) {
  const k = 'SENTINEL_PRICE_' + String(model).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const v = process.env[k];
  if (!v) return null;
  const [inP, outP] = v.split(',').map(s => parseFloat(s.trim()));
  if (!isFinite(inP) || !isFinite(outP)) return null;
  return [inP, outP];
}

function rates(model) {
  return envOverride(model) || PRICE_PER_M[model] || null;
}

// computeCost({model, input_tokens, output_tokens, cache_read?, cache_creation?})
// → { cost_usd_micro: int, breakdown: {...} }
//
// All counts are token integers. Returns micro-USD (rounded to nearest
// integer micro, i.e. 1e-6 USD). For known models the breakdown lists
// the per-bucket micros; for unknown models cost is 0 and breakdown
// carries unknown_model:true.
function computeCost(opts) {
  const o = opts || {};
  const r = rates(o.model);
  const input  = +o.input_tokens  || 0;
  const output = +o.output_tokens || 0;
  const cacheR = +o.cache_read    || 0;
  const cacheC = +o.cache_creation|| 0;

  if (!r) {
    return {
      cost_usd_micro: 0,
      breakdown: { unknown_model: true, model: o.model, input, output, cache_read: cacheR, cache_creation: cacheC }
    };
  }
  const [inRate, outRate] = r; // USD per 1M tokens

  // micro-USD = tokens * (rate USD/1M) * 1e6 micro/USD / 1e6 tokens/M
  //          = tokens * rate
  // (because 1e6 / 1e6 = 1 and we want micro-USD).
  const inputMicro  = Math.round(input  * inRate);
  const outputMicro = Math.round(output * outRate);
  const cacheRMicro = Math.round(cacheR * inRate * 0.10);
  const cacheCMicro = Math.round(cacheC * inRate * 1.25);
  const total = inputMicro + outputMicro + cacheRMicro + cacheCMicro;
  return {
    cost_usd_micro: total,
    breakdown: { input: inputMicro, output: outputMicro, cache_read: cacheRMicro, cache_creation: cacheCMicro }
  };
}

// Format micro-USD for human display. Always 4 decimals up to $1, then
// 2 after that.
function formatMicroUsd(micro) {
  const usd = (Number(micro) || 0) / 1_000_000;
  if (usd === 0) return '$0';
  if (usd < 1)   return '$' + usd.toFixed(4);
  if (usd < 100) return '$' + usd.toFixed(2);
  return '$' + Math.round(usd).toLocaleString();
}

module.exports = { computeCost, formatMicroUsd, PRICE_PER_M };
