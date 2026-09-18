import assert from "node:assert/strict";
import { test } from "node:test";
import { memoCodePoints } from "../../src/features/analysis/analysis-judgment";
import {
  createCandidateReview,
  emptyJudgment,
  validateJudgment,
  type Evidence,
  type PhasePreview,
} from "../../src/features/analysis/analysis-judgment";

const preview: PhasePreview = {
  kind: "preview",
  selection: {
    periodDays: 11.802123456789,
    sourcePeakGridIndex: null,
    phaseStart: 0.995123456789,
    phaseEnd: 1.005123456789,
  },
  epochPreviewBtjd: 1700.123456789,
  durationPreviewDays: 0.11802123456789,
  durationPreviewHours: 2.83250962962936,
  limits: {
    minWindowDays: 0.01,
    maxWindowDays: 0.3,
    minPhaseWidth: 0.001,
    maxPhaseWidth: 0.03,
  },
  selectionRulesVersion: "rules-1",
  pendingChecks: ["phase-coverage", "server-validation"],
};
test("memo bound counts Unicode code points without truncating or trimming", () => {
  const memo = "🌌".repeat(200);
  assert.equal(memoCodePoints(memo), 200);
  assert.deepEqual(
    validateJudgment({ ...emptyJudgment, userJudgment: "UNSURE", memo }),
    [],
  );
  assert.equal(
    validateJudgment({
      ...emptyJudgment,
      userJudgment: "UNSURE",
      memo: memo + "가",
    })[0].field,
    "memo",
  );
});
test("judgment is required; every allowed judgment permits empty optional evidence and memo", () => {
  assert.equal(validateJudgment(emptyJudgment)[0].field, "userJudgment");
  for (const userJudgment of [
    "LIKELY_PLANET",
    "UNLIKELY_PLANET",
    "UNSURE",
  ] as const)
    assert.deepEqual(validateJudgment({ ...emptyJudgment, userJudgment }), []);
});
test("unsupported centroid evidence and duplicates cannot enter a review", () => {
  for (const evidenceChecks of [["centroid"], ["oddeven", "oddeven"]])
    assert.equal(
      validateJudgment({
        userJudgment: "UNSURE",
        memo: "",
        evidenceChecks: evidenceChecks as Evidence[],
      })[0].field,
      "evidenceChecks",
    );
});
test("review snapshot retains exact original values, string identifiers and isolated copies, without derived API inputs", () => {
  const context = {
    bundleId: "9223372036854775807",
    curveStep: 1,
    removedCandidateIds: ["9223372036854775806"],
    residualModelVersion: "rm-1",
    periodogramConfigVersion: "pg-1",
  };
  const draft = {
    userJudgment: "UNSURE" as const,
    evidenceChecks: ["oddeven" as const],
    memo: "  메모🌌\n원문  ",
  };
  const viewport = { minDays: 8, maxDays: 16 };
  const review = createCandidateReview(
    "9223372036854775805",
    context,
    preview,
    draft,
    viewport,
    32,
  );
  assert.deepEqual(review.input.selection, preview.selection);
  assert.equal(review.ticId, "9223372036854775805");
  assert.equal(review.input.memo, draft.memo);
  assert.equal(review.input.viewState.foldedXZoomRatio, 32);
  assert.equal("requestId" in review.input, false);
  assert.equal("epoch" in review.input.selection, false);
  assert.equal("duration" in review.input.selection, false);
  assert.equal("selectionRulesVersion" in review.input, false);
  assert.equal("center" in review.input.viewState, false);
  context.removedCandidateIds.length = 0;
  draft.evidenceChecks.length = 0;
  viewport.minDays = 10;
  assert.deepEqual(review.input.curveContext.removedCandidateIds, [
    "9223372036854775806",
  ]);
  assert.deepEqual(review.input.evidenceChecks, ["oddeven"]);
  assert.equal(review.input.viewState.periodogramViewport.minDays, 8);
});
test("review rejects invalid view bounds and zoom", () => {
  const context = {
    bundleId: "b",
    curveStep: 0,
    removedCandidateIds: [],
    residualModelVersion: "r",
    periodogramConfigVersion: "p",
  };
  for (const zoom of [0, 33, NaN, Infinity])
    assert.throws(() =>
      createCandidateReview(
        "1",
        context,
        preview,
        { ...emptyJudgment, userJudgment: "UNSURE" },
        { minDays: 1, maxDays: 10 },
        zoom,
      ),
    );
});
