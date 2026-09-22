'use strict';
// 제출 매칭 v0(rule-0) 참조 구현 + 사례 검증기. Jira S15P21C206-128.
//
//   node docs/api/exploration/matching-v0.cjs            # matching-cases.v0.json 의 expected 와 재계산 결과를 비교
//   node docs/api/exploration/matching-v0.cjs --write    # expected 를 재계산 값으로 채운다 (규칙·사례를 고쳤을 때)
//
// 이 파일은 운영 코드가 아니다. Backend(Java, C09)·Frontend(TS, A04) 구현이 같은 사례로 자기 결과를 대조하는 기준이다.
// 규칙 값은 matching-rules.v0.json 에서 읽고 여기 숫자를 박지 않는다.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, 'matching-rules.v0.json'), 'utf8'));
const CASES_PATH = path.join(__dirname, 'matching-cases.v0.json');
const EPS = RULES.numerics.epsilon.value;

const idNum = id => Number(id.slice(2));
const byIdAsc = (a, b) => idNum(a) - idNum(b);
const mod1 = x => ((x % 1) + 1) % 1;
const hoursToDays = h => h / 24;

// ---------------------------------------------------------------- 서버 산정 (EXP-06, API 6.2 6·7행)
function deriveEpoch(bundle, selection) {
  const P = selection.periodDays;
  const T = bundle.foldReferenceTimeBtjd;
  const phaseCenter = mod1((selection.phaseStart + selection.phaseEnd) / 2);
  const [lo, hi] = bundle.observationBounds;
  const kLo = Math.ceil((lo - T) / P - phaseCenter);
  const kHi = Math.floor((hi - T) / P - phaseCenter);
  let best = null;
  for (let k = kLo; k <= kHi; k++) {
    const epoch = T + (phaseCenter + k) * P;
    const d = Math.abs(epoch - T);
    if (best === null || d < best.d - EPS || (Math.abs(d - best.d) <= EPS && epoch < best.epoch)) best = { epoch, d, k };
  }
  return { phaseCenter, epoch: best ? best.epoch : null, k: best ? best.k : null };
}

// ---------------------------------------------------------------- 관측 창·표본
function windows(bundle) { return bundle.observedWindows; }
function intersects(a0, a1, b0, b1) { return Math.max(a0, b0) <= Math.min(a1, b1); }
function hasData(bundle, t0, t1) { return windows(bundle).some(([w0, w1]) => intersects(t0, t1, w0, w1)); }

