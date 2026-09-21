'use strict';
// 최신 API의 nullable 제안값 계약. 기존 31개 v0 fixture의 수치 정책은 변경하지 않는다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./matching-v0.cjs');
const fx = require('./matching-cases.v0.json');
const rules = require('./matching-rules.v0.json');
const selection = { periodDays: 5, phaseStart: 0.15, phaseEnd: 0.25, sourcePeakGridIndex: 100 };
const peaks = () => fx.peaks.map(p => ({ ...p, suggestedDurationHours: null }));
const check = (s = selection, p = peaks()) => validate(fx.bundle, rules, s, p);

test('제안값 null은 0시간 상한이 아니며 다른 봉우리의 duration을 빌리지 않는다', () => {
  const p = peaks();
  p.find(x => x.gridIndex === 300).suggestedDurationHours = 0.1;
  const result = check(selection, p);
  assert.equal(result.ok, true);
  assert.equal(result.durationHours, 12);
  assert.equal(result.durationLimitHours, null);
  assert.equal(result.sourcePeakSuggestedDurationHours, null);
  assert.deepEqual(check(selection, p.toReversed()), result);
});
test('제안값이 있으면 선택한 봉우리의 3배 상한을 유지한다', () => {
  assert.equal(check(selection, fx.peaks).code, 'DURATION_LIMIT');
  assert.equal(check({ ...selection, sourcePeakGridIndex: 300 }, fx.peaks).ok, true);
});
test('제안값 null이어도 최소 폭·최대 폭을 유지한다', () => {
  assert.equal(check({ ...selection, phaseEnd: 0.151 }).code, 'MIN_WINDOW');
  assert.equal(check({ ...selection, phaseEnd: 0.5 }).code, 'PHASE_WIDTH_MAX');
});
test('제안값 null이어도 source 식별자와 fineTune 범위를 검사한다', () => {
  assert.equal(check({ ...selection, sourcePeakGridIndex: 999 }).code, 'UNKNOWN_PEAK');
  assert.equal(check({ ...selection, periodDays: 5.06 }).code, 'OUTSIDE_FINE_TUNE');
});
test('직접 선택은 추천 목록 크기에 영향받지 않는다', () => {
  const s = { ...selection, sourcePeakGridIndex: null };
  assert.equal(check(s, []).ok, true);
  assert.deepEqual(check(s, []), check(s, fx.peaks));
});
