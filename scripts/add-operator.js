// scripts/add-operator.js
// Create or update an operator account for /admin and /admin/soc.
// Usage:
//   node scripts/add-operator.js --email you@example.com --name "Your Name" --password 'strong-pw' [--role admin|analyst|viewer]
//
// Roles for v1 are advisory only — all operators currently have full
// /admin access. Multi-tier role enforcement is a Phase 2 concern.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { Pool } = require('pg');
const { hashPassword } = require('../lib/auth');

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { out[k] = v; i++; }
      else { out[k] = true; }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const email = (args.email || '').toLowerCase().trim();
  const name = (args.name || '').trim();
  const password = args.password || '';
  const role = ['admin', 'analyst', 'viewer'].includes(args.role) ? args.role : 'analyst';

  if (!email || !name || !password) {
    console.error('usage: node scripts/add-operator.js --email you@example.com --name "Your Name" --password "strong-pw" [--role admin|analyst|viewer]');
    process.exit(2);
  }
  if (password.length < 8) { console.error('password must be ≥ 8 chars'); process.exit(2); }
  if (!/.+@.+\..+/.test(email)) { console.error('email must look like an email'); process.exit(2); }

  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(2); }
  const useSSL = /render\.com/.test(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : false });

  const passwordHash = await hashPassword(password);

  const r = await pool.query(`
    INSERT INTO operators (email, name, password_hash, role, active)
    VALUES ($1, $2, $3, $4, TRUE)
    ON CONFLICT (email) DO UPDATE
    SET name = EXCLUDED.name,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        active = TRUE
    RETURNING id, (xmax = 0) AS inserted
  `, [email, name, passwordHash, role]);

  const wasInsert = r.rows[0].inserted;
  console.log(`[add-operator] ${wasInsert ? 'created' : 'updated'} operator:`);
  console.log('  id:    ', r.rows[0].id);
  console.log('  email: ', email);
  console.log('  name:  ', name);
  console.log('  role:  ', role);
  console.log('');
  console.log('Login at: ' + ((process.env.DASHBOARD_BASE_URL || 'https://sentinel.parallaxadvisory.llc') + '/admin/login'));
  console.log('');
  console.log('You can now stop relying on ADMIN_PASSWORD Basic-auth bootstrap.');
  console.log('Once 1+ active operator exists, prefer logging in via /admin/login.');
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error('[add-operator] FAIL:', e.message); process.exit(1); });
}
