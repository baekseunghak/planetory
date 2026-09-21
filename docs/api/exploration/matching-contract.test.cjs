'use strict';
// 최신 API의 nullable 제안값 계약. 기존 31개 v0 fixture의 수치 정책은 변경하지 않는다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, evaluate, match } = require('./matching-v0.cjs');
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

const bundle = { ...fx.bundle, foldReferenceTimeBtjd: 0, observationBounds: [0, 20],
  observedWindows: [[0, 4], [8, 20]], cadenceDays: 1 / 144 };
const candidate = { id: 'c-1', periodDays: 2, epochBtjd: 1, durationHours: 3 };
const derived = { periodDays: 2, epochBtjd: 1, durationDays: 0.125 };

test('관측 공백의 통과 두 개는 N과 중첩에서 제외한다', () => {
  const e = evaluate(bundle, rules, derived, candidate, 1);
  assert.equal(e.observedTransits, 8);
  assert.equal(e.nTransits, 8);
  assert.equal(e.overlapTransits, 8);
  assert.equal(e.overlapRatio, 1);
});
test('N 상한은 누적 주기 오차에만 적용하고 중첩 비율을 부풀리지 않는다', () => {
  const capped = structuredClone(rules);
  capped.matching.nTransits.cap = 2;
  const user = { ...derived, periodDays: 2.001 };
  const uncapped = evaluate(bundle, rules, user, candidate, 1);
  const e = evaluate(bundle, capped, user, candidate, 1);
  assert.equal(e.nTransits, 2);
  assert.equal(e.observedTransits, 8);
  assert.equal(e.ePeriod * 4, uncapped.ePeriod);
  assert.equal(e.overlapRatio, uncapped.overlapRatio);
  assert.ok(e.overlapRatio <= 1);
});
test('외부 N 값 대신 실제 관측 창을 사용한다', () => {
  assert.deepEqual(evaluate(bundle, rules, derived, { ...candidate, nTransitsObserved: 1 }, 1),
    evaluate(bundle, rules, derived, candidate, 1));
});
test('잘못된 epoch는 같은 주기라도 매칭되지 않는다', () => {
  assert.equal(match(bundle, rules, { ...derived, epochBtjd: 1.5 }, [candidate], []).status, 'not_matched');
});
test('관측 공백에만 놓인 통과는 후보 자신의 제출도 통과하지 못한다', () => {
  const c = { ...candidate, periodDays: 30, epochBtjd: 6 };
  const e = evaluate(bundle, rules, { ...derived, periodDays: 30, epochBtjd: 6 }, c, 1);
  assert.equal(e.observedTransits, 0);
  assert.equal(e.overlapRatio, 0);
  assert.equal(e.pass, false);
});
test('복수 후보 동률은 배열 순서에 관계없이 모호하며 제거된 후보는 제외한다', () => {
  const second = { ...candidate, id: 'c-2' };
  const a = match(bundle, rules, derived, [candidate, second], []);
  assert.equal(a.status, 'ambiguous_match');
  assert.deepEqual(a, match(bundle, rules, derived, [second, candidate], []));
  assert.equal(match(bundle, rules, derived, [candidate, second], ['c-2']).candidateId, 'c-1');
});

test('실측 재생기는 상한별 결과와 정답 없는 위상 이동 probe를 분리한다', () => {
  const { replay } = require('./matching-replay.cjs');
  const input = { schema: 'planetory.matching-replay-input.v1', curves: [{ id: 'synthetic',
    bundle, candidates: [candidate], submissions: [
      { injection_id: 'i-1', variant: 'truth', reference_candidate_111: 'c-1',
        selection: { periodDays: 2, phaseStart: .46875, phaseEnd: .53125, sourcePeakGridIndex: null } },
      { injection_id: 'i-1', variant: 'offset-probe', reference_candidate_111: 'c-1',
        selection: { periodDays: 2, phaseStart: .21875, phaseEnd: .28125, sourcePeakGridIndex: null } }
    ] }] };
  const result = replay(input);
  assert.equal(result.rows.length, 10);
  assert.equal(result.summary['truth/cap=none'].agrees_with_111_recovery, 1);
  assert.equal(result.summary['offset-probe/cap=none'].statuses.not_matched, 1);
  assert.equal(result.rows.some(r => Object.hasOwn(r, 'false_positive')), false);
});
