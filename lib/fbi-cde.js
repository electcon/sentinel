// lib/fbi-cde.js
// FBI Crime Data Explorer (CDE) client. Free public REST API at
// https://api.usa.gov/crime/fbi/cde/ — requires a free api.data.gov key.
//
// Use case: enrich a target's geographic context with hate-crime
// baselines for the candidate's state/county. Data has a 12–18 month
// lag so this is REFERENCE info, not real-time triage. Useful for:
//   - Risk-scoring a candidate's district during onboarding
//   - "Show your campaign manager the baseline" pitch material
//   - Future: weight tier-2/3 alerts higher when a target's home
//     state has elevated bias-incident rates
//
// Onboarding (1 minute):
//   1. Visit https://api.data.gov/signup/
//   2. Get an instant API key (no DHS approval; api.data.gov serves
//      hundreds of federal endpoints under a single key)
//   3. Set FBI_CDE_API_KEY on Render

'use strict';

const BASE = 'https://api.usa.gov/crime/fbi/cde';

function ensureKey() {
  const k = process.env.FBI_CDE_API_KEY;
  if (!k) throw new Error('FBI_CDE_API_KEY not set');
  return k;
}

async function _get(path) {
  const key = ensureKey();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}api_key=${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Sentinel/0.1' } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`fbi-cde ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

// Aggregate hate-crime counts for a state across a year range.
// state: 2-letter postal abbreviation ('NH', 'CO', 'FL', ...)
// fromYear / toYear: integers; defaults: last full year only
async function hateCrimesByState(state, fromYear, toYear) {
  if (!/^[A-Z]{2}$/.test(state)) throw new Error('state must be 2-letter abbreviation');
  const lastFullYear = new Date().getUTCFullYear() - 2;   // FBI publishes ~18 months in arrears
  const f = fromYear || lastFullYear;
  const t = toYear || lastFullYear;
  return _get(`/hate-crime/state/${state}/${f}/${t}`);
}

// State summary across all offense categories. Useful for general
// crime-rate context, not just hate-crime.
async function stateSummary(state) {
  if (!/^[A-Z]{2}$/.test(state)) throw new Error('state must be 2-letter abbreviation');
  return _get(`/summarized/state/${state}/all`);
}

// Estimated crime trends for a state (handles agencies with incomplete
// reporting via FBI's modeled estimates).
async function stateEstimate(state) {
  if (!/^[A-Z]{2}$/.test(state)) throw new Error('state must be 2-letter abbreviation');
  return _get(`/estimate/state/${state}`);
}

// Convenience: "give me a one-line risk summary for state X." Pulls
// hate-crime counts for the most recent published year and formats
// human-readable. Returns null on failure (caller decides whether to
// hide the panel).
async function riskSummaryForState(state) {
  try {
    const data = await hateCrimesByState(state);
    // Response shape (FBI CDE): { results: [{ data_year, total_offenses, total_victims, ...}], ... }
    const rows = (data && (data.results || [])) || [];
    if (!rows.length) return null;
    const total = rows.reduce((acc, r) => acc + (r.total_offenses || r.offenses || 0), 0);
    const yearRange = (rows[0].data_year || '') + (rows.length > 1 ? `–${rows[rows.length - 1].data_year}` : '');
    return {
      state,
      year_range: yearRange,
      total_offenses: total,
      raw: data
    };
  } catch (e) {
    return { state, error: e.message };
  }
}

module.exports = { hateCrimesByState, stateSummary, stateEstimate, riskSummaryForState, ensureKey };
