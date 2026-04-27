// scripts/provision-customer.js
// Idempotent customer provisioning. Reads a JSON spec, creates or
// updates one customer row + their targets, sets the shared login
// password, prints login URL.
//
// Usage:
//   node scripts/provision-customer.js path/to/customer.json
//
// JSON shape:
// {
//   "name":          "Jolly for Governor",
//   "contact_email": "manager@jollyforgov.com",
//   "alert_email":   "alerts@jollyforgov.com",       // tier 3+ alerts
//   "digest_email":  "digest@jollyforgov.com",       // daily summary
//   "password":      "shared-strong-password",       // ≥ 8 chars
//   "status":        "beta",                          // 'beta' | 'active' | 'paused'
//   "targets": [
//     {
//       "kind":         "candidate",                  // 'candidate' | 'family' | 'staff' | 'surrogate'
//       "name":         "Charlie Jolly",
//       "aliases":      ["Jolly", "Charlie"],
//       "search_terms": ["Charlie Jolly", "Jolly for Governor"]
//     },
//     ...
//   ]
// }
//
// On success prints:
//   customer_id: <uuid>
//   login URL:   <DASHBOARD_BASE_URL>/login
//   shared password: <password> (write down — not stored as plaintext)

'use strict';

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { hashPassword } = require('../lib/auth');

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/provision-customer.js path/to/customer.json'); process.exit(2); }

  const abs = path.resolve(file);
  const spec = JSON.parse(fs.readFileSync(abs, 'utf8'));
  validateSpec(spec);

  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(2); }
  const useSSL = /render\.com/.test(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : false });

  // password_hash column is in the schema; ensure it exists for any DB
  // that was provisioned before lib/auth landed.
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS targets_customer_name ON targets (customer_id, name)`);

  const passwordHash = await hashPassword(spec.password);

  // Find-or-create customer by name. Customer names should be unique
  // in practice (real campaigns) but we don't enforce a UNIQUE
  // constraint on customers.name because campaign-of-the-same-name
  // edge cases can exist.
  const existing = await pool.query('SELECT id FROM customers WHERE name = $1 LIMIT 1', [spec.name]);
  let customerId;
  if (existing.rowCount > 0) {
    customerId = existing.rows[0].id;
    await pool.query(`
      UPDATE customers
      SET contact_email = $2, alert_email = $3, digest_email = $4, status = $5, password_hash = $6
      WHERE id = $1
    `, [customerId, spec.contact_email, spec.alert_email, spec.digest_email, spec.status || 'beta', passwordHash]);
    console.log('[provision] customer updated:', customerId);
  } else {
    const ins = await pool.query(`
      INSERT INTO customers (name, contact_email, alert_email, digest_email, status, password_hash)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [spec.name, spec.contact_email, spec.alert_email, spec.digest_email, spec.status || 'beta', passwordHash]);
    customerId = ins.rows[0].id;
    console.log('[provision] customer created:', customerId);
  }

  for (const t of (spec.targets || [])) {
    const r = await pool.query(`
      INSERT INTO targets (customer_id, kind, name, aliases, search_terms)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      ON CONFLICT (customer_id, name) DO UPDATE
      SET aliases = EXCLUDED.aliases,
          search_terms = EXCLUDED.search_terms,
          kind = EXCLUDED.kind
      RETURNING id, (xmax = 0) AS inserted
    `, [customerId, t.kind || 'candidate', t.name, JSON.stringify(t.aliases || []), JSON.stringify(t.search_terms || [])]);
    console.log(`[provision] target "${t.name}" ${r.rows[0].inserted ? 'created' : 'updated'}: ${r.rows[0].id}`);
  }

  const loginUrl = (process.env.DASHBOARD_BASE_URL || 'https://sentinel-staging-i3ug.onrender.com') + '/login';
  console.log('');
  console.log('-----');
  console.log('customer_id:    ', customerId);
  console.log('customer name:  ', spec.name);
  console.log('login URL:      ', loginUrl);
  console.log('shared password:', spec.password);
  console.log('alert email:    ', spec.alert_email);
  console.log('digest email:   ', spec.digest_email);
  console.log('targets:        ', (spec.targets || []).length);
  console.log('-----');

  // Optional: send a welcome email if Resend is configured AND --send-welcome
  // is passed. Default OFF so manually re-running this script doesn't spam.
  if (process.env.RESEND_API_KEY && process.argv.includes('--send-welcome')) {
    try {
      await sendWelcomeEmail({ spec, loginUrl });
      console.log('[provision] welcome email sent →', spec.contact_email);
    } catch (e) {
      console.error('[provision] welcome email FAILED:', e.message);
    }
  } else {
    console.log('Send the login URL + shared password to the customer via a secure channel.');
    console.log('Do NOT email the password as plaintext if avoidable.');
    if (process.env.RESEND_API_KEY) {
      console.log('Or: re-run with --send-welcome to send the templated welcome email.');
    }
  }

  await pool.end();
}

async function sendWelcomeEmail({ spec, loginUrl }) {
  const { sendWelcome } = require('../lib/welcome');
  const out = await sendWelcome({
    to: spec.contact_email,
    customerName: spec.name,
    password: spec.password,
    loginUrl,
    alertEmail: spec.alert_email,
    digestEmail: spec.digest_email,
    targets: spec.targets || []
  });
  if (!out.ok) throw new Error(out.error || 'send failed');
  return out;
}

function validateSpec(s) {
  const required = ['name', 'contact_email', 'alert_email', 'digest_email', 'password'];
  for (const k of required) {
    if (!s[k]) throw new Error(`missing required field: ${k}`);
  }
  if (s.password.length < 8) throw new Error('password must be ≥ 8 chars');
  if (!Array.isArray(s.targets) || !s.targets.length) throw new Error('targets[] required and non-empty');
  for (const t of s.targets) {
    if (!t.name) throw new Error('every target needs a name');
    if (t.aliases && !Array.isArray(t.aliases)) throw new Error(`target ${t.name}: aliases must be an array`);
    if (t.search_terms && !Array.isArray(t.search_terms)) throw new Error(`target ${t.name}: search_terms must be an array`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[provision] FAIL:', e.message); process.exit(1); });
}
