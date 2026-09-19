import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisContextFixture,
  ANALYSIS_FIXTURE_TICS,
} from "../../dev/analysis-fixtures";
import {
  periodContextFixture,
  PERIODOGRAM_FIXTURE_TICS,
} from "../../dev/periodogram-fixtures";
import { decodeAnalysisContext } from "../../src/features/analysis/analysis-data";
import {
  candidateInput,
  noCandidateInput,
  skippedInput,
  specialSubmissions,
} from "../../src/features/analysis/submission-input";
import type { CandidateReview } from "../../src/features/analysis/analysis-judgment";
import { submissionFingerprint } from "../../src/features/analysis/submission-request";

const context = (ticId = PERIODOGRAM_FIXTURE_TICS.normal) =>
  decodeAnalysisContext(periodContextFixture(ticId), ticId);

const review = (): CandidateReview => ({
  ticId: PERIODOGRAM_FIXTURE_TICS.normal,
  selectionRulesVersion: "selection-synthetic-183-v1",
  epochPreviewBtjd: 1743.35,
  durationPreviewHours: 2,
  input: {
    submissionKind: "candidate",
    curveContext: context().curveContext,
    selection: {
      periodDays: 11.7346,
      sourcePeakGridIndex: 3600,
      phaseStart: 0.49,
      phaseEnd: 0.51,
    },
    userJudgment: "LIKELY_PLANET",
    evidenceChecks: ["oddeven"],
    memo: "홀짝 깊이가 비슷하다",
    viewState: {
      periodogramViewport: { minDays: 8, maxDays: 16 },
      foldedXZoomRatio: 4,
    },
    retryOfSubmissionId: null,
  },
});

test("a candidate submission carries the reviewed snapshot as its own copy", () => {
  const source = review();
  const input = candidateInput(source);
  assert.equal(input.submissionKind, "candidate");
  assert.deepEqual(input.selection, source.input.selection);
  assert.equal(input.memo, "홀짝 깊이가 비슷하다");
  assert.equal(input.retryOfSubmissionId, null);

  // 본문을 만든 뒤 초안을 건드려도 보낼 내용이 따라 바뀌면 안 된다.
  source.input.evidenceChecks.push("ushape");
  source.input.curveContext.removedCandidateIds.push("c-999");
  source.input.viewState.periodogramViewport.minDays = 1;
  assert.deepEqual(input.evidenceChecks, ["oddeven"]);
  assert.deepEqual(input.curveContext.removedCandidateIds, []);
  assert.deepEqual(
    (input.viewState as { periodogramViewport: { minDays: number } })
      .periodogramViewport.minDays,
    8,
  );
});

test("no_candidate and skipped carry nothing but the kind and the curve context", () => {
  for (const input of [
    noCandidateInput(context().curveContext),
    skippedInput(context().curveContext),
  ]) {
    // 완료 조건: 이전 후보의 수치·판단·근거가 섞이면 안 된다.
    for (const field of [
      "selection",
      "userJudgment",
      "evidenceChecks",
      "memo",
      "viewState",
    ])
      assert.equal(field in input, false, `${field}를 실으면 안 된다`);
    assert.deepEqual(Object.keys(input).sort(), [
      "curveContext",
      "retryOfSubmissionId",
      "submissionKind",
    ]);
    assert.deepEqual(input.curveContext, context().curveContext);
  }
  assert.equal(
    noCandidateInput(context().curveContext).submissionKind,
    "no_candidate",
  );
  assert.equal(skippedInput(context().curveContext).submissionKind, "skipped");
});

test("the three kinds never share a request id because their bodies differ", () => {
  // 지문이 같으면 보존한 ID를 재사용해 IDEMPOTENCY_CONFLICT가 난다.
  const prints = new Set(
    [
      candidateInput(review()),
      noCandidateInput(context().curveContext),
      skippedInput(context().curveContext),
    ].map(submissionFingerprint),
  );
  assert.equal(prints.size, 3);
});

test("skipping is offered only with the server's permission", () => {
  const ordinary = specialSubmissions(context());
  const skip = ordinary.find((item) => item.kind === "skipped")!;
  // 조건은 서버만 안다. 허용 표시가 없으면 제안하지 않는다.
  assert.equal(skip.unavailable, "지금은 건너뛸 수 없습니다.");

  const tutorial = specialSubmissions(
    context(PERIODOGRAM_FIXTURE_TICS.tutorial),
  );
  assert.equal(
    tutorial.find((item) => item.kind === "skipped")!.unavailable,
    null,
  );
});

test("more-none is blocked only when the star is known to be finished", () => {
  const none = (value: unknown) => {
    const raw = periodContextFixture();
    (raw as { progress: { stage: string } }).progress.stage = value as string;
    const decoded = decodeAnalysisContext(raw, PERIODOGRAM_FIXTURE_TICS.normal);
    return specialSubmissions(decoded).find(
      (item) => item.kind === "no_candidate",
    )!;
  };
  assert.equal(none("in_progress").unavailable, null);
  assert.equal(none("unexplored").unavailable, null);
  assert.equal(none("completed").unavailable, "이미 탐색을 마친 별입니다.");
});

test("a context without progress or tutorial blocks nothing and offers nothing", () => {
  // 관측 export 문맥에는 이 필드가 없을 수 있다. 근거가 없다고 막지 않는다.
  const raw = analysisContextFixture() as Record<string, unknown>;
  delete raw.progress;
  delete raw.tutorial;
  const decoded = decodeAnalysisContext(raw, ANALYSIS_FIXTURE_TICS.normal);
  assert.equal(decoded.progressStage, null);
  assert.equal(decoded.skipAvailable, false);
  const options = specialSubmissions(decoded);
  assert.equal(
    options.find((item) => item.kind === "no_candidate")!.unavailable,
    null,
  );
  assert.notEqual(
    options.find((item) => item.kind === "skipped")!.unavailable,
    null,
  );
});

test("an unknown progress stage is refused rather than guessed", () => {
  const raw = periodContextFixture() as { progress: { stage: string } };
  raw.progress.stage = "paused";
  assert.throws(
    () => decodeAnalysisContext(raw, PERIODOGRAM_FIXTURE_TICS.normal),
    /progress.stage/,
  );
});
