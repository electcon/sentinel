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

// Valid offense categories for the /summarized/state/{state}/{offense}
// endpoint. NOTE: 'hate-crime' is NOT a valid value at this endpoint —
// the FBI exposes hate-crime data via a different sub-API not yet
// integrated. Until then we use 'violent-crime' as the default risk
// proxy (catches the assault / robbery / homicide signal that matters
// most for candidate-district risk-scoring).
const VALID_OFFENSES = [
  'violent-crime', 'property-crime',
  'aggravated-assault', 'homicide', 'robbery', 'rape',
  'burglary', 'larceny', 'motor-vehicle-theft', 'arson'
];

function _formatYearMonth(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const y = dt.getUTCFullYear();
  return `${m}-${y}`;
}

// Pulls monthly offense rates for a state for the given offense across
// the year range [fromYear..toYear]. FBI publishes ~12-18 months in
// arrears, so default range is "the most recent full year we expect to
// be present" with a fallback of two-years-ago.
//
// Response shape:
//   { offenses: { rates: { '{State} Offenses': { 'MM-YYYY': rate, ... }, ... } } }
async function offenseByState(state, offense, fromYear, toYear) {
  if (!/^[A-Z]{2}$/.test(state)) throw new Error('state must be 2-letter abbreviation');
  if (!VALID_OFFENSES.includes(offense)) throw new Error(`offense must be one of: ${VALID_OFFENSES.join(', ')}`);
  const now = new Date();
  const lastFullYear = now.getUTCFullYear() - 2;
  const f = fromYear || lastFullYear;
  const t = toYear || lastFullYear;
  return _get(`/summarized/state/${state}/${offense}?from=01-${f}&to=12-${t}`);
}

// Convenience: "give me a one-line risk summary for state X." Pulls
// the most recent full year of violent-crime monthly rates and rolls
// them into a single number (sum of monthly rates per 100K). Returns
// null on failure (caller decides whether to hide the panel).
async function riskSummaryForState(state) {
  try {
    const data = await offenseByState(state, 'violent-crime');
    const rates = data?.offenses?.rates;
    if (!rates) return { state, error: 'no rates returned' };
    // Take the first key (the state-name section) and sum its monthly values.
    const stateKey = Object.keys(rates)[0];
    const monthly = rates[stateKey] || {};
    const months = Object.keys(monthly).sort();
    const sum = months.reduce((acc, k) => acc + (Number(monthly[k]) || 0), 0);
    const avg = months.length ? sum / months.length : 0;
    return {
      state,
      offense: 'violent-crime',
      year_range: months.length ? `${months[0]} → ${months[months.length - 1]}` : null,
      monthly_average_rate_per_100k: Number(avg.toFixed(2)),
      months_observed: months.length,
      raw: data
    };
  } catch (e) {
    return { state, error: e.message };
  }
}

module.exports = { offenseByState, riskSummaryForState, ensureKey, VALID_OFFENSES };
