'use strict';
// S15P21C206-143 채택 산식의 합성 참조 검사. 운영 배열·HTTP·DB 연동 검증은 별도다.
const assert = require('node:assert/strict');
const BINS = 150;
const VERSION = 'folded-mad-v0';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2;
}

function float32(value) {
  const result = Math.fround(value);
  if (!Number.isFinite(result)) throw new Error('float32 overflow');
  return Object.is(result, -0) ? 0 : result;
}

function snapshot(points, periodDays, referenceBtjd) {
  if (!Number.isFinite(periodDays) || periodDays <= 0 || !Number.isFinite(referenceBtjd)) {
    throw new Error('invalid folding parameters');
  }
  const groups = Array.from({ length: BINS }, () => []);
  for (const [time, flux] of points) {
    if (!Number.isFinite(time)) throw new Error('invalid time');
    if (flux === null) continue;
    if (!Number.isFinite(flux)) throw new Error('invalid flux');
    float32(flux); // 중앙값에서 숨겨지는 손상된 이상점도 거절한다. 계산값은 반올림하지 않는다.
    const cycles = (time - referenceBtjd) / periodDays;
    if (!Number.isFinite(cycles)) throw new Error('invalid phase');
    let phase = cycles % 1;
    if (phase < 0) phase += 1;
    // 아주 작은 음수 나머지가 덧셈에서 1로 반올림돼도 주기 경계로 돌린다.
    if (phase >= 1) phase = 0;
    if (phase >= 0.5) phase -= 1;
    const index = Math.min(BINS - 1, Math.floor((phase + 0.5) * BINS));
    groups[index].push(flux);
  }
  const foldedFlux = [], foldedError = [];
  for (const group of groups) {
    const center = group.length ? median(group) : null;
    foldedFlux.push(center === null ? null : float32(center));
    foldedError.push(group.length < 2 ? null
      : float32(1.4826 * median(group.map(value => Math.abs(value - center)))));
  }
  return { version: VERSION, bins: BINS, foldedFlux, foldedError };
}

if (require.main === module) {
  let count = 0;
  const check = (name, fn) => { fn(); count++; console.log(`PASS ${name}`); };
  check('150 empty bins', () => {
    const s = snapshot([], 1, 0);
    assert.equal(s.foldedFlux.length, 150);
    assert.equal(s.foldedError.length, 150);
    assert.ok([...s.foldedFlux, ...s.foldedError].every(x => x === null));
  });
  check('singleton and missing flux', () => {
    const s = snapshot([[0, 3], [1, null]], 1, 0);
    assert.equal(s.foldedFlux[75], 3);
    assert.equal(s.foldedError[75], null);
  });
  check('even median and MAD without sqrt(n)', () => {
    const s = snapshot([[0, 1], [1, 3]], 1, 0);
    assert.equal(s.foldedFlux[75], 2);
    assert.equal(s.foldedError[75], Math.fround(1.4826));
  });
  check('robust to isolated outlier', () => {
    const s = snapshot([1, 2, 3, 4, 100].map((f, t) => [t, f]), 1, 0);
    assert.equal(s.foldedFlux[75], 3);
    assert.equal(s.foldedError[75], Math.fround(1.4826));
  });
  check('identical values have zero scatter', () => {
    assert.equal(snapshot([[0, 1], [1, 1]], 1, 0).foldedError[75], 0);
  });
  check('positive and negative half-cycle share left boundary', () => {
    const s = snapshot([[-0.5, 1], [0.5, 3]], 1, 0);
    assert.equal(s.foldedFlux[0], 2);
    assert.equal(s.foldedFlux.filter(x => x !== null).length, 1);
  });
  check('cycle translation preserves snapshot', () => {
    assert.deepEqual(snapshot([[10.25, 2]], 1, 10), snapshot([[-0.75, 2]], 1, 0));
  });
  check('right edge stays in last bin and exact half-cycle wraps', () => {
    const s = snapshot([[0.5 - Number.EPSILON, 2], [0.5, 4]], 1, 0);
    assert.equal(s.foldedFlux[149], 2);
    assert.equal(s.foldedFlux[0], 4);
  });
  check('each bin uses its own scatter', () => {
    const s = snapshot([[0, 1], [1, 3], [0.25, 10], [1.25, 10]], 1, 0);
    assert.equal(s.foldedError[75], Math.fround(1.4826));
    assert.equal(s.foldedError[112], 0);
  });
  check('original period changes bins; corrected period must not replace it', () => {
    assert.equal(snapshot([[0.25, 2]], 1, 0).foldedFlux[112], 2);
    assert.equal(snapshot([[0.25, 2]], 2, 0).foldedFlux[93], 2);
    assert.equal(snapshot([[0.25, 2]], 0.5, 0).foldedFlux[0], 2);
  });
  check('uses supplied residual rather than original flux', () => {
    assert.equal(snapshot([[0, 0.5]], 1, 0).foldedFlux[75], 0.5);
  });
  check('rejects corrupt inputs and output overflow', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => snapshot([[0, bad]], 1, 0));
      assert.throws(() => snapshot([[bad, 1]], 1, 0));
      assert.throws(() => snapshot([], bad, 0));
    }
    assert.throws(() => snapshot([], 0, 0));
    assert.throws(() => snapshot([], -1, 0));
    assert.throws(() => snapshot([[0, 1e39]], 1, 0));
    assert.throws(() => snapshot([[0, 0], [1, 0], [2, 1e39]], 1, 0));
    assert.throws(() => snapshot([[0, -3e38], [1, 3e38]], 1, 0));
    assert.throws(() => snapshot([[Number.MAX_VALUE, 1]], Number.MIN_VALUE, 0));
  });
  console.log(`${count} checks passed (reference calculation only)`);
}

module.exports = { snapshot };
