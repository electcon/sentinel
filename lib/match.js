// lib/match.js
// Resolve a piece of text to a target via alias regex matching.
// Cheap, deterministic first pass. If the regex misses, the LLM
// classifier never runs (we save the cost). False negatives here
// are the dominant failure mode — pad each target's `aliases` array
// with every reasonable variant during onboarding.

'use strict';

// Word-boundary-aware case-insensitive substring match.
// Reddit posts are full of names with punctuation around them
// ('@cinde-warmington', 'Mr. Laubacher!') so we treat any
// non-letter/digit as a boundary.
//
// Boundary uses Unicode letter/digit classes (\p{L}\p{N} with /u flag)
// so non-ASCII letters in the surrounding text count as "still inside a
// word." Earlier versions used [A-Za-z0-9] only, which silently
// false-positived on text like "Cristóbal" matching alias "Crist" — the
// 'ó' read as a non-word char, so the right-boundary check passed.
//
// Anti-pattern reminder: bare-token aliases (single names like "Crist",
// "Jolly", "Cinde") still match at the regex level by design. The
// corpus is full of common-word and same-surname collisions
// ("Jolly Sailors", "Joe Warmington", Catalan "abans de Crist"). Solve
// at the data layer — onboard targets with full-name + multi-token
// aliases only. See match.test.js for the explicit "this is a corpus
// issue, not a matcher issue" test.
function matchTargets(text, targets) {
  if (!text || !targets || !targets.length) return [];
  const t = String(text);
  const hits = [];
  for (const tgt of targets) {
    const candidates = [tgt.name, ...(tgt.aliases || [])].filter(Boolean);
    for (const c of candidates) {
      if (matchOne(t, c)) {
        hits.push({ target: tgt, alias: c });
        break;                                  // one match per target is enough
      }
    }
  }
  return hits;
}

function matchOne(text, alias) {
  const a = String(alias).trim();
  if (!a || a.length < 2) return false;
  // Escape regex metachars in alias, then bracket with non-word boundaries.
  // Boundary class is Unicode-aware (\p{L} = any letter, \p{N} = any
  // digit, /u flag) so accented characters like 'ó' in "Cristóbal" count
  // as letters and prevent the right-boundary from matching prefix
  // collisions across language boundaries.
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, 'iu');
  return re.test(text);
}

module.exports = { matchTargets, matchOne };
