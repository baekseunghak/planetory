'use strict';
// Gold 배열 checksum v0 (array-f32le-null7fc00000-v0) 의 Node 참조 구현 + 벡터 검증. Jira S15P21C206-117.
//   node contracts/gold/array-checksum.cjs
// Python 구현(experiments/gold-roundtrip/gold_roundtrip/canonical.py)이 만든 벡터 파일의 hex·sha256 을 재현한다.
// Java 구현은 같은 벡터로 자기 결과를 대조한다. 이 스크립트는 운영 코드가 아니다.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NULL_BYTES = Buffer.from([0x00, 0x00, 0xc0, 0x7f]);

class ArrayCanonicalError extends Error {
  constructor(code, index, message) { super(`${code} at index ${index}: ${message}`); this.code = code; this.index = index; }
}

function normalizeArray(values) {
  const out = [];
  values.forEach((v, i) => {
    if (v === null) { out.push(null); return; }
    if (typeof v !== 'number') throw new ArrayCanonicalError('non_numeric', i, String(v));
    if (!Number.isFinite(v)) throw new ArrayCanonicalError('non_finite_input', i, String(v));
    const f32 = Math.fround(v);                       // round-to-nearest-even, subnormal 보존
    if (!Number.isFinite(f32)) throw new ArrayCanonicalError('float32_overflow', i, String(v));
    out.push(f32 === 0 ? 0 : f32);                    // -0 → +0
  });
  return out;
}

function canonicalBytes(normalized) {
  const buf = Buffer.alloc(normalized.length * 4);
  normalized.forEach((v, i) => {
    if (v === null) NULL_BYTES.copy(buf, i * 4);
    else buf.writeFloatLE(v, i * 4);
  });
  return buf;
}

function arrayChecksum(normalized) {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalBytes(normalized)).digest('hex');
}

function tokenToValue(t) {
  if (t === 'NaN') return NaN;
  if (t === 'Infinity') return Infinity;
  if (t === '-Infinity') return -Infinity;
  return t;
}

function main() {
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'examples', 'array-checksum-vectors.v0.json'), 'utf8'));
  assert.equal(vectors.checksumVersion, 'array-f32le-null7fc00000-v0');
  for (const c of vectors.cases) {
    const norm = normalizeArray(c.input);
    assert.deepEqual(norm, c.normalized, `${c.id}: normalized`);
    assert.equal(canonicalBytes(norm).toString('hex'), c.hash_input_hex, `${c.id}: bytes`);
    assert.equal(arrayChecksum(norm), c.sha256, `${c.id}: sha256`);
  }
  for (const r of vectors.reject_cases) {
    assert.throws(() => normalizeArray(r.input_tokens.map(tokenToValue)), e => e.code === r.expected_error, `${r.id} must fail with ${r.expected_error}`);
  }
  // 정렬 민감성: NULL 위치가 다르면 checksum 이 다르다
  const a = vectors.cases.find(c => c.id === 'one_and_null'), b = vectors.cases.find(c => c.id === 'null_first');
  assert.notEqual(a.sha256, b.sha256);
  console.log(`PASS: ${vectors.cases.length} checksum vectors and ${vectors.reject_cases.length} reject cases reproduce in Node (${vectors.checksumVersion})`);
}

if (require.main === module) main();
module.exports = { normalizeArray, canonicalBytes, arrayChecksum, ArrayCanonicalError };
