// tests/stripe-client.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// We test the pure helpers (isConfigured, getMode, mapSubscriptionStatus)
// without invoking the Stripe SDK. Toggle env around each case.

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// Force a fresh require so module-level state (the lazy _stripe cache)
// can't leak across tests.
function freshRequire() {
  const p = require.resolve('../lib/stripe-client');
  delete require.cache[p];
  return require('../lib/stripe-client');
}

test('isConfigured: false when STRIPE_SECRET_KEY unset', () => {
  withEnv('STRIPE_SECRET_KEY', undefined, () => {
    const sc = freshRequire();
    assert.equal(sc.isConfigured(), false);
  });
});

test('isConfigured: true when STRIPE_SECRET_KEY set', () => {
  withEnv('STRIPE_SECRET_KEY', 'sk_test_xyz', () => {
    const sc = freshRequire();
    assert.equal(sc.isConfigured(), true);
  });
});

test('getMode: live for sk_live_*', () => {
  withEnv('STRIPE_SECRET_KEY', 'sk_live_abc123', () => {
    const sc = freshRequire();
    assert.equal(sc.getMode(), 'live');
  });
});

test('getMode: test for sk_test_*', () => {
  withEnv('STRIPE_SECRET_KEY', 'sk_test_abc123', () => {
    const sc = freshRequire();
    assert.equal(sc.getMode(), 'test');
  });
});

test('getMode: null for unset or unknown prefix', () => {
  withEnv('STRIPE_SECRET_KEY', undefined, () => {
    const sc = freshRequire();
    assert.equal(sc.getMode(), null);
  });
  withEnv('STRIPE_SECRET_KEY', 'rk_garbage', () => {
    const sc = freshRequire();
    assert.equal(sc.getMode(), null);
  });
});

test('mapSubscriptionStatus: active/trialing pass through', () => {
  const { mapSubscriptionStatus } = freshRequire();
  assert.equal(mapSubscriptionStatus('active'), 'active');
  assert.equal(mapSubscriptionStatus('trialing'), 'trialing');
});

test('mapSubscriptionStatus: past_due/unpaid/incomplete/paused -> past_due', () => {
  const { mapSubscriptionStatus } = freshRequire();
  assert.equal(mapSubscriptionStatus('past_due'), 'past_due');
  assert.equal(mapSubscriptionStatus('unpaid'), 'past_due');
  assert.equal(mapSubscriptionStatus('incomplete'), 'past_due');
  assert.equal(mapSubscriptionStatus('paused'), 'past_due');
});

test('mapSubscriptionStatus: canceled and incomplete_expired -> canceled', () => {
  const { mapSubscriptionStatus } = freshRequire();
  assert.equal(mapSubscriptionStatus('canceled'), 'canceled');
  assert.equal(mapSubscriptionStatus('incomplete_expired'), 'canceled');
});

test('mapSubscriptionStatus: unknown -> free_beta (safe default)', () => {
  const { mapSubscriptionStatus } = freshRequire();
  assert.equal(mapSubscriptionStatus('something_new_in_2027'), 'free_beta');
  assert.equal(mapSubscriptionStatus(undefined), 'free_beta');
  assert.equal(mapSubscriptionStatus(null), 'free_beta');
});

test('stripe(): throws when not configured (does not import SDK)', () => {
  withEnv('STRIPE_SECRET_KEY', undefined, () => {
    const sc = freshRequire();
    assert.throws(() => sc.stripe(), /STRIPE_SECRET_KEY not set/);
  });
});

test('constructWebhookEvent: throws when STRIPE_WEBHOOK_SECRET unset', () => {
  withEnv('STRIPE_WEBHOOK_SECRET', undefined, () => {
    withEnv('STRIPE_SECRET_KEY', 'sk_test_xyz', () => {
      const sc = freshRequire();
      // Should fail at the secret check, before invoking Stripe SDK.
      assert.throws(() => sc.constructWebhookEvent('{}', 't=0,v1=abc'), /STRIPE_WEBHOOK_SECRET not set/);
    });
  });
});
