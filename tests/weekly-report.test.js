// tests/weekly-report.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildEmail } = require('../lib/weekly-report');

function fixture(overrides = {}) {
  return {
    customer: { id: 'c1', name: 'Sands for Governor' },
    week_start: new Date('2026-04-19T00:00:00Z'),
    week_end:   new Date('2026-04-25T23:59:59Z'),
    mentions: {
      total: 120,
      by_tier:   { 1: 90, 2: 22, 3: 7, 4: 1 },
      by_source: { reddit: 50, bluesky: 40, x: 20, rss: 10 }
    },
    prev_week: { total: 100 },
    threats:   { raised: 8, currently_open: 3, resolved: 5 },
    reviews:   { total: 24, dismissed: 14, escalated: 4, ongoing_campaign: 6 },
    top_targets: [
      { name: 'Sands', count: 80 },
      { name: 'Spouse', count: 25 },
      { name: 'Chief of Staff', count: 15 }
    ],
    ...overrides
  };
}

test('buildEmail: subject names customer + week-start', () => {
  const { subject } = buildEmail(fixture());
  assert.match(subject, /Sentinel weekly/);
  assert.match(subject, /Sands for Governor/);
  assert.match(subject, /2026-04-19/);
});

test('buildEmail: trend "↑ 20% vs previous week" when up 20%', () => {
  const { text } = buildEmail(fixture({ mentions: { ...fixture().mentions, total: 120 }, prev_week: { total: 100 } }));
  assert.match(text, /↑ 20% vs previous week/);
});

test('buildEmail: trend "↓ 50% vs previous week" when down 50%', () => {
  const { text } = buildEmail(fixture({ mentions: { ...fixture().mentions, total: 50 }, prev_week: { total: 100 } }));
  assert.match(text, /↓ 50% vs previous week/);
});

test('buildEmail: trend "~ flat" when within 5%', () => {
  const { text } = buildEmail(fixture({ mentions: { ...fixture().mentions, total: 102 }, prev_week: { total: 100 } }));
  assert.match(text, /~ flat week-over-week/);
});

test('buildEmail: trend "first full week" when prev_week.total is 0', () => {
  const { text } = buildEmail(fixture({ prev_week: { total: 0 } }));
  assert.match(text, /first full week of data/);
});

test('buildEmail: trend "no activity" when both weeks are 0', () => {
  const { text } = buildEmail(fixture({
    mentions: { total: 0, by_tier: {}, by_source: {} },
    prev_week: { total: 0 }
  }));
  assert.match(text, /— no activity/);
});

test('buildEmail: text body lists tiers in T4..T1 order', () => {
  const { text } = buildEmail(fixture());
  const i4 = text.indexOf('Tier 4:');
  const i3 = text.indexOf('Tier 3:');
  const i2 = text.indexOf('Tier 2:');
  const i1 = text.indexOf('Tier 1:');
  assert.ok(i4 < i3 && i3 < i2 && i2 < i1);
});

test('buildEmail: html escapes customer name (XSS guard)', () => {
  const { html } = buildEmail(fixture({ customer: { id: 'x', name: '<img onerror=alert(1)>' } }));
  assert.doesNotMatch(html, /<img onerror=alert\(1\)>/);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
});

test('buildEmail: html escapes target names in top-targets list', () => {
  const { html } = buildEmail(fixture({
    top_targets: [{ name: '"><script>x</script>', count: 1 }]
  }));
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('buildEmail: text body lists top-targets in input order with rank prefix', () => {
  const { text } = buildEmail(fixture());
  assert.match(text, /1\. Sands — 80/);
  assert.match(text, /2\. Spouse — 25/);
  assert.match(text, /3\. Chief of Staff — 15/);
});

test('buildEmail: empty top_targets renders fallback line', () => {
  const { text } = buildEmail(fixture({ top_targets: [] }));
  assert.match(text, /\(no targets had mentions\)/);
});

test('buildEmail: review activity numbers all present in text body', () => {
  const { text } = buildEmail(fixture());
  assert.match(text, /total reviews:\s+24/);
  assert.match(text, /dismissed:\s+14/);
  assert.match(text, /escalated to T3:\s+4/);
  assert.match(text, /ongoing-campaign:\s+6/);
});
