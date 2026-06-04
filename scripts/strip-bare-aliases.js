// scripts/strip-bare-aliases.js
// One-off cleanup: removes bare-token aliases (single first or last names
// like "Jolly", "Cinde", "Crist") from every target row in the sentinel
// DB. Bare aliases were seeded into beta customers before we tightened
// the onboarding rules in May 2026 and were producing high-volume noise
// (Bluesky digest had 170 hits/day where ~90% were "Jolly Sailors",
// "Joe Warmington" — different person same surname, "Cristóbal" matching
// "Crist", etc.).
//
// Rule applied: an alias is "bare" if it's a single token (no whitespace)
// AND it's also a token of the target's full name. Examples:
//   target "Cinde Warmington", aliases ["Warmington", "Cinde"]
//     → both stripped (each is a name token)
//   target "Charlie Crist", aliases ["Crist"]
//     → stripped
//   target "Roy Cooper", aliases ["@RoyCooperNC", "Cooper for NC"]
//     → both KEPT (handle is multi-character non-name; phrase has whitespace)
//
// Usage:
//   node sentinel/scripts/strip-bare-aliases.js          # dry run, prints diff
//   node sentinel/scripts/strip-bare-aliases.js --apply  # writes changes
//
// Idempotent — safe to run repeatedly. Targets with no bare aliases are
// skipped without a write. search_terms are NOT touched (they're search
// queries, not match filters).

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');

function isBareNameAlias(alias, fullName) {
  const a = String(alias || '').trim();
  if (!a) return true;                         // empty → strip
  if (/\s/.test(a)) return false;              // multi-token → keep
  const nameTokens = String(fullName || '').split(/\s+/).filter(Boolean);
  return nameTokens.some(t => t.toLowerCase() === a.toLowerCase());
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(2); }
  const useSSL = /render\.com/.test(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 2
  });

  console.log(APPLY ? '[strip-bare-aliases] APPLY mode — writing changes' : '[strip-bare-aliases] DRY RUN — no writes (re-run with --apply to commit)');
  console.log();

  try {
    const rows = (await pool.query(`
      SELECT t.id, t.name, t.aliases, c.name AS customer_name
        FROM targets t
        JOIN customers c ON c.id = t.customer_id
       ORDER BY c.name, t.name
    `)).rows;

    let touched = 0;
    let aliasesRemoved = 0;
    for (const r of rows) {
      const before = Array.isArray(r.aliases) ? r.aliases : [];
      const after = before.filter(a => !isBareNameAlias(a, r.name));
      if (before.length === after.length) continue;
      const stripped = before.filter(a => !after.includes(a));
      touched++;
      aliasesRemoved += stripped.length;
      console.log(`[${r.customer_name}] ${r.name}`);
      console.log(`  before: ${JSON.stringify(before)}`);
      console.log(`  after:  ${JSON.stringify(after)}`);
      console.log(`  stripped: ${JSON.stringify(stripped)}`);
      if (APPLY) {
        // aliases is JSONB; pass as JSON string, not a JS array (pg would otherwise emit PG-array literal syntax).
        await pool.query('UPDATE targets SET aliases = $2::jsonb WHERE id = $1', [r.id, JSON.stringify(after)]);
      }
      console.log();
    }

    console.log(`[strip-bare-aliases] ${touched} target row${touched === 1 ? '' : 's'} affected; ${aliasesRemoved} alias${aliasesRemoved === 1 ? '' : 'es'} stripped`);
    console.log(APPLY ? '[strip-bare-aliases] APPLIED' : '[strip-bare-aliases] DRY RUN complete — re-run with --apply to commit');
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('[strip-bare-aliases] FATAL:', e.message); process.exit(1); });
