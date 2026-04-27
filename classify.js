// classify.js
// Single Claude call: classify a mention against THREAT_TAXONOMY.md.
// Returns { tier, confidence, sentiment, rationale, model, prompt_v }.
//
// Conservative bias: confidence < 0.7 bumps the tier by 1 (capped at 4).
// Above tier 2, the route handler should escalate to a human reviewer.
//
// Cost: Haiku 4.5 ~$0.0001/call at avg payload size. 50K mentions/month
// per customer ≈ $5/month classifier cost. Sonnet 4.6 escalation runs
// ~10x cost; reserved for hard cases.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const MODEL_DEFAULT = process.env.ANTHROPIC_MODEL_DEFAULT || 'claude-haiku-4-5-20251001';
const MODEL_ESCALATE = process.env.ANTHROPIC_MODEL_ESCALATE || 'claude-sonnet-4-6';

// Read THREAT_TAXONOMY.md once at module load — it IS the system prompt.
// When the rubric changes (new tier example, new edge case), the next
// process restart picks it up. PROMPT_V is bumped manually so the
// classifications.prompt_v audit trail can show which rubric a tier
// was decided under.
const TAXONOMY = fs.readFileSync(path.join(__dirname, 'THREAT_TAXONOMY.md'), 'utf8');
const PROMPT_V = 'tax-v1.2';

const SYSTEM = `You are a threat-classification model for Sentinel, a defensive
monitoring tool used by Democratic and Indy-aligned political campaigns.

Your job: read a single piece of social-media content that mentions a
campaign target (candidate, family member, or staff) and classify it
against the 4-tier rubric below.

You MUST return a single JSON object — and NOTHING ELSE. No code
fences, no markdown, no "Reasoning:" section, no commentary before
or after. Anything outside the JSON object will be discarded and
treated as a parse failure.

Shape:
  {"tier":1|2|3|4,"confidence":0.0-1.0,"sentiment":-2..2,"rationale":"<=200 chars"}

Conservative bias: when a piece is borderline, escalate one tier higher.
False negatives at tier 3+ are catastrophic. False positives are
tolerable.

═══════════════════════════════════════════════════════════════════════
${TAXONOMY}
═══════════════════════════════════════════════════════════════════════`;

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// classify({ targetName, body, source, authorHandle, postedAt })
// Returns the structured tier or throws on API failure (caller decides
// whether to retry or fall back to tier 2 + human review).
async function classify(opts) {
  if (!opts || !opts.body) throw new Error('classify: body required');
  const userPrompt = [
    `TARGET: ${opts.targetName || 'unknown'}`,
    `SOURCE: ${opts.source || 'unknown'}`,
    `AUTHOR: ${opts.authorHandle || 'unknown'}`,
    `POSTED: ${opts.postedAt ? new Date(opts.postedAt).toISOString() : 'unknown'}`,
    '',
    'CONTENT:',
    String(opts.body).slice(0, 4000)
  ].join('\n');

  return _call(MODEL_DEFAULT, userPrompt, opts);
}

// classifyEscalated — same input, Sonnet model, used when default model
// returns confidence < 0.7 OR when the caller wants a high-stakes
// second opinion (any tier-3-or-above borderline case).
async function classifyEscalated(opts) {
  const userPrompt = [
    `TARGET: ${opts.targetName || 'unknown'}`,
    `SOURCE: ${opts.source || 'unknown'}`,
    'CONTENT:',
    String(opts.body).slice(0, 4000)
  ].join('\n');
  return _call(MODEL_ESCALATE, userPrompt, opts);
}

async function _call(model, userPrompt, opts) {
  // CLASSIFIER_PROVIDER selects the upstream:
  //   'anthropic'  (default) — direct Anthropic SDK
  //   'openrouter'           — OpenAI-compatible HTTP via openrouter.ai
  // Per-call override: opts.provider takes precedence over env var.
  const provider = (opts && opts.provider) || process.env.CLASSIFIER_PROVIDER || 'anthropic';
  if (provider === 'openrouter') return _callOpenRouter(model, userPrompt, opts);
  return _callAnthropic(model, userPrompt, opts);
}

async function _callAnthropic(model, userPrompt, opts) {
  const t0 = Date.now();
  const res = await client().messages.create({
    model,
    max_tokens: 256,
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const text = (res.content || []).map(b => b.type === 'text' ? b.text : '').join('').trim();
  return _parseClassifierOutput(text, model, t0);
}

// OpenRouter classifier path. Uses any model exposed via openrouter.ai
// — useful for A/B testing other providers (Llama, Mistral, GPT-5, etc.)
// against the same THREAT_TAXONOMY rubric. Default model is set by env
// OPENROUTER_MODEL; if absent, falls through to whatever was passed in
// for `model` (which from the Anthropic-default path is e.g. 'claude-haiku-4-5-…',
// not a valid OpenRouter id) so DO set OPENROUTER_MODEL when using this provider.
async function _callOpenRouter(model, userPrompt, opts) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  const useModel = process.env.OPENROUTER_MODEL || (opts && opts.openrouterModel) || model;
  const t0 = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.DASHBOARD_BASE_URL || 'https://sentinel-staging-i3ug.onrender.com',
      'X-Title': 'Sentinel'
    },
    body: JSON.stringify({
      model: useModel,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 256,
      temperature: 0
    })
  });
  if (!r.ok) {
    const bodyText = await r.text().catch(() => '');
    throw new Error(`openrouter ${r.status}: ${bodyText.slice(0, 300)}`);
  }
  const j = await r.json();
  const text = (j?.choices?.[0]?.message?.content || '').trim();
  return _parseClassifierOutput(text, useModel, t0);
}

function _parseClassifierOutput(text, modelLabel, t0) {
  const jsonStr = extractFirstJsonObject(text);
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch (_) {
    return {
      tier: 2, confidence: 0, sentiment: 0,
      rationale: 'classifier returned unparseable output — see raw',
      raw: text, model: modelLabel, prompt_v: PROMPT_V,
      ms: Date.now() - t0, parse_error: true
    };
  }
  let tier = Math.max(1, Math.min(4, parseInt(parsed.tier, 10) || 1));
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
  if (confidence < 0.7 && tier < 4) tier = tier + 1;
  return {
    tier, confidence,
    sentiment: typeof parsed.sentiment === 'number' ? parsed.sentiment : 0,
    rationale: String(parsed.rationale || '').slice(0, 200),
    raw: parsed, model: modelLabel, prompt_v: PROMPT_V,
    ms: Date.now() - t0
  };
}

// Scan `text` for the first `{...}` block with balanced braces, ignoring
// braces that appear inside string literals. Returns the matched substring
// or '' if no balanced object found.
function extractFirstJsonObject(text) {
  if (!text) return '';
  const start = text.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

module.exports = { classify, classifyEscalated, PROMPT_V, extractFirstJsonObject };

// CLI smoke test:
//   ANTHROPIC_API_KEY=... node classify.js "I'll be at her event Saturday."
if (require.main === module) {
  const body = process.argv.slice(2).join(' ');
  if (!body) { console.error('usage: node classify.js "<content>"'); process.exit(2); }
  classify({ targetName: 'Test Candidate', body, source: 'cli', authorHandle: 'cli-test' })
    .then(r => { console.log(JSON.stringify(r, null, 2)); })
    .catch(e => { console.error('ERR', e.message); process.exit(1); });
}
