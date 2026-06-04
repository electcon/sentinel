// tests/csv-export.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { csvField, csvRow } = require('../routes/api');

test('csvField: plain string passes through', () => {
  assert.equal(csvField('hello'), 'hello');
});

test('csvField: null/undefined → empty string (not "null")', () => {
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
});

test('csvField: number/boolean stringified', () => {
  assert.equal(csvField(42), '42');
  assert.equal(csvField(0), '0');
  assert.equal(csvField(true), 'true');
});

test('csvField: Date → ISO 8601', () => {
  assert.equal(csvField(new Date('2026-04-29T03:14:15.926Z')), '2026-04-29T03:14:15.926Z');
});

test('csvField: comma-containing field is quoted', () => {
  assert.equal(csvField('a,b'), '"a,b"');
});

test('csvField: double-quote-containing field is quoted + doubled', () => {
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
});

test('csvField: newline-containing field is quoted', () => {
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
  assert.equal(csvField('crlf\r\nstuff'), '"crlf\r\nstuff"');
});

test('csvField: combined comma + quote', () => {
  assert.equal(csvField('"hello, world"'), '"""hello, world"""');
});

test('csvRow: joins with commas + CRLF terminator (RFC 4180)', () => {
  assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c\r\n');
});

test('csvRow: escapes per-field correctly in a mixed row', () => {
  const row = csvRow(['plain', 'with,comma', null, 42, 'with "quote"', new Date('2026-01-01T00:00:00Z')]);
  assert.equal(row, 'plain,"with,comma",,42,"with ""quote""",2026-01-01T00:00:00.000Z\r\n');
});

test('csvRow: empty row produces just CRLF', () => {
  assert.equal(csvRow([]), '\r\n');
});

test('csvRow: object falls through to String() then escape (defensive)', () => {
  const row = csvRow([{ a: 1 }]);
  // Default String({a:1}) is '[object Object]' — has no special chars, no quoting.
  assert.equal(row, '[object Object]\r\n');
});
