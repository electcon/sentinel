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
// non-alphanumeric as a boundary.
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
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i');
  return re.test(text);
}

module.exports = { matchTargets, matchOne };
