// tests/api-key.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { generateKey, hashKey, PREFIX } = require('../lib/api-key');

test('generateKey produces sk_<32 hex>', () => {
  const { fullKey, keyPrefix, keyHash } = generateKey();
  assert.match(fullKey, /^sk_[a-f0-9]{32}$/);
  assert.equal(fullKey.length, 35);
  assert.equal(keyPrefix.length, 12);
  assert.equal(keyPrefix, fullKey.slice(0, 12));
  assert.match(keyHash, /^[a-f0-9]{64}$/);
});

test('generateKey is unique across invocations', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const { fullKey } = generateKey();
    assert.ok(!seen.has(fullKey), 'collision');
    seen.add(fullKey);
  }
});

test('hashKey is deterministic', () => {
  const { fullKey, keyHash } = generateKey();
  assert.equal(hashKey(fullKey), keyHash);
  assert.equal(hashKey(fullKey), hashKey(fullKey));
});

test('hashKey differs for different inputs', () => {
  const { fullKey: a } = generateKey();
  const { fullKey: b } = generateKey();
  assert.notEqual(hashKey(a), hashKey(b));
});

test('prefix is the constant sk_', () => {
  assert.equal(PREFIX, 'sk_');
  const { fullKey } = generateKey();
  assert.ok(fullKey.startsWith(PREFIX));
});

test('keyHash is not the same as keyPrefix or full key', () => {
  const { fullKey, keyPrefix, keyHash } = generateKey();
  assert.notEqual(keyHash, fullKey);
  assert.notEqual(keyHash, keyPrefix);
});

test('hashKey on null/empty does not crash', () => {
  // Should produce a deterministic hash of empty string, not throw.
  const h = hashKey('');
  assert.match(h, /^[a-f0-9]{64}$/);
});
