import assert from "node:assert/strict";
import { test } from "node:test";
import { readResultExplanation } from "../../src/features/analysis/submission-result";
import type { MatchStatus } from "../../src/features/analysis/submission-data";

// 여섯 축을 각각 읽고 서로 추측하지 않는지 본다. 한 축이 비었다고 다른 축을
// 0이나 없음으로 바꾸면 화면이 없는 사실을 지어낸다.

const signal = (patch: Record<string, unknown> = {}) => ({
  candidateId: "c-402",
  disposition: "UNCONFIRMED",
  answerClass: "analysis",
  planetTruth: null,
  bls: {
    periodDays: 23.604,
    epochBtjd: 1695.11,
    durationHours: 3.4,
    depthPpm: 380,
    sde: 9.1,
    snr: 7.8,
  },
  ai: {
    status: "completed",
    score: 0.71,
    verdict: "hold",
    modelVersion: "astronet-triage-1",
  },
  external: [
    {
      source: "TOI",
      externalId: "TOI-1234.02",
      disposition: "PC",
      fetchedOn: "2026-09-01",
    },
  ],
  ...patch,
});
const body = (patch: Record<string, unknown> = {}) => ({
  match: { status: "matched", candidateId: "c-402", harmonicMultiplier: null },
  signal: signal(),
  serverDerived: null,
  judgment: { value: "LIKELY_PLANET", evaluation: "UNSCORED" },
  achievement: {
    result: "pending_publish",
    newlyRecognized: false,
    unlockedStars: [],
    star: { count: 1, grade: "A" },
  },
  publication: { state: "UNPUBLISHED", publicAnalysisId: null },
  judgmentStatistics: {
    kind: "public_analyses",
    participantCount: 15,
    likelyPlanet: 8,
    unlikelyPlanet: 4,
    unsure: 3,
    percentages: { likelyPlanet: 53.3, unlikelyPlanet: 26.7, unsure: 20 },
    asOf: "2026-09-10T02:30:00Z",
  },
  detail: { available: true, targetKind: "CURRENT_MATCH", answerViewed: false },
  ...patch,
});
const read = (
  patch?: Record<string, unknown>,
  status: MatchStatus = "matched",
) => readResultExplanation(body(patch), status);

const bare = {
  match: { status: "not_matched", candidateId: null, harmonicMultiplier: null },
  signal: null,
  serverDerived: null,
  judgment: { value: "UNSURE", evaluation: "NOT_APPLICABLE" },
  achievement: {
    result: "none",
    newlyRecognized: false,
    unlockedStars: [],
    star: { count: 0, grade: null },
  },
  publication: { state: "NOT_ELIGIBLE", publicAnalysisId: null },
  judgmentStatistics: null,
  detail: {
    available: true,
    targetKind: "CURRENT_CURVE_HINT",
    answerViewed: false,
  },
};

test("a signal must be there exactly when the match succeeded", () => {
  assert.equal(read().signal?.candidateId, "c-402");
  // 매칭에 실패했는데 신호가 오면 응답을 잘못 읽은 것이다.
  assert.throws(
    () => readResultExplanation(body(), "not_matched"),
    /signal\/match.status/,
  );
  assert.throws(
    () => readResultExplanation(body(), "ambiguous_match"),
    /signal\/match.status/,
  );
  // 매칭에 성공했는데 신호가 없어도 마찬가지다.
  assert.throws(
    () => readResultExplanation({ ...bare }, "matched"),
    /signal\/match.status/,
  );
  assert.equal(readResultExplanation(bare, "not_matched").signal, null);
});

test("an unrunnable AI keeps no score, and a completed one must have it", () => {
  for (const status of ["input_insufficient", "error", "not_evaluated"]) {
    const ai = read({
      signal: signal({ ai: { status, modelVersion: null } }),
    }).signal!.ai;
    assert.equal(ai.status, status);
    // 실행 불가를 0점으로 바꾸지 않는다(RES-04, AT-15).
    assert.equal(ai.score, undefined);
    assert.equal(ai.verdict, undefined);
  }
  // 점수가 있다고 한 응답에 점수가 없으면 거절한다.
  assert.throws(
    () =>
      read({
        signal: signal({ ai: { status: "completed", modelVersion: null } }),
      }),
    /signal.ai.score/,
  );
});

