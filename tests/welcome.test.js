// tests/welcome.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildEmail } = require('../lib/welcome');

function fixture(overrides = {}) {
  return {
    to: 'manager@example.com',
    customerName: 'Laubacher for U.S. House CO-04',
    password: 'temp-CHANGE-ME-9k',
    loginUrl: 'https://sentinel.parallaxadvisory.llc/login',
    alertEmail: 'alerts@example.com',
    digestEmail: 'digest@example.com',
    targets: [
      { name: 'Trish Laubacher', kind: 'candidate' },
      { name: 'Jane Laubacher', kind: 'family' }
    ],
    ...overrides
  };
}

test('buildEmail: subject names the customer', () => {
  const { subject } = buildEmail(fixture());
  assert.equal(subject, 'Welcome to Sentinel — Laubacher for U.S. House CO-04');
});

test('buildEmail: text body contains login URL + email + password', () => {
  const { text } = buildEmail(fixture());
  assert.match(text, /Login: https:\/\/sentinel\.parallaxadvisory\.llc\/login/);
  assert.match(text, /Email: manager@example\.com/);
  assert.match(text, /Password: temp-CHANGE-ME-9k/);
});

test('buildEmail: text body lists each target with kind', () => {
  const { text } = buildEmail(fixture());
  assert.match(text, /- Trish Laubacher \(candidate\)/);
  assert.match(text, /- Jane Laubacher \(family\)/);
});

test('buildEmail: text body includes alert + digest emails', () => {
  const { text } = buildEmail(fixture());
  assert.match(text, /Tier-3\+ real-time alerts -> alerts@example\.com/);
  assert.match(text, /Daily digest -> digest@example\.com/);
});

test('buildEmail: html escapes login URL (XSS guard)', () => {
  // Pathological loginUrl with HTML in it — should be escaped, not executed.
  const { html } = buildEmail(fixture({ loginUrl: 'https://x.test/?q=<script>alert(1)</script>' }));
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('buildEmail: html escapes target name (XSS guard)', () => {
  const { html } = buildEmail(fixture({
    targets: [{ name: '"><img src=x onerror=alert(1)>', kind: 'candidate' }]
  }));
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('buildEmail: html escapes password (in case it contains < or &)', () => {
  const { html } = buildEmail(fixture({ password: 'a<b&c' }));
  assert.doesNotMatch(html, /a<b&c/);
  assert.match(html, /a&lt;b&amp;c/);
});

test('buildEmail: html targets list emits one <li> per target', () => {
  const { html } = buildEmail(fixture());
  const matches = html.match(/<li>[^<]*Laubacher/g) || [];
  assert.equal(matches.length, 2);
});

test('buildEmail: text body explains tier behavior', () => {
  const { text } = buildEmail(fixture());
  assert.match(text, /Tier 1 \(noise\)/);
  assert.match(text, /Tier 2 \(hostile rhetoric\)/);
  assert.match(text, /Tier 3\+/);
  assert.match(text, /under 5 min/);
});

test('buildEmail: text body signs off "David Wheeler"', () => {
  const { text } = buildEmail(fixture());
  assert.match(text, /David Wheeler/);
  assert.match(text, /Parallax Advisory LLC/);
});

test('buildEmail: target with missing kind defaults to candidate in text', () => {
  const { text } = buildEmail(fixture({ targets: [{ name: 'Solo Candidate' }] }));
  assert.match(text, /- Solo Candidate \(candidate\)/);
});
