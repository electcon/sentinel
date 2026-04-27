// tests/classify.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractFirstJsonObject } = require('../classify');

test('plain JSON object', () => {
  const r = extractFirstJsonObject('{"tier":2,"confidence":0.9}');
  assert.equal(r, '{"tier":2,"confidence":0.9}');
});

test('strips markdown code fences', () => {
  const r = extractFirstJsonObject('```json\n{"tier":2}\n```');
  assert.equal(JSON.parse(r).tier, 2);
});

test('handles trailing prose (the previous-bug case)', () => {
  const input = '```json\n{"tier":2,"confidence":0.92}\n```\n\n**Reasoning:**\n- Family attack';
  const r = extractFirstJsonObject(input);
  const parsed = JSON.parse(r);
  assert.equal(parsed.tier, 2);
  assert.equal(parsed.confidence, 0.92);
});

test('handles leading prose', () => {
  const r = extractFirstJsonObject('Sure, here you go: {"tier":3,"x":1}');
  assert.equal(JSON.parse(r).tier, 3);
});

test('handles nested objects', () => {
  const input = '{"a":{"b":{"c":1}},"tier":4}';
  const r = extractFirstJsonObject(input);
  assert.equal(r, input);
});

test('handles braces inside string literals', () => {
  const r = extractFirstJsonObject('{"r":"this } char","tier":1}');
  assert.equal(JSON.parse(r).r, 'this } char');
  assert.equal(JSON.parse(r).tier, 1);
});

test('handles escaped quotes in strings', () => {
  const r = extractFirstJsonObject('{"r":"says \\"hi\\"","tier":1}');
  assert.equal(JSON.parse(r).r, 'says "hi"');
});

test('returns empty string on no JSON', () => {
  assert.equal(extractFirstJsonObject('completely off the rails'), '');
  assert.equal(extractFirstJsonObject(''), '');
  assert.equal(extractFirstJsonObject(null), '');
});

test('returns empty on unbalanced braces', () => {
  // Open brace but never closed → unbalanced → empty
  assert.equal(extractFirstJsonObject('{"tier":2'), '');
});
