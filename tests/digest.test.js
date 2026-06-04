// tests/digest.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildEmail } = require('../lib/digest');

function fixture(overrides = {}) {
  return {
    customer: { id: 'cust-1', name: 'Jolly for Governor' },
    windowHours: 24,
    totalMentions: 12,
    byTier: { 1: 8, 2: 3, 3: 1, 4: 0 },
    bySource: { reddit: 5, bluesky: 4, x: 3 },
    openThreats: 0,
    topMentions: [],
    reviewQueue: { pending: 0, oldest: [] },
    ...overrides
  };
}

test('buildEmail: subject reflects mention count when no threats / review', () => {
  const { subject } = buildEmail(fixture());
  assert.match(subject, /Sentinel digest/);
  assert.match(subject, /12 mentions/);
});

test('buildEmail: subject leads with open-threat count when present', () => {
  const { subject } = buildEmail(fixture({ openThreats: 2 }));
  assert.match(subject, /^\[2 open threats/);
});

test('buildEmail: subject pluralizes "threat" correctly for count of 1', () => {
  const { subject } = buildEmail(fixture({ openThreats: 1 }));
  assert.match(subject, /^\[1 open threat\b/);
  assert.doesNotMatch(subject, /1 open threats/);
});

test('buildEmail: subject combines threats + review-queue when both present', () => {
  const { subject } = buildEmail(fixture({ openThreats: 1, reviewQueue: { pending: 4, oldest: [] } }));
  assert.match(subject, /1 open threat/);
  assert.match(subject, /4 to review/);
});

test('buildEmail: text body includes the customer name', () => {
  const { text } = buildEmail(fixture());
  assert.match(text, /Jolly for Governor/);
});

test('buildEmail: text body shows tier counts in fixed order T4..T1', () => {
  const { text } = buildEmail(fixture());
  const i4 = text.indexOf('Tier 4');
  const i3 = text.indexOf('Tier 3');
  const i2 = text.indexOf('Tier 2');
  const i1 = text.indexOf('Tier 1');
  assert.ok(i4 < i3 && i3 < i2 && i2 < i1, 'tiers should appear T4 then T3 then T2 then T1');
});

test('buildEmail: html escapes customer name (XSS guard)', () => {
  const { html, text } = buildEmail(fixture({
    customer: { id: 'x', name: '<script>alert(1)</script>' }
  }));
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  // text body is plain — escape doesn't apply, but the tag should still
  // appear literally (no execution context).
  assert.match(text, /<script>/);
});

test('buildEmail: html escapes target name in top-mention bullets', () => {
  const top = [{
    tier: 3,
    target: '<img src=x onerror=alert(1)>',
    source: 'bluesky',
    source_url: 'https://bsky.app/p/1',
    body_excerpt: 'hello',
    posted_at: '2026-04-28T00:00:00Z'
  }];
  const { html } = buildEmail(fixture({ topMentions: top }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('buildEmail: html shows red threat banner when openThreats > 0', () => {
  const { html: with0 } = buildEmail(fixture({ openThreats: 0 }));
  const { html: with2 } = buildEmail(fixture({ openThreats: 2 }));
  assert.doesNotMatch(with0, /open threat event/i);
  assert.match(with2, /2 open threat events/);
  assert.match(with2, /#7a1019/);
});

test('buildEmail: html shows amber review banner when reviewQueue.pending > 0', () => {
  const { html } = buildEmail(fixture({ reviewQueue: { pending: 5, oldest: [] } }));
  assert.match(html, /5 Tier-2 mentions pending review/);
  assert.match(html, /#d8902f/);
});

test('buildEmail: top-mention body excerpts are clamped at 240 chars in html / 200 in text', () => {
  const long = 'x'.repeat(500);
  const top = [{ tier: 2, target: 'T', source: 's', source_url: 'http://x', body_excerpt: long, posted_at: '2026-01-01' }];
  const { html, text } = buildEmail(fixture({ topMentions: top }));
  // 240 x'es present, 241st absent.
  assert.match(html, new RegExp('x{240}'));
  assert.doesNotMatch(html, new RegExp('x{241}'));
  // 200 x'es in text, 201st absent.
  assert.match(text, new RegExp('x{200}'));
  assert.doesNotMatch(text, new RegExp('x{201}'));
});

test('buildEmail: empty topMentions renders "No mentions in window" in html', () => {
  const { html } = buildEmail(fixture({ topMentions: [] }));
  assert.match(html, /No mentions in window/);
});

test('buildEmail: dashboard link uses DASHBOARD_BASE_URL when set', () => {
  const prev = process.env.DASHBOARD_BASE_URL;
  process.env.DASHBOARD_BASE_URL = 'https://example-sentinel.test';
  try {
    // Re-require to pick up env at module scope (digest.js reads at call-time, no re-require needed)
    const { buildEmail: be } = require('../lib/digest');
    const { text } = be(fixture());
    assert.match(text, /https:\/\/example-sentinel\.test\/dashboard/);
  } finally {
    if (prev === undefined) delete process.env.DASHBOARD_BASE_URL;
    else process.env.DASHBOARD_BASE_URL = prev;
  }
});
