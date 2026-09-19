import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateOutcome } from "../../dev/submission-outcome-fixtures";

// 개발용 결과 조합이 명세의 규칙을 그대로 따르는지 본다. 이 표가 틀리면 화면
// 검사 전체가 틀린 기대값 위에서 통과한다.
const PEAK = { confirmed: 3600, unconfirmed: 2500, fp: 1600 };
const outcome = (
  peak: number | null,
  userJudgment: "LIKELY_PLANET" | "UNLIKELY_PLANET" | "UNSURE",
  extra: Record<string, boolean> = {},
) =>
  candidateOutcome({
    sourcePeakGridIndex: peak,
    periodDays: 11.7346,
    userJudgment,
    ...extra,
  });

test("scoring follows the disposition, not the user's confidence", () => {
  // 확정: 행성 같음이 맞고 아닌 것 같음이 틀리다.
  assert.equal(
    outcome(PEAK.confirmed, "LIKELY_PLANET").judgment.evaluation,
    "AGREES",
  );
  assert.equal(
    outcome(PEAK.confirmed, "UNLIKELY_PLANET").judgment.evaluation,
    "DISAGREES",
  );
  // FP: 반대다. 같은 판단이 반대 결과를 받는다.
  assert.equal(
    outcome(PEAK.fp, "UNLIKELY_PLANET").judgment.evaluation,
    "AGREES",
  );
  assert.equal(
    outcome(PEAK.fp, "LIKELY_PLANET").judgment.evaluation,
    "DISAGREES",
  );
  // 미확정은 채점하지 않는다. 틀렸다고 하지 않는다.
  assert.equal(
    outcome(PEAK.unconfirmed, "LIKELY_PLANET").judgment.evaluation,
    "UNSCORED",
  );
  // 모르겠음은 확정·FP 모두 UNSURE다. 명세 표에 FP 칸이 없어 대칭으로 둔다.
  assert.equal(outcome(PEAK.confirmed, "UNSURE").judgment.evaluation, "UNSURE");
  assert.equal(outcome(PEAK.fp, "UNSURE").judgment.evaluation, "UNSURE");
});

test("a correct match does not always mean an achievement", () => {
  // 완료 조건: 오판·UNSURE도 매칭은 성공이고 성과만 미인정이다.
  const wrong = outcome(PEAK.confirmed, "UNLIKELY_PLANET");
  assert.equal(wrong.match.status, "matched");
  assert.equal(wrong.achievement.result, "judgment_mismatch");
  assert.equal(wrong.achievement.newlyRecognized, false);

  const unsure = outcome(PEAK.confirmed, "UNSURE");
  assert.equal(unsure.match.status, "matched");
  assert.equal(unsure.achievement.result, "judgment_mismatch");

  const right = outcome(PEAK.confirmed, "LIKELY_PLANET");
  assert.equal(right.achievement.result, "recognized");
  assert.equal(right.achievement.newlyRecognized, true);
  assert.equal(right.achievement.unlockedStars.length, 1);

  // 미확정은 공개해야 판정한다. 지금은 보류다.
  assert.equal(
    outcome(PEAK.unconfirmed, "LIKELY_PLANET").achievement.result,
    "pending_publish",
  );
  // 이미 찾은 신호는 다시 인정하지 않는다.
  assert.equal(
    outcome(PEAK.confirmed, "LIKELY_PLANET", { duplicate: true }).achievement
      .result,
    "already_recognized",
  );
});

test("only an unconfirmed match can be published", () => {
  assert.equal(
    outcome(PEAK.unconfirmed, "UNSURE").publication.state,
    "UNPUBLISHED",
  );
  for (const peak of [PEAK.confirmed, PEAK.fp])
    assert.equal(outcome(peak, "UNSURE").publication.state, "NOT_ELIGIBLE");
});

test("statistics use a different shape for scored and unscored signals", () => {
  const graded = outcome(PEAK.confirmed, "LIKELY_PLANET").judgmentStatistics;
  assert.equal(graded?.kind, "graded");
  assert.equal("participantCount" in (graded ?? {}), false);

  const open = outcome(PEAK.unconfirmed, "UNSURE").judgmentStatistics;
  assert.equal(open?.kind, "public_analyses");
  assert.equal((open as { participantCount: number }).participantCount, 15);
});

test("nobody having published yet is not zero percent", () => {
  const empty = outcome(PEAK.unconfirmed, "UNSURE", {
    emptyStatistics: true,
  }).judgmentStatistics as {
    participantCount: number;
    percentages: unknown;
  };
  assert.equal(empty.participantCount, 0);
  // 0%로 그리면 아무도 그렇게 판단하지 않았다는 뜻이 된다. 아직 없는 것이다.
  assert.equal(empty.percentages, null);
});

test("an unrunnable AI has no score at all", () => {
  const ai = outcome(PEAK.fp, "UNLIKELY_PLANET").signal!.ai as Record<
    string,
    unknown
  >;
  assert.equal(ai.status, "input_insufficient");
  // 실행 불가를 0점으로 바꾸지 않는다(RES-04, AT-15).
  assert.equal("score" in ai, false);
  assert.equal("verdict" in ai, false);
});

test("an ambiguous match attaches no signal, achievement or statistics", () => {
  const value = outcome(PEAK.confirmed, "LIKELY_PLANET", { ambiguous: true });
  assert.equal(value.match.status, "ambiguous_match");
  // 서버가 일부러 고르지 않았다. 가장 가까운 후보를 대신 고르지 않는다.
  assert.equal(value.signal, null);
  assert.equal(value.judgmentStatistics, null);
  assert.equal(value.achievement.result, "none");
  assert.equal(value.detail.targetKind, null);
  assert.deepEqual(value.nextActions, ["RETRY"]);
});

test("a period the user picked freely is not matched and gets a hint", () => {
  const value = outcome(null, "UNSURE");
  assert.equal(value.match.status, "not_matched");
  assert.equal(value.signal, null);
  assert.equal(value.judgment.evaluation, "NOT_APPLICABLE");
  assert.equal(value.judgmentStatistics, null);
  // 미매칭은 그 단계의 힌트를 준다(RES-09).
  assert.equal(value.detail.targetKind, "CURRENT_CURVE_HINT");
  assert.equal(value.nextActions.includes("DISCUSS"), true);
});

test("a harmonic match keeps both the submitted and corrected period", () => {
  const value = outcome(PEAK.unconfirmed, "LIKELY_PLANET");
  assert.equal(value.match.status, "matched_harmonic");
  const match = value.match as {
    harmonicMultiplier: number;
    correctedPeriodDays: number;
  };
  // 6.3절: 정정 주기 = 제출 주기 × 배율.
  assert.equal(match.harmonicMultiplier, 2);
  assert.equal(match.correctedPeriodDays, 11.7346 * 2);
  // 배수가 아닌 매칭은 정정값을 만들지 않는다.
  const plain = outcome(PEAK.confirmed, "LIKELY_PLANET").match as {
    harmonicMultiplier: number | null;
    correctedPeriodDays: number | null;
  };
  assert.equal(plain.harmonicMultiplier, null);
  assert.equal(plain.correctedPeriodDays, null);
});

test("publishing is offered only where it is possible", () => {
  assert.equal(
    outcome(PEAK.unconfirmed, "UNSURE").nextActions.includes(
      "PUBLISH_ANALYSIS",
    ),
    true,
  );
  assert.equal(
    outcome(PEAK.confirmed, "LIKELY_PLANET").nextActions.includes(
      "PUBLISH_ANALYSIS",
    ),
    false,
  );
});