test("an external label is kept as the source wrote it", () => {
  const external = read().signal!.external[0];
  // 원천 표기다. 우리 CONFIRMED/FP로 번역하지 않는다.
  assert.equal(external.disposition, "PC");
  assert.equal(external.source, "TOI");
  assert.equal(external.fetchedOn, "2026-09-01");
  // 우리 열거형이 아니므로 모르는 값도 그대로 통과한다.
  assert.equal(
    read({
      signal: signal({
        external: [
          {
            source: "ExoFOP",
            externalId: "x",
            disposition: "KP",
            fetchedOn: "2026-09-02",
          },
        ],
      }),
    }).signal!.external[0].disposition,
    "KP",
  );
});

test("nobody having published is kept apart from zero percent", () => {
  const empty = read({
    judgmentStatistics: {
      kind: "public_analyses",
      participantCount: 0,
      likelyPlanet: 0,
      unlikelyPlanet: 0,
      unsure: 0,
      percentages: null,
      asOf: "2026-09-10T02:30:00Z",
    },
  }).statistics;
  assert.equal(empty?.kind, "public_analyses");
  assert.equal(
    (empty as { percentages: unknown }).percentages,
    null,
    "0%로 바꾸면 아무도 그렇게 판단하지 않았다는 뜻이 된다",
  );
  // 참여자가 없는데 비율이 오면 응답이 모순이다.
  assert.throws(
    () =>
      read({
        judgmentStatistics: {
          kind: "public_analyses",
          participantCount: 0,
          likelyPlanet: 0,
          unlikelyPlanet: 0,
          unsure: 0,
          percentages: { likelyPlanet: 0, unlikelyPlanet: 0, unsure: 0 },
          asOf: "2026-09-10T02:30:00Z",
        },
      }),
    /percentages/,
  );
});

test("the two statistics shapes are not interchangeable", () => {
  const graded = read({
    judgmentStatistics: {
      kind: "graded",
      matchedMemberCount: 10,
      agreementPercent: 70,
    },
  }).statistics;
  assert.equal(graded?.kind, "graded");
  assert.equal(
    (graded as { matchedMemberCount: number }).matchedMemberCount,
    10,
  );
  assert.throws(() => read({ judgmentStatistics: { kind: "other" } }), /kind/);
  // 미매칭에 임의 신호의 통계를 붙이지 않는다.
  assert.throws(
    () =>
      readResultExplanation(
        {
          ...bare,
          judgmentStatistics: {
            kind: "graded",
            matchedMemberCount: 1,
            agreementPercent: 1,
          },
        },
        "not_matched",
      ),
    /judgmentStatistics\/match.status/,
  );
});

test("a harmonic correction belongs only to a harmonic match", () => {
  const corrected = readResultExplanation(
    body({
      match: {
        status: "matched_harmonic",
        candidateId: "c-402",
        harmonicMultiplier: 2,
        correctedPeriodDays: 23.604,
        correctionReason: "P/2 alias",
      },
    }),
    "matched_harmonic",
  ).correction;
  assert.equal(corrected?.multiplier, 2);
  assert.equal(corrected?.correctedPeriodDays, 23.604);
  // 배수가 없는 매칭에 정정값이 오면 어긋난 응답이다.
  assert.throws(
    () =>
      readResultExplanation(
        body({
          match: {
            status: "matched",
            candidateId: "c-402",
            harmonicMultiplier: 2,
            correctedPeriodDays: 23.604,
          },
        }),
        "matched",
      ),
    /harmonicMultiplier/,
  );
  assert.equal(read().correction, null);
});

test("unknown enum values are refused rather than guessed", () => {
  assert.throws(
    () => read({ signal: signal({ disposition: "PC" }) }),
    /signal.disposition/,
  );
  assert.throws(
    () => read({ achievement: { ...body().achievement, result: "granted" } }),
    /achievement.result/,
  );
  assert.throws(
    () => read({ publication: { state: "PUBLIC", publicAnalysisId: null } }),
    /publication.state/,
  );
  assert.throws(
    () => read({ judgment: { value: "UNSURE", evaluation: "CORRECT" } }),
    /judgment.evaluation/,
  );
});

test("only the ids of newly opened stars are taken", () => {
  const value = read({
    achievement: {
      result: "recognized",
      newlyRecognized: true,
      unlockedStars: [
        { ticId: "259377031", position: { x: 1, y: 2, z: 0.3 } },
        { ticId: "259377032", position: { x: 4, y: 5, z: 0.6 } },
      ],
      star: { count: 2, grade: "S" },
    },
  }).achievement;
  // 좌표는 지도가 쓰는 값이라 결과 화면이 들고 다니지 않는다.
  assert.deepEqual(value.unlockedTicIds, ["259377031", "259377032"]);
  assert.equal(value.star.grade, "S");
});
