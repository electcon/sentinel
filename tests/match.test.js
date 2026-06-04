// tests/match.test.js
// Run with: node --test tests/

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { matchOne, matchTargets } = require('../lib/match');

test('matchOne: exact word match', () => {
  assert.ok(matchOne('Cinde Warmington spoke today', 'Cinde Warmington'));
});

test('matchOne: case insensitive', () => {
  assert.ok(matchOne('CINDE WARMINGTON SPOKE', 'Cinde Warmington'));
  assert.ok(matchOne('cinde warmington spoke', 'Cinde Warmington'));
});

test('matchOne: word-boundary (no false positive on substring)', () => {
  // "Crist" should NOT match within "Christ" — 'h' after 'C' breaks the alias.
  // (And "Crist" is not actually a substring of "Christ" anyway.)
  assert.ok(!matchOne('Christmas dinner', 'Crist'));
});

test('matchOne: word-boundary (literal "Crist" matches in religious text)', () => {
  // The Catalan "abans de Crist" literally contains "Crist" — this is
  // NOT a false positive at the matcher level; it's a corpus issue
  // solved by not searching for bare aliases like "Crist".
  assert.ok(matchOne('abans de Crist, the city', 'Crist'));
});

test('matchOne: matches with surrounding punctuation', () => {
  assert.ok(matchOne('@Laubacher!', 'Laubacher'));
  assert.ok(matchOne('Mr. Laubacher.', 'Laubacher'));
  assert.ok(matchOne('"Laubacher"', 'Laubacher'));
});

test('matchOne: no match when alias is part of a larger word', () => {
  assert.ok(!matchOne('Laubachersville', 'Laubacher'));
  assert.ok(!matchOne('preLaubacher', 'Laubacher'));
});

test('matchOne: Unicode boundary — accented letter is part of word', () => {
  // Pre-Unicode-fix the boundary regex was [^A-Za-z0-9], so 'ó' read as a
  // non-word char and "Cristóbal" matched alias "Crist". Real false
  // positives observed in production Bluesky digest. Now /u + \p{L}\p{N}
  // treats 'ó' / 'ã' / 'ñ' / etc. as letters, so the boundary fails.
  assert.ok(!matchOne('Cristóbal Colón fundó la ciudad', 'Crist'));
  assert.ok(!matchOne('um cristão devoto', 'Crist'));
  assert.ok(!matchOne('Maria Cristina Núñez', 'Crist'));
  // Sanity: still matches when the surrounding char IS a non-letter
  // (the original test contract — "Crist" alone in punctuated text).
  assert.ok(matchOne('abans de Crist, the city', 'Crist'));
  assert.ok(matchOne('"Crist" is the alias', 'Crist'));
});

test('matchOne: rejects too-short aliases', () => {
  // 1-char aliases rejected to prevent absurd false-positive volume.
  assert.ok(!matchOne('I said yes', 'I'));
  assert.ok(!matchOne('hello', ''));
  // 2+ chars are allowed; 'CW' as an alias would match here.
  assert.ok(matchOne('CW spoke today', 'CW'));
});

test('matchOne: regex metacharacters in alias are escaped', () => {
  assert.ok(matchOne('vote for John (R)', 'John (R)'));
  assert.ok(!matchOne('vote for John', 'John (R)'));
});

test('matchTargets: returns first matching target only', () => {
  const targets = [
    { id: '1', name: 'Cinde Warmington', aliases: ['Warmington'] },
    { id: '2', name: 'Eileen Laubacher', aliases: ['Laubacher'] }
  ];
  const hits = matchTargets('Warmington and Laubacher are debating tomorrow', targets);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].target.name, 'Cinde Warmington');
});

test('matchTargets: prefers canonical name over alias', () => {
  const targets = [
    { id: '1', name: 'Eileen Laubacher', aliases: ['Laubacher'] }
  ];
  const hits = matchTargets('Eileen Laubacher spoke', targets);
  assert.equal(hits[0].alias, 'Eileen Laubacher');
});

test('matchTargets: empty input', () => {
  assert.deepEqual(matchTargets('', [{ name: 'X', aliases: [] }]), []);
  assert.deepEqual(matchTargets('text', []), []);
  assert.deepEqual(matchTargets(null, null), []);
});
