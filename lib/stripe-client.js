// lib/stripe-client.js
// Stripe SDK wrapper. Initializes the client lazily so the server
// boots fine when STRIPE_SECRET_KEY is unset (Stripe features are
// optional gating). Exposes:
//   - stripe()                        — the Stripe SDK instance
//   - isConfigured()                  — true iff STRIPE_SECRET_KEY set
//   - getMode()                       — 'live' | 'test' | null (from key prefix)
//   - ensureBetaProduct(opts)         — idempotent product+price get-or-create
//   - createSubscriptionCheckout(...) — Stripe Checkout Session for monthly sub
//
// Sentinel uses Stripe Subscriptions (not one-time charges). The
// "Sentinel Beta" product has a single price ($500/mo by default).
// Customers are mapped 1:1 between our customers table and Stripe
// Customer objects via stripe_customer_id.

'use strict';

let _stripe = null;

function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getMode() {
  const k = process.env.STRIPE_SECRET_KEY || '';
  if (k.startsWith('sk_live_')) return 'live';
  if (k.startsWith('sk_test_')) return 'test';
  return null;
}

function stripe() {
  if (_stripe) return _stripe;
  if (!isConfigured()) throw new Error('STRIPE_SECRET_KEY not set');
  const Stripe = require('stripe');
  _stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
    appInfo: { name: 'Sentinel by Parallax Advisory LLC', version: '0.0.1' }
  });
  return _stripe;
}

// Idempotent product+price lookup-or-create. Tagged via metadata so
// we don't double-create across re-deploys. Returns
//   { product: <Stripe.Product>, price: <Stripe.Price> }
//
// Default price: $500/mo USD. Override with env vars
//   STRIPE_BETA_PRICE_USD       (default 500)
//   STRIPE_BETA_PRICE_INTERVAL  (default 'month'; 'year' valid)
async function ensureBetaProduct() {
  const s = stripe();
  const priceUsd = parseInt(process.env.STRIPE_BETA_PRICE_USD, 10) || 500;
  const interval = ['month', 'year'].includes(process.env.STRIPE_BETA_PRICE_INTERVAL) ? process.env.STRIPE_BETA_PRICE_INTERVAL : 'month';
  const productKey = `sentinel_beta_${priceUsd}_${interval}`;

  // Look up by metadata key
  const existing = await s.products.search({ query: `metadata['sentinel_key']:'${productKey}'`, limit: 1 });
  let product;
  if (existing.data && existing.data.length) {
    product = existing.data[0];
  } else {
    product = await s.products.create({
      name: 'Sentinel — defensive monitoring',
      description: 'Per-campaign defensive social-media + threat monitoring. Sentinel by Parallax Advisory LLC.',
      metadata: { sentinel_key: productKey, sentinel_amount_usd: String(priceUsd), sentinel_interval: interval }
    });
  }

  // Look up the price; if missing, create
  const prices = await s.prices.list({ product: product.id, active: true, limit: 10 });
  let price = (prices.data || []).find(p =>
    p.recurring && p.recurring.interval === interval && p.unit_amount === priceUsd * 100 && p.currency === 'usd'
  );
  if (!price) {
    price = await s.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: priceUsd * 100,
      recurring: { interval },
      metadata: { sentinel_key: productKey }
    });
  }
  return { product, price };
}

// Create or fetch a Stripe Customer for our customer record. Idempotent
// via the metadata.sentinel_customer_id field — even if our DB row was
// somehow created without stripe_customer_id, we can recover by search.
async function getOrCreateStripeCustomer({ id: sentinelCustomerId, name, contact_email, stripe_customer_id }) {
  const s = stripe();
  if (stripe_customer_id) {
    try {
      const c = await s.customers.retrieve(stripe_customer_id);
      if (!c.deleted) return c;
    } catch (_) { /* fall through to recreate */ }
  }
  // Search by metadata in case caller forgot to persist the ID
  try {
    const found = await s.customers.search({ query: `metadata['sentinel_customer_id']:'${sentinelCustomerId}'`, limit: 1 });
    if (found.data && found.data.length) return found.data[0];
  } catch (_) {}
  return s.customers.create({
    email: contact_email,
    name,
    metadata: { sentinel_customer_id: sentinelCustomerId }
  });
}

// Create a Checkout Session that, on completion, subscribes the
// customer to the beta price. We use Checkout (not raw subscription
// creation) so the customer enters their card themselves — no PCI
// scope on our side.
async function createSubscriptionCheckout({ customer, baseUrl, returnPath }) {
  const { price } = await ensureBetaProduct();
  const stripeCustomer = await getOrCreateStripeCustomer(customer);
  // returnPath defaults to the operator-driven dashboard return. Self-serve
  // signup overrides to '/signup/return' so the unauthenticated buyer sees
  // a "check your email" page instead of being bounced to /login.
  const ret = returnPath || '/dashboard/billing/return';
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomer.id,
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: `${baseUrl}${ret}?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}${ret}?status=cancel`,
    subscription_data: {
      metadata: {
        sentinel_customer_id: customer.id,
        customer_name: customer.name || ''
      }
    },
    metadata: { sentinel_customer_id: customer.id }
  });
  return { session, stripeCustomerId: stripeCustomer.id };
}

// Stripe Billing Portal: customers self-serve card updates, plan
// cancellation, invoice history. Returns a single-use URL valid for
// ~5 minutes — generate fresh on every "Manage billing" click.
async function createBillingPortalSession({ stripeCustomerId, returnUrl }) {
  const s = stripe();
  return s.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl
  });
}

// Verify and parse a webhook event. Throws on bad signature.
function constructWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}

// Map a Stripe subscription.status to our billing_status vocab.
function mapSubscriptionStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return stripeStatus;
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'incomplete':
    case 'paused':
      return 'past_due';
    default:
      return 'free_beta';
  }
}

module.exports = {
  stripe,
  isConfigured,
  getMode,
  ensureBetaProduct,
  getOrCreateStripeCustomer,
  createSubscriptionCheckout,
  createBillingPortalSession,
  constructWebhookEvent,
  mapSubscriptionStatus
};