function spanHasObservedPoint(bundle, P, phaseStart, phaseEnd) {
  // 접힌 위상 [phaseStart, phaseEnd] (phaseEnd 는 1 을 넘을 수 있음) 에 표본점이 하나라도 있는가. cadence 간격 표본화.
  const T = bundle.foldReferenceTimeBtjd;
  for (const [w0, w1] of windows(bundle)) {
    for (let t = w0; t <= w1 + 1e-12; t += bundle.cadenceDays) {
      const ph = mod1((t - T) / P);
      if ((ph >= phaseStart && ph <= phaseEnd) || (ph + 1 >= phaseStart && ph + 1 <= phaseEnd)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- 6.2 검증 (4→5→6→7→9)
function validate(bundle, rules, selection, peaks) {
  const fail = (field, code) => ({ ok: false, field, code });
  const { periodDays: P, phaseStart: ps, phaseEnd: pe } = selection;
  if (!Number.isFinite(P) || P <= 0 || !Number.isFinite(ps) || !Number.isFinite(pe)) return fail('selection.periodDays', 'VALIDATION_FAILED');
  if (!(ps >= 0 && ps < 1 && ps < pe && pe < ps + 1)) return fail('selection.phaseEnd', 'VALIDATION_FAILED');
  const width = pe - ps;
  if (width * P < rules.validation.minWindowDays.value) return fail('selection.phaseEnd', 'MIN_WINDOW');
  if (width > rules.validation.phaseWidthMax.value) return fail('selection.phaseEnd', 'PHASE_WIDTH_MAX');
  let durationLimitHours = null; let suggested = null;
  if (selection.sourcePeakGridIndex !== null && selection.sourcePeakGridIndex !== undefined) {
    const peak = peaks.find(p => p.gridIndex === selection.sourcePeakGridIndex);
    if (!peak) return fail('selection.sourcePeakGridIndex', 'UNKNOWN_PEAK');
    if (!(P >= peak.fineTune.periodMinDays && P <= peak.fineTune.periodMaxDays)) return fail('selection.sourcePeakGridIndex', 'OUTSIDE_FINE_TUNE');
    suggested = peak.suggestedDurationHours;
    // API 5.4/6.2: 주기별 duration 출처가 없으면 null이며 0시간으로 해석하지 않는다.
    if (suggested !== null && suggested !== undefined) {
      durationLimitHours = suggested * rules.validation.maxDurationMultipleOfSuggested.value;
      if (width * P * 24 > durationLimitHours) return fail('selection.phaseEnd', 'DURATION_LIMIT');
    }
  }
  if (rules.validation.allowEmptyPhaseSpan.value === false && !spanHasObservedPoint(bundle, P, ps, pe)) return fail('selection.phaseEnd', 'EMPTY_PHASE_SPAN');
  const d = deriveEpoch(bundle, selection);
  if (d.epoch === null) return fail('selection', 'EPOCH_OUT_OF_RANGE');
  const durationDays = width * P;
  if (!(durationDays > 0 && durationDays < P)) return fail('selection', 'VALIDATION_FAILED');
  if (P < bundle.periodGrid.periodMinDays || P > bundle.periodGrid.periodMaxDays) return fail('selection.periodDays', 'OUTSIDE_PERIOD_GRID');
  return { ok: true, phaseCenter: d.phaseCenter, epochBtjd: d.epoch, k: d.k, durationDays, durationHours: durationDays * 24,
           sourcePeakSuggestedDurationHours: suggested, durationLimitHours };
}

// ---------------------------------------------------------------- 후보 통과 목록·N
function candidateTransits(bundle, c) {
  const Dc = hoursToDays(c.durationHours);
  const [lo, hi] = bundle.observationBounds;
  const nLo = Math.floor((lo - c.epochBtjd) / c.periodDays) - 1;
  const nHi = Math.ceil((hi - c.epochBtjd) / c.periodDays) + 1;
  const out = [];
  for (let n = nLo; n <= nHi; n++) {
    const center = c.epochBtjd + n * c.periodDays;
    if (hasData(bundle, center - Dc / 2, center + Dc / 2)) out.push(center);
  }
  return out;
}

// ---------------------------------------------------------------- 후보 하나·배율 하나의 평가
function evaluate(bundle, rules, derived, c, m) {
  const Pu = derived.periodDays * m;                 // 정정 주기
  const Pc = c.periodDays;
  const Dc = hoursToDays(c.durationHours);
  const Du = derived.durationDays;
  const halfC = Math.max(Dc / 2, rules.validation.minWindowDays.value / 2);
  const transits = candidateTransits(bundle, c);
  // 서버와 동일하게 관측 창에서 센다. N 상한은 주기 오차에만 적용한다.
  const observedTransits = transits.length;
  const N = Math.min(observedTransits, rules.matching.nTransits.cap ?? Infinity);
  const ePeriod = Math.abs(Pu - Pc) * N / halfC;                  // halfC = max(D_c/2, minWindowDays/2)
  const Pmod = Math.min(derived.periodDays, Pc);          // 절반 주기 alias 는 사용자 주기로 순환 (규칙 epoch.modulusNote)
  const kEp = Math.round((derived.epochBtjd - c.epochBtjd) / Pmod);
  const epochDiff = Math.min(...[kEp - 1, kEp, kEp + 1].map(k => Math.abs(derived.epochBtjd - c.epochBtjd - k * Pmod)));
  const eEpoch = epochDiff / halfC;
  const ratio = Du / Dc;
  const durationPass = ratio >= 0.5 && ratio <= 2;
  const eDuration = Math.abs(Math.log2(ratio));
  // 중첩: 후보 통과(데이터 있음)마다 사용자 창과 겹치는 데이터 구간이 있는가.
  // 사용자 창은 사용자가 고른 주기 P_user 간격으로 반복한다(정정 주기가 아님). m=2 면 후보 통과마다 사용자 창이 있고,
  // m=0.5 면 후보 통과 둘에 하나만 사용자 창이 겹친다(중첩 비율 0.5).
  let overlapTransits = 0;
  for (const center of transits) {
    const nUser = Math.round((center - derived.epochBtjd) / derived.periodDays);
    const uc = derived.epochBtjd + nUser * derived.periodDays;
    const lo = Math.max(center - Dc / 2, uc - Du / 2), hi = Math.min(center + Dc / 2, uc + Du / 2);
    if (lo <= hi && hasData(bundle, lo, hi)) overlapTransits++;
  }
  const overlapPass = overlapTransits >= rules.matching.conditions.overlap.minOverlapTransits;
  const pass = ePeriod <= 1 && eEpoch <= 1 && durationPass && overlapPass;
  return { candidateId: c.id, multiplier: m, correctedPeriodDays: Pu, nTransits: N, ePeriod, eEpoch, eDuration, durationRatio: ratio,
           durationPass, overlapTransits, observedTransits,
           overlapRatio: observedTransits ? overlapTransits / observedTransits : 0, pass,
           score: Math.max(ePeriod, eEpoch, eDuration) };
}

// ---------------------------------------------------------------- 5.2 후보 선택 + v0 우세/모호
function match(bundle, rules, derived, candidates, removedIds) {
  const active = candidates.filter(c => !removedIds.includes(c.id)).slice().sort((a, b) => byIdAsc(a.id, b.id));
  const evals = [];
  for (const c of active) for (const m of rules.matching.harmonicMultipliers.value) evals.push(evaluate(bundle, rules, derived, c, m));
  const passers = evals.filter(e => e.pass);
  const direct = passers.filter(e => e.multiplier === 1);
  const pool = direct.length ? direct : passers;
  // 집계 단위 = 후보 id. 같은 후보의 여러 해석 중 점수 최소 하나만 남긴다(배율 1 이 있으면 pool 자체가 배율 1 만).
  const perCandidate = new Map();
  for (const e of pool) {
    const cur = perCandidate.get(e.candidateId);
    if (!cur || e.score < cur.score - EPS) perCandidate.set(e.candidateId, e);
  }
  const ranked = [...perCandidate.values()].sort((a, b) => (a.score - b.score) || byIdAsc(a.candidateId, b.candidateId));
  const dom = rules.matching.dominance;
  const label = e => e.multiplier === 1 ? 'matched' : 'matched_harmonic';
  const base = { evaluations: evals, rankedCandidateIds: ranked.map(e => e.candidateId) };
  if (ranked.length === 0) return { ...base, status: 'not_matched', candidateId: null, harmonicMultiplier: null, correctedPeriodDays: null, decision: 'no candidate passed all four conditions' };
  if (ranked.length === 1) return { ...base, status: label(ranked[0]), candidateId: ranked[0].candidateId, harmonicMultiplier: ranked[0].multiplier, correctedPeriodDays: ranked[0].correctedPeriodDays, decision: 'single passer' };
  const [a, b] = ranked;
  const gapOk = (b.score - a.score) >= dom.minScoreGap.value;
  const ratioOk = a.score <= dom.dominanceRatio.value * b.score;
  const overlapOk = a.overlapRatio >= b.overlapRatio - dom.overlapRatioTolerance.value;
  const tie = Math.abs(a.score - b.score) <= EPS;
  const dominant = !tie && gapOk && ratioOk && overlapOk;
  const decision = tie ? 'tie (|s1−s2| ≤ epsilon)' : !gapOk ? 'score gap below minScoreGap' : !ratioOk ? 'ratio above dominanceRatio' : !overlapOk ? 'leader clearly worse in overlap' : 'dominant';
  if (!dominant) return { ...base, status: 'ambiguous_match', candidateId: null, harmonicMultiplier: null, correctedPeriodDays: null, decision,
                          dominance: { s1: a.score, s2: b.score, r1: a.overlapRatio, r2: b.overlapRatio, gapOk, ratioOk, overlapOk, tie } };
  return { ...base, status: label(a), candidateId: a.candidateId, harmonicMultiplier: a.multiplier, correctedPeriodDays: a.correctedPeriodDays, decision,
           dominance: { s1: a.score, s2: b.score, r1: a.overlapRatio, r2: b.overlapRatio, gapOk, ratioOk, overlapOk, tie } };
}

// ---------------------------------------------------------------- 사례 실행
const round = (x, d = 6) => (x === null || x === undefined) ? x : Math.round(x * 10 ** d) / 10 ** d;

function runCase(fx, c, baseRules = RULES) {
  const bundle = { ...fx.bundle, ...(c.bundleOverride || {}) };
  const rules = JSON.parse(JSON.stringify(baseRules));
  if (c.rulesOverride) for (const [k, v] of Object.entries(c.rulesOverride)) {
    const [sec, key] = k.split('.');
    rules[sec][key].value = v;
  }
  const candidates = (c.candidates || fx.candidates).slice();
  if (c.candidateOrder === 'reversed') candidates.reverse();
  const v = validate(bundle, rules, c.selection, fx.peaks);
  if (!v.ok) return { validation: { ok: false, field: v.field, code: v.code } };
  const derived = { periodDays: c.selection.periodDays, epochBtjd: v.epochBtjd, durationDays: v.durationDays };
  const m = match(bundle, rules, derived, candidates, c.removedCandidateIds || []);
  const passEvals = m.evaluations.filter(e => e.pass).map(e => ({ candidateId: e.candidateId, multiplier: e.multiplier, score: round(e.score), ePeriod: round(e.ePeriod), eEpoch: round(e.eEpoch), eDuration: round(e.eDuration), overlapTransits: e.overlapTransits, nTransits: e.nTransits }))
    .sort((x, y) => byIdAsc(x.candidateId, y.candidateId) || x.multiplier - y.multiplier);
  return {
    validation: { ok: true },
    serverDerived: { phaseCenter: round(v.phaseCenter), epochBtjd: round(v.epochBtjd), durationHours: round(v.durationHours), durationHoursDisplay: Number(v.durationHours.toFixed(2)),
                     sourcePeakSuggestedDurationHours: v.sourcePeakSuggestedDurationHours, durationLimitHours: v.durationLimitHours },
    match: { status: m.status, candidateId: m.candidateId, harmonicMultiplier: m.harmonicMultiplier, correctedPeriodDays: round(m.correctedPeriodDays), decision: m.decision,
             rankedCandidateIds: m.rankedCandidateIds, dominance: m.dominance ? { s1: round(m.dominance.s1), s2: round(m.dominance.s2), r1: round(m.dominance.r1), r2: round(m.dominance.r2), gapOk: m.dominance.gapOk, ratioOk: m.dominance.ratioOk, overlapOk: m.dominance.overlapOk, tie: m.dominance.tie } : null },
    passingEvaluations: passEvals,
  };
}

function main() {
  const fx = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  assert.equal(fx.ruleVersion, RULES.ruleVersion);
  assert.equal(RULES.status, 'development-example-not-operational');
  const write = process.argv.includes('--write');
  const ids = new Set();
  let failures = 0;
  for (const c of fx.cases) {
    assert.ok(!ids.has(c.id), `duplicate case id ${c.id}`); ids.add(c.id);
    assert.ok(Array.isArray(c.tags) && c.tags.length, `${c.id}: tags`);
    const actual = runCase(fx, c);
    if (write) { c.expected = actual; continue; }
    try { assert.deepEqual(actual, c.expected); }
    catch (e) { failures++; console.error(`FAIL ${c.id}\n${e.message}`); }
  }
  if (write) {
    fs.writeFileSync(CASES_PATH, JSON.stringify(fx, null, 2) + '\n', 'utf8');
    console.log(`wrote expected for ${fx.cases.length} cases`);
    return;
  }
  // 사례 목록이 요구 사항을 덮는지
  const tags = new Set(fx.cases.flatMap(c => c.tags));
  for (const t of ['direct', 'harmonic-half', 'harmonic-double', 'direct-over-harmonic', 'not-matched', 'zero-tie', 'near-zero-ratio-only',
                   'gap-just-below', 'gap-exact', 'gap-just-above', 'ratio-boundary', 'overlap-vs-score', 'three-candidates',
                   'duration-0.5-boundary', 'duration-2-boundary', 'order-independent', 'phase-end-over-1', 'min-window-reject',
                   'phase-width-reject', 'duration-limit-reject', 'no-source-peak', 'empty-span-reject', 'epoch-out-of-range',
                   'outside-grid', 'outside-recommended-allowed', 'overlapping-finetune', 'display-rounding', 'gap-excluded-transit']) {
    assert.ok(tags.has(t), `missing case tag: ${t}`);
  }
  // 순서 무관: order-independent 쌍은 candidateOrder 만 다르고 결과가 같아야 한다
  const oi = fx.cases.filter(c => c.tags.includes('order-independent'));
  assert.equal(oi.length, 2);
  assert.deepEqual(oi[0].expected.match, oi[1].expected.match);
  if (failures) { console.error(`${failures} case(s) differ from expected`); process.exit(1); }
  console.log(`PASS: ${fx.cases.length} matching cases reproduce expected (rule ${RULES.ruleVersion}, ${RULES.status})`);
}

if (require.main === module) main();
module.exports = { validate, match, evaluate, deriveEpoch, runCase };
