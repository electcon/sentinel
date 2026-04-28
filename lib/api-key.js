// lib/api-key.js
// Customer API key generation + verification. Keys are 32 random bytes,
// rendered as `sk_<32 hex>` so customers can paste them into Bearer
// headers and recognize them visually. The full key is shown ONCE on
// generation; thereafter we only have the SHA-256 hash + a 12-char
// prefix (for identification + display).
//
// Format: sk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  (35 chars total, 32 hex)
// Prefix in DB: 'sk_aaaaaaaa'  (first 12 chars)

'use strict';

const crypto = require('crypto');

const PREFIX = 'sk_';

function generateKey() {
  const random = crypto.randomBytes(16).toString('hex');     // 32-char hex
  const fullKey = PREFIX + random;                            // 'sk_' + 32 hex = 35 chars
  const keyPrefix = fullKey.slice(0, 12);                     // 'sk_aaaaaaaaaa' — 12 chars
  const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
  return { fullKey, keyPrefix, keyHash };
}

function hashKey(fullKey) {
  return crypto.createHash('sha256').update(String(fullKey)).digest('hex');
}

// Express middleware for /api/v1/* — verifies Bearer token, attaches
// req.customer (full row) and req.apiKey (id + label). On bad token:
// 401 with descriptive error body.
function requireApiKey(pool) {
  return async function (req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing or malformed Authorization header (expected: Bearer sk_...)' });
    }
    const token = auth.slice(7).trim();
    if (!/^sk_[a-f0-9]{32}$/.test(token)) {
      return res.status(401).json({ error: 'invalid API key format' });
    }
    const tokenHash = hashKey(token);
    try {
      const r = await pool.query(`
        SELECT k.id AS api_key_id, k.label, k.scopes, k.active,
               c.id AS customer_id, c.name AS customer_name, c.status AS customer_status
        FROM api_keys k
        JOIN customers c ON c.id = k.customer_id
        WHERE k.key_hash = $1 AND k.active = TRUE AND c.status IN ('beta', 'active')
        LIMIT 1
      `, [tokenHash]);
      if (!r.rowCount) {
        return res.status(401).json({ error: 'invalid or revoked API key' });
      }
      const row = r.rows[0];
      req.apiKey = { id: row.api_key_id, label: row.label, scopes: row.scopes || ['read'] };
      req.customer = { id: row.customer_id, name: row.customer_name, status: row.customer_status };
      // Best-effort use tracking; don't block the request.
      pool.query('UPDATE api_keys SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = $1', [row.api_key_id]).catch(() => {});
      next();
    } catch (e) {
      res.status(500).json({ error: 'auth backend error' });
    }
  };
}

module.exports = { generateKey, hashKey, requireApiKey, PREFIX };
