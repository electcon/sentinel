// lib/s3.js
// Evidence archive helper. Writes raw ingest payloads to the
// sentinel-evidence bucket. Key format follows ARCHITECTURE.md:
//
//   customer_id={uuid}/date=YYYY-MM-DD/{source}_{source_id}.json
//
// Lifecycle policy on the bucket transitions to Glacier at 90 days;
// no expiration. Any reads from law-enforcement workflow can take
// ~minutes to retrieve from Glacier — that's acceptable.

'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

let _s3 = null;
function client() {
  if (_s3) return _s3;
  if (!process.env.AWS_REGION) throw new Error('AWS_REGION not set');
  _s3 = new S3Client({ region: process.env.AWS_REGION });
  return _s3;
}

function bucket() {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error('S3_BUCKET not set');
  return b;
}

function buildKey({ customerId, source, sourceId, when }) {
  const d = (when ? new Date(when) : new Date()).toISOString().slice(0, 10);
  // sourceId can include `:` or `/` from some platforms — sanitize for path-safe.
  const safeId = String(sourceId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeSource = String(source || 'unknown').replace(/[^a-z0-9]/gi, '');
  return `customer_id=${customerId}/date=${d}/${safeSource}_${safeId}.json`;
}

async function putEvidence({ customerId, source, sourceId, payload, when }) {
  const Key = buildKey({ customerId, source, sourceId, when });
  const Body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  await client().send(new PutObjectCommand({
    Bucket: bucket(),
    Key,
    Body,
    ContentType: 'application/json'
  }));
  return Key;
}

async function getEvidence(Key) {
  const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key }));
  const chunks = [];
  for await (const c of r.Body) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

module.exports = { putEvidence, getEvidence, buildKey };
