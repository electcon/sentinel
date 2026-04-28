# Stripe — onboarding (v1: operator-driven subscriptions)

Code is shipped. Sentinel uses Stripe Checkout Sessions for subscription
creation (no PCI scope on our side — customer enters their card on
Stripe's domain, not ours).

## Architecture

```
Operator clicks "Create Stripe customer"
   → POST /admin/customers/:id/stripe-create-customer
   → Stripe Customer object created (or fetched if exists)
   → customers.stripe_customer_id persisted

Operator clicks "Send checkout link"
   → POST /admin/customers/:id/stripe-checkout
   → Checkout Session created with monthly $500 subscription
   → Operator copies the URL + emails to campaign manager

Customer enters card
   → Stripe webhook fires customer.subscription.created
   → /api/stripe-webhook updates customers.billing_status='active'
   → customers.stripe_subscription_id persisted

Monthly invoice paid → webhook keeps billing_status='active'
Failed payment → webhook flips to 'past_due' (visible in /admin/customers)
```

## Setup (one-time, ~10 minutes)

### 1. Get keys from Stripe dashboard

If you don't already have a Sentinel-specific Stripe account, create one
at https://dashboard.stripe.com (Parallax Advisory LLC entity, separate
from VoteROI / AMII PAC).

- **Test keys** for first deploy: https://dashboard.stripe.com/test/apikeys
  - `Publishable key` → starts `pk_test_…`
  - `Secret key` → starts `sk_test_…`
- **Live keys** for production: https://dashboard.stripe.com/apikeys
  - `pk_live_…` and `sk_live_…`

**Strongly recommended:** start with test keys. Verify the full flow works
end-to-end (create customer → send checkout → enter test card 4242 4242 4242 4242
→ webhook fires → status flips to active) before swapping to live keys.

### 2. Set on Render

| Env var | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` (or `sk_live_…`) |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` (or `pk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | (set in step 4 below) |

### 3. Verify the SDK works

After Render redeploys, hit the admin overview. The `Billing` panel on
any customer detail page should now show a green/red `stripe test` /
`stripe live` chip. If it says "stripe not configured," the key didn't
load — recheck the env var on Render.

### 4. Create the Stripe webhook endpoint

1. Stripe dashboard → Developers → Webhooks → **Add endpoint**
2. Endpoint URL: `https://sentinel.parallaxadvisory.llc/api/stripe-webhook`
3. Events to listen to (select these):
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
4. Click **Add endpoint**
5. Click into the new endpoint → **Signing secret** → click **Reveal**
6. Copy the value (starts with `whsec_…`) → paste to Render as `STRIPE_WEBHOOK_SECRET`
7. Render auto-redeploys. Webhook is now signature-verified.

### 5. End-to-end test (test mode)

1. Provision a test customer via `/admin/provision` with your own email
2. Click **+ Create Stripe customer** → see green flash + chip flip
3. Click **→ Send checkout link** → confirmation page with URL
4. Open the URL in a new tab → enter test card `4242 4242 4242 4242` (any CVC, any future date, any zip)
5. Stripe redirects you to `/admin/customers/:id?ok=Subscription+activated`
6. Refresh — billing_status should now be `active` (webhook fired)
7. Stripe dashboard → Customers → find the customer → confirm subscription is `Active`

### 6. Go live

When you're ready to take real money:
1. Stripe dashboard → toggle to **Live mode** (top-left switch)
2. Repeat steps 1–4 above using LIVE keys (separate webhook endpoint required for live mode)
3. Set `STRIPE_SECRET_KEY=sk_live_…`, `STRIPE_PUBLISHABLE_KEY=pk_live_…`, `STRIPE_WEBHOOK_SECRET=whsec_…` (live)
4. Run a $5 real subscription on yourself first to confirm before sending checkout links to actual betas

## Pricing

Default: **$500/month**, USD. Override via env vars before first run:
- `STRIPE_BETA_PRICE_USD=500` (integer)
- `STRIPE_BETA_PRICE_INTERVAL=month` (`month` or `year`)

The Product + Price are created idempotently on first call (looked up by
`metadata.sentinel_key`). Re-deploys never duplicate them.

## What about $2K and $5K tiers?

Sprint 3 work. Add a second product (`sentinel_pro_2000_month`) with
its own price; expose tier selection on the customer page (or in a
self-serve signup flow). Schema already supports this — just need
multiple Price IDs and a UI to pick.

## What about the Stripe billing portal for self-service?

Sprint 3. Will surface a button on `/dashboard/settings` that creates
a Stripe billing-portal session — lets customers update their card
without operator involvement.

## Troubleshooting

- **"Stripe not configured" banner on /admin/customers/:id** — `STRIPE_SECRET_KEY` missing on Render.
- **"signature verification failed" in webhook logs** — `STRIPE_WEBHOOK_SECRET` doesn't match. Recopy from Stripe dashboard.
- **Webhook 503 in Stripe dashboard** — `STRIPE_WEBHOOK_SECRET` env var not set yet. Set it; Stripe will retry automatically.
- **Customer enters checkout but billing_status doesn't flip to active** — webhook isn't reaching us OR signature is failing. Check Stripe dashboard → Webhooks → Recent deliveries.
