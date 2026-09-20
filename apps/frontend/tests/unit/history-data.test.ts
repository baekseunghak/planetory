import assert from "node:assert/strict";
import { test } from "node:test";
import { readHistoryDetail } from "../../src/features/analysis/history-data";

// 8.2절은 한 응답에 성격이 다른 묶음을 담는다. 당시 값과 조회 시점 값을
// 섞지 않는지, 보관 정보를 꾸며 채우지 않는지 본다.

const ID = "h-501";
const curveContext = {
  bundleId: "9007199254741093",
  curveStep: 1,
  removedCandidateIds: ["9007199254741094"],
  residualModelVersion: "rm-1",
  periodogramConfigVersion: "pg-1",
};
const submission = (patch: Record<string, unknown> = {}) => ({
  submissionId: "sub-7001",
  historyId: ID,
  requestId: "6f0b3a1e-548a-4a52-897a-135729468abc",
  ticId: "259377024",
  bundleId: curveContext.bundleId,
  submittedAt: "2026-09-10T02:30:00Z",
  submissionKind: "candidate",
  curveContext,
  original: {
    periodDays: 11.802,
    sourcePeakGridIndex: 3311,
    phaseStart: 0.995,
    phaseEnd: 1.005,
  },
  serverDerived: {
    foldReferenceTimeBtjd: 1683.4231,
    phaseCenter: 0,
    epochBtjd: 1683.4231,
    durationHours: 2.83248,
    sourcePeakSuggestedDurationHours: 3.1,
    durationLimitHours: 9.3,
    centroidDataStatus: "unavailable",
  },
  match: {
    status: "matched_harmonic",
    candidateId: "c-402",
    harmonicMultiplier: 2,
    correctedPeriodDays: 23.604,
    correctionReason: "P/2 alias",
  },
  signal: {
    candidateId: "c-402",
    disposition: "UNCONFIRMED",
    answerClass: "analysis",
    planetTruth: null,
    bls: {
      periodDays: 23.604,
      epochBtjd: 1695.11,
      durationHours: 3.4,
      depthPpm: 380,
      sde: null,
      snr: null,
    },
    ai: {
      status: "completed",
      score: 0.71,
      verdict: "hold",
      modelVersion: "astronet-triage-1",
    },
    external: [],
  },
  judgment: { value: "LIKELY_PLANET", evaluation: "UNSCORED" },
  skyVersion: "u-101:58",
  achievement: {
    result: "pending_publish",
    newlyRecognized: true,
    unlockedStars: [],
    star: { count: 2, grade: "S" },
  },
  publication: { state: "PUBLISHED", publicAnalysisId: "pa-9" },
  detail: { available: true, targetKind: "CURRENT_MATCH", answerViewed: true },
  progress: {
    stage: "completed",
    completionReason: "all_found",
    reopenPending: false,
    currentCurveStep: 1,
    remainingDiscoverableCount: 0,
  },
  judgmentStatistics: null,
  nextActions: ["VIEW_RESULT"],
  ...patch,
});
const body = (patch: Record<string, unknown> = {}) => ({
  historyId: ID,
  submission: submission(),
  versions: {
    data: "sec-14-41-54/r1",
    preprocess: null,
    pipeline: null,
    rule: "rule-3",
    residualModel: "rm-1",
    periodogramConfig: "pg-1",
    snapshotVersion: "folded-mad-v1",
  },
  snapshotParams: {
    periodogramViewport: { minDays: 8, maxDays: 16 },
    foldedXZoomRatio: 4,
    foldSettings: { referenceTimeBtjd: 1683.4231 },
    centroidDataStatus: "unavailable",
  },
  isPreviousBundle: false,
  relabel: null,
  createdAt: "2026-09-10T02:30:00Z",
  ...patch,
});
const read = (patch?: Record<string, unknown>) =>
  readHistoryDetail(body(patch), { historyId: ID });

test("the stored submission and the current state are both read", () => {
  const value = read();
  // 당시 값. 다시 계산하지 않는다.
  assert.equal(value.matchStatus, "matched_harmonic");
  assert.equal(value.explanation.correction?.multiplier, 2);
  assert.equal(value.explanation.submitted?.periodDays, 11.802);
  assert.equal(value.curveContext.curveStep, 1);
  // 조회 시점 값. 당시 진행이 아니다.
  assert.equal(value.progress.stage, "completed");
  assert.equal(value.explanation.publication.state, "PUBLISHED");
  assert.equal(value.explanation.achievement.star.grade, "S");
  // #188의 해설 파서를 그대로 탄다. 없는 열은 없는 채로 온다.
  assert.equal(value.explanation.signal?.bls.sde, null);
});

test("a response for another record is refused", () => {
  // 주소의 기록과 다른 기록이 오면 잘못 읽은 것이다.
  assert.throws(() => read({ historyId: "h-999" }), /historyId/);
  assert.throws(
    () => readHistoryDetail(body(), { historyId: "h-500" }),
    /historyId/,
  );
});

test("versions that were never kept stay empty", () => {
  const versions = read().versions;
  // 143이 보존하지 않은 값이다. 현재 처리 버전으로 꾸며 채우지 않는다.
  assert.equal(versions.preprocess, null);
  assert.equal(versions.pipeline, null);
  assert.equal(versions.data, "sec-14-41-54/r1");
  assert.equal(versions.snapshot, "folded-mad-v1");
  // 구기록에는 스냅샷 버전이 없다. 없다고 최신으로 추정하지 않는다.
  assert.equal(
    read({ versions: { ...body().versions, snapshotVersion: null } }).versions
      .snapshot,
    null,
  );
});

test("a viewport is a viewport only when both edges are there", () => {
  const params = read().snapshotParams;
  assert.deepEqual(params.periodogramViewport, { minDays: 8, maxDays: 16 });
  assert.equal(params.foldReferenceTimeBtjd, 1683.4231);
  // 한쪽만 오면 어디를 보던 것인지 알 수 없다.
  assert.throws(
    () =>
      read({
        snapshotParams: {
          ...body().snapshotParams,
          periodogramViewport: { minDays: 8, maxDays: null },
        },
      }),
    /periodogramViewport/,
  );
  // 뒤집힌 창도 창이 아니다.
  assert.throws(
    () =>
      read({
        snapshotParams: {
          ...body().snapshotParams,
          periodogramViewport: { minDays: 16, maxDays: 8 },
        },
      }),
    /periodogramViewport/,
  );
  // 접기 설정이 통째로 없는 기록도 있다. 그때는 기준 시각만 비운다.
  assert.equal(
    read({
      snapshotParams: { ...body().snapshotParams, foldSettings: null },
    }).snapshotParams.foldReferenceTimeBtjd,
    null,
  );
});

test("a relabel is a note, not a new verdict", () => {
  assert.equal(read().relabel, null);
  const value = read({
    relabel: {
      relabeledAt: "2026-09-18T05:00:00Z",
      newDisposition: "CONFIRMED",
    },
  });
  assert.equal(value.relabel?.newDisposition, "CONFIRMED");
  // 외부 라벨이 바뀌어도 당시 판정·성과는 그대로다(GRD-06).
  assert.equal(value.explanation.signal?.disposition, "UNCONFIRMED");
  assert.equal(value.explanation.achievement.result, "pending_publish");
});

test("a record whose plate and context disagree is refused", () => {
  assert.throws(
    () => read({ submission: submission({ bundleId: "9007199254740000" }) }),
    /bundleId/,
  );
});
