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

// Hate-crime stats for a state, year range fromYear..toYear (inclusive).
// Uses the /hate-crime/state/{state} endpoint with from/to in MM-YYYY.
//
// Response shape:
//   {
//     bias_section: {
//       victim_type:  { 'Individual': 55, 'Government': 14, ... },
//       offense_type: { 'Intimidation': 15, 'Simple Assault': 10, ... },
//       location_type: {...}, offender_race: {...},
//       judicial_district: {...}, offender_ethnicity: {...}
//     },
//     incident_section: { bias, bias_category },
//     last_refresh_date: { UCR: 'MM/DD/YYYY' }
//   }
async function hateCrimesByState(state, fromYear, toYear) {
  if (!/^[A-Z]{2}$/.test(state)) throw new Error('state must be 2-letter abbreviation');
  const now = new Date();
  const lastFullYear = now.getUTCFullYear() - 2;
  const f = fromYear || (lastFullYear - 1);                 // default 2-year window
  const t = toYear || lastFullYear;
  return _get(`/hate-crime/state/${state}?from=01-${f}&to=12-${t}`);
}

// Convenience: "give me a one-line risk summary for state X." Returns
// hate-crime totals + top bias categories for the most recent 2-year
// window. This is what surfaces in admin / target-detail panels.
//
// Returned shape (success):
//   {
//     state, year_range,
//     total_incidents:  N,             // sum across victim_type
//     against_individuals: N,
//     against_government: N,
//     against_religious_org: N,
//     top_offense: { name, count },
//     top_bias_target: { name, count },
//     last_refresh: 'MM/DD/YYYY',
//     raw: <full response>
//   }
async function riskSummaryForState(state) {
  try {
    const data = await hateCrimesByState(state);
    const bias = data?.bias_section;
    if (!bias) return { state, error: 'no bias_section returned' };
    const sumVals = (obj) => Object.values(obj || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const top = (obj) => {
      const entries = Object.entries(obj || {}).filter(([, v]) => Number(v) > 0).sort(([, a], [, b]) => Number(b) - Number(a));
      return entries.length ? { name: entries[0][0], count: Number(entries[0][1]) } : null;
    };
    const victimType = bias.victim_type || {};
    const totalIncidents = sumVals(victimType);
    const lastFullYear = new Date().getUTCFullYear() - 2;
    return {
      state,
      year_range: `${lastFullYear - 1}-${lastFullYear}`,
      total_incidents: totalIncidents,
      against_individuals: Number(victimType.Individual) || 0,
      against_government: Number(victimType.Government) || 0,
      against_religious_org: Number(victimType['Religious Organization']) || 0,
      against_law_enforcement: Number(victimType['Law Enforcement Officer']) || 0,
      top_offense: top(bias.offense_type),
      top_bias_target: top(bias.victim_type),
      last_refresh: data.last_refresh_date?.UCR || null,
      raw: data
    };
  } catch (e) {
    return { state, error: e.message };
  }
}

module.exports = { offenseByState, hateCrimesByState, riskSummaryForState, ensureKey, VALID_OFFENSES };
