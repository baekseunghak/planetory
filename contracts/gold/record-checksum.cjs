'use strict';
// Gold 레코드 checksum v0 (record-canonical-v0) 의 Node 참조 구현 + 벡터 검증. Jira S15P21C206-117.
//   node contracts/gold/record-checksum.cjs
// 69 의미 payload 의 candidates_checksum·ai_results_checksum·external_statuses_checksum 용. 운영 코드가 아니다.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }

function enc(value) {
  if (value === null || value === undefined) return Buffer.from([0x00]);
  if (typeof value === 'boolean') return Buffer.from([0x01, value ? 1 : 0]);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_input');
    const b = Buffer.alloc(9); b[0] = 0x02; b.writeDoubleLE(value === 0 ? 0 : value, 1); return b;
  }
  if (typeof value === 'string') { const s = Buffer.from(value, 'utf8'); return Buffer.concat([Buffer.from([0x03]), u32(s.length), s]); }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([0x04]), u32(value.length), ...value.map(enc)]);
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    return Buffer.concat([Buffer.from([0x05]), u32(keys.length), ...keys.flatMap(k => [enc(k), enc(value[k])])]);
  }
  throw new Error(`unsupported type ${typeof value}`);
}

function get(rec, dotted) { return dotted.split('.').reduce((cur, p) => (cur && typeof cur === 'object') ? cur[p] : undefined, rec); }

function prepare(rule, records) {
  const out = records.map(r => {
    const c = JSON.parse(JSON.stringify(r));
    for (const k of rule.exclude) delete c[k];
    for (const dotted of rule.exclude_nested) {
      const parts = dotted.split('.'); const last = parts.pop();
      const parent = parts.reduce((cur, p) => (cur && typeof cur === 'object') ? cur[p] : undefined, c);
      if (parent && typeof parent === 'object') delete parent[last];
    }
    return c;
  });
  // 정렬 키: 숫자 < 문자열(UTF-8 바이트 순, Buffer.compare) < null. 모두 같으면 인코딩 바이트로 마지막 비교(총순서).
  const keyOf = rec => rule.sort_key.map(k => {
    const v = get(rec, k);
    if (v === null || v === undefined) return [2, null];
    if (typeof v === 'number') return [0, v];
    if (typeof v === 'string') return [1, Buffer.from(v, 'utf8')];
    throw new Error(`invalid_sort_key_type ${k}: ${typeof v}`);          // 정렬 키 값은 숫자·문자열·null 만
  });
  const withKeys = out.map(rec => ({ rec, key: keyOf(rec), bytes: enc(rec) }));
  withKeys.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i][0] !== b.key[i][0]) return a.key[i][0] - b.key[i][0];
      if (a.key[i][0] === 0) { if (a.key[i][1] !== b.key[i][1]) return a.key[i][1] < b.key[i][1] ? -1 : 1; }
      else if (a.key[i][0] === 1) { const c = Buffer.compare(a.key[i][1], b.key[i][1]); if (c !== 0) return c; }
    }
    return Buffer.compare(a.bytes, b.bytes);
  });
  return withKeys.map(w => w.rec);
}

function recordChecksum(rule, records) {
  return 'sha256:' + crypto.createHash('sha256').update(enc(prepare(rule, records))).digest('hex');
}

function main() {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'examples', 'record-checksum-vectors.v0.json'), 'utf8'));
  assert.equal(v.recordChecksumVersion, 'record-canonical-v0');
  for (const c of v.cases) {
    const rule = v.rules[c.kind];
    const prepared = prepare(rule, c.input);
    assert.deepEqual(prepared, c.prepared, `${c.id}: prepared`);
    const bytes = enc(prepared);
    assert.equal(bytes.length, c.canonical_length, `${c.id}: length`);
    assert.equal(bytes.subarray(0, 64).toString('hex'), c.canonical_hex_prefix, `${c.id}: bytes`);
    assert.equal(recordChecksum(rule, c.input), c.sha256, `${c.id}: sha256`);
  }
  const by = Object.fromEntries(v.cases.map(c => [c.id, c]));
  assert.equal(by.candidates_two.sha256, by.candidates_two_reversed_input.sha256);
  assert.equal(by.candidates_two.sha256, by.candidates_two_different_db_ids.sha256);
  assert.equal(by.external_tie_same_source_external_id.sha256, by.external_tie_reversed_input.sha256);
  assert.equal(by.candidates_tie_same_business_key.sha256, by.candidates_tie_reversed_input.sha256);
  console.log(`PASS: ${v.cases.length} record checksum vectors reproduce in Node (${v.recordChecksumVersion})`);
}

if (require.main === module) main();
module.exports = { enc, prepare, recordChecksum };
