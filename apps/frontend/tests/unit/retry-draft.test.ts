import test from "node:test";
import assert from "node:assert/strict";
import {
  readRetryDraft,
  retryDraftPath,
} from "../../src/features/analysis/retry-draft.ts";

// API 6.8 / FE 6.3, FAV-20. 합성 응답이며 운영 API 재환산 검증이 아니다.
function fixture() {
  return {
    sourceSubmissionId: "sub-9007199254740993",
    retryOfSubmissionId: "sub-9007199254740993",
    bundleId: "b-3",
    isPreviousBundle: true,
    curveContext: {
      bundleId: "b-3",
      curveStep: 0,
      removedCandidateIds: [] as string[],
      residualModelVersion: "rm-1",
      periodogramConfigVersion: "pg-1",
    },
    restored: { step: true, notice: null as string | null },
    draft: {
      periodDays: 4 as number | null,
      phaseStart: 0.95 as number | null,
      phaseEnd: 1.05 as number | null,
      viewState: {
        periodogramViewport: { minDays: 2, maxDays: 8 },
        foldedXZoomRatio: 32,
      },
      userJudgment: null,
      evidenceChecks: [],
      memo: null,
    },
    residualForStep: {
      status: "COMPLETED" as string | null,
      jobId: null as string | null,
    },
  };
}
test("retry draft preserves large IDs and server-rebased wrapping phase without a second conversion", () => {
  const input = fixture();
  assert.deepEqual(readRetryDraft(input, input.sourceSubmissionId), input);
  assert.equal(retryDraftPath("sub/a"), "/v1/submissions/sub%2Fa/retry-draft");
});
test("selection-less submissions retain null values rather than invented periods", () => {
  const input = fixture();
  input.draft.periodDays = input.draft.phaseStart = input.draft.phaseEnd = null;
  assert.equal(
    readRetryDraft(input, input.sourceSubmissionId).draft.periodDays,
    null,
  );
});

test("all API residual progress stages retain their job identity", () => {
  for (const status of [
    "QUEUED",
    "RESIDUAL_CALCULATING",
    "RESIDUAL_READY",
    "PERIODOGRAM_CALCULATING",
  ]) {
    const input = fixture();
    input.curveContext.curveStep = 1;
    input.curveContext.removedCandidateIds = ["c-1"];
    input.residualForStep = { status, jobId: "job-1" };
    assert.equal(
      readRetryDraft(input, input.sourceSubmissionId).residualForStep.status,
      status,
    );
  }
});
test("retired removal combinations accept the server replacement and empty residual cache", () => {
  const input = fixture();
  input.curveContext.curveStep = 1;
  input.curveContext.removedCandidateIds = ["c-5"];
  input.restored = { step: false, notice: "STEP_NOT_RESTORABLE" };
  input.residualForStep.status = null;
  assert.deepEqual(readRetryDraft(input, input.sourceSubmissionId), input);
});
test("malformed identity, context, selection and stale answers fail closed", () => {
  for (const change of [
    { sourceSubmissionId: "sub-other" },
    { retryOfSubmissionId: 9007199254740993 },
    { bundleId: "b-other" },
    { restored: { step: false, notice: null } },
    { draft: { ...fixture().draft, phaseStart: null } },
    { draft: { ...fixture().draft, periodDays: Infinity } },
    { draft: { ...fixture().draft, phaseEnd: 2 } },
    { draft: { ...fixture().draft, userJudgment: "UNSURE" } },
    { draft: { ...fixture().draft, evidenceChecks: ["oddeven"] } },
    { draft: { ...fixture().draft, memo: "old" } },
    { residualForStep: { status: "RUNNING", jobId: null } },
  ]) {
    assert.throws(() =>
      readRetryDraft({ ...fixture(), ...change }, fixture().sourceSubmissionId),
    );
  }
});
