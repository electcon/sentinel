// tests/alert-slack.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildSlackPayload, sendThreatSlack } = require('../lib/alert');

const sample = {
  tier: 3,
  eventId: '00000000-0000-0000-0000-000000000abc',
  customer: { id: 'cust', name: 'Jolly for Governor' },
  target: { name: 'Bob Jolly', kind: 'candidate' },
  mention: {
    source: 'bluesky',
    source_url: 'https://bsky.app/profile/x/post/1',
    author_handle: '@hostile.bsky.social',
    posted_at: '2026-04-28T10:00:00Z',
    body_excerpt: 'something nasty',
    s3_key: 'evidence/2026/04/28/abc.json'
  },
  rationale: 'Doxxing — full home address posted'
};

test('buildSlackPayload: tier-3 -> amber color', () => {
  const p = buildSlackPayload(sample);
  assert.equal(p.attachments[0].color, '#d8902f');
});

test('buildSlackPayload: tier-4 -> deep red', () => {
  const p = buildSlackPayload({ ...sample, tier: 4 });
  assert.equal(p.attachments[0].color, '#7a1019');
});

test('buildSlackPayload: title contains tier label + target', () => {
  const p = buildSlackPayload(sample);
  assert.match(p.attachments[0].title, /TIER 3/);
  assert.match(p.attachments[0].title, /Bob Jolly/);
});

test('buildSlackPayload: title_link is the source URL', () => {
  const p = buildSlackPayload(sample);
  assert.equal(p.attachments[0].title_link, sample.mention.source_url);
});

test('buildSlackPayload: includes Source/Author/Customer/Posted fields', () => {
  const p = buildSlackPayload(sample);
  const titles = p.attachments[0].fields.map(f => f.title).sort();
  assert.deepEqual(titles, ['Author', 'Customer', 'Posted', 'Source']);
});

test('buildSlackPayload: clamps body_excerpt to 1500 chars', () => {
  const long = 'x'.repeat(3000);
  const p = buildSlackPayload({ ...sample, mention: { ...sample.mention, body_excerpt: long } });
  assert.equal(p.attachments[0].text.length, 1500);
});

test('buildSlackPayload: action button links to Sentinel dashboard event', () => {
  const p = buildSlackPayload(sample);
  const action = p.attachments[0].actions?.[0];
  assert.ok(action, 'expected an action button');
  assert.equal(action.text, 'Open in Sentinel');
  assert.match(action.url, /\/dashboard\/threats\/00000000-0000-0000-0000-000000000abc$/);
});

test('buildSlackPayload: ts derived from posted_at when present', () => {
  const p = buildSlackPayload(sample);
  // 2026-04-28T10:00:00Z → 1777629600
  assert.equal(p.attachments[0].ts, Math.floor(Date.parse('2026-04-28T10:00:00Z') / 1000));
});

test('buildSlackPayload: ts falls back to now when posted_at missing', () => {
  const before = Math.floor(Date.now() / 1000) - 1;
  const p = buildSlackPayload({ ...sample, mention: { ...sample.mention, posted_at: null } });
  const after = Math.floor(Date.now() / 1000) + 1;
  assert.ok(p.attachments[0].ts >= before && p.attachments[0].ts <= after);
});

test('sendThreatSlack: rejects non-Slack URL', async () => {
  const r = await sendThreatSlack({ ...sample, destination: 'https://example.com/hook' });
  assert.equal(r.ok, false);
  assert.match(r.error, /hooks\.slack\.com/);
});

test('sendThreatSlack: rejects missing URL', async () => {
  const r = await sendThreatSlack({ ...sample, destination: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no slack webhook URL/);
});

test('sendThreatSlack: returns ok on 2xx (mocked fetch)', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  try {
    const r = await sendThreatSlack({ ...sample, destination: 'https://hooks.slack.com/services/T/B/x' });
    assert.equal(r.ok, true);
    assert.equal(r.channel, 'slack');
  } finally {
    global.fetch = orig;
  }
});

test('sendThreatSlack: surfaces non-2xx error', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, text: async () => 'invalid_token' });
  try {
    const r = await sendThreatSlack({ ...sample, destination: 'https://hooks.slack.com/services/T/B/x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /slack 403/);
  } finally {
    global.fetch = orig;
  }
});
