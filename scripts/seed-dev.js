// scripts/seed-dev.js
// One-off: ensure a "Sentinel Dev" test customer exists with a few
// real-world targets we can search Reddit for. Idempotent — re-running
// upserts the customer + targets without duplicating.
//
// Used to verify the Reddit / Bluesky / RSS workers end-to-end before
// real beta customers (Jolly, Sands, Laubacher) are onboarded.
//
// Run: `node scripts/seed-dev.js`

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { hashPassword } = require('../lib/auth');

const DEV_CUSTOMER = {
  name: 'Sentinel Dev (test)',
  contact_email: 'david@voteroi.com',
  alert_email: 'david@voteroi.com',
  digest_email: 'david@voteroi.com',
  status: 'beta'
};

// Default dev login password. Anyone with shell access to the deployed
// service or the GitHub repo can read this — it exists ONLY to make
// the staging dev customer easy to log in as. Real beta customers go
// through scripts/provision-customer.js with their own passwords.
const DEV_PASSWORD = process.env.SENTINEL_DEV_PASSWORD || 'sentinel-dev-2026';

// Real public political figures who get a steady volume of Reddit
// mentions — good for verifying search hits land. None of these are
// our actual beta customers; they're just convenient public figures
// we can search against without ingesting random civilians' content.
const DEV_TARGETS = [
  {
    kind: 'candidate',
    name: 'Cinde Warmington',
    aliases: ['Warmington', 'Cinde'],
    search_terms: ['Cinde Warmington']
  },
  {
    kind: 'candidate',
    name: 'Eileen Laubacher',
    aliases: ['Laubacher'],
    search_terms: ['Laubacher']
  },
  {
    kind: 'candidate',
    name: 'Charlie Crist',
    aliases: ['Crist'],
    search_terms: ['Charlie Crist']
  }
];

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(2); }
  const useSSL = /render\.com/.test(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false
  });

  // Schema may pre-date password_hash column; idempotent ALTER.
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT`);

  const passwordHash = await hashPassword(DEV_PASSWORD);

  // Find-or-create the dev customer. We don't use ON CONFLICT here
  // because there's no unique constraint on customers.name in v1
  // (real customers can legitimately share names). The dev customer
  // is identified by a name string we control.
  const existing = await pool.query('SELECT id FROM customers WHERE name = $1 LIMIT 1', [DEV_CUSTOMER.name]);
  let customerId;
  if (existing.rowCount > 0) {
    customerId = existing.rows[0].id;
    await pool.query('UPDATE customers SET password_hash = $2 WHERE id = $1', [customerId, passwordHash]);
    console.log('[seed] customer exists (password reset):', customerId);
  } else {
    const ins = await pool.query(`
      INSERT INTO customers (name, contact_email, alert_email, digest_email, status, password_hash)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [DEV_CUSTOMER.name, DEV_CUSTOMER.contact_email, DEV_CUSTOMER.alert_email, DEV_CUSTOMER.digest_email, DEV_CUSTOMER.status, passwordHash]);
    customerId = ins.rows[0].id;
    console.log('[seed] customer created:', customerId);
  }
  console.log('[seed] login: ' + DEV_CUSTOMER.contact_email + ' / ' + DEV_PASSWORD);

  // Upsert each target. There's no natural unique key on (customer_id, name)
  // yet — add one if not present so we can ON CONFLICT.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS targets_customer_name ON targets (customer_id, name)
  `);

  for (const t of DEV_TARGETS) {
    const r = await pool.query(`
      INSERT INTO targets (customer_id, kind, name, aliases, search_terms)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      ON CONFLICT (customer_id, name) DO UPDATE
      SET aliases = EXCLUDED.aliases,
          search_terms = EXCLUDED.search_terms,
          kind = EXCLUDED.kind
      RETURNING id
    `, [customerId, t.kind, t.name, JSON.stringify(t.aliases), JSON.stringify(t.search_terms)]);
    console.log(`[seed] target "${t.name}":`, r.rows[0].id);
  }

  await pool.end();
  console.log('[seed] done');
}

if (require.main === module) {
  main().catch(e => { console.error('[seed] FAIL:', e.message); process.exit(1); });
}
