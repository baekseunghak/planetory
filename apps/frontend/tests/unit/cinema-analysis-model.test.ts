import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  candidatePeaksFixture,
  periodContextFixture,
  periodogramFixture,
  periodogramFixtureResponse,
  PERIODOGRAM_FIXTURE_TICS,
} from "../../dev/periodogram-fixtures";
import {
  SUBMISSION_FIXTURE_CSRF,
  submissionFixtureResponse,
  type SubmissionOutcomeKind,
} from "../../dev/submission-fixtures";
import { ApiError } from "../../src/api/client";
import { outcomeFromReceipt } from "../../src/cinema/analysis/bridge";
import {
  binsForWidth,
  bridgeSelection,
  foldBins,
  foldMessage,
  format,
  guidance,
  handleStep,
  inlineResult,
  judgmentFromBody,
  keyboardWindow,
  moveCursor,
  periodKeyStep,
  periodogramNotice,
  phaseAt,
  submissionView,
  windowHint,
  windowStats,
  type GuidanceInput,
} from "../../src/cinema/analysis-new/model";
import { decodeAnalysisContext } from "../../src/features/analysis/analysis-data";
import {
  choosePeriod,
  periodChange,
  type ReadyPeriodogram,
} from "../../src/features/analysis/period-selection";
import {
  decodeCandidatePeaks,
  decodePeriodogram,
  PeriodogramBundleChanged,
  PeriodogramContextChanged,
} from "../../src/features/analysis/periodogram-data";
import {
  getSelectionLimits,
  previewPhaseSelection,
} from "../../src/features/analysis/phase-selection";
import { decodeSubmissionReceipt } from "../../src/features/analysis/submission-data";

const TIC = PERIODOGRAM_FIXTURE_TICS.normal;

function ready() {
  const raw = periodContextFixture(TIC);
  const context = decodeAnalysisContext(raw, TIC);
  const grid = decodePeriodogram(periodogramFixture(TIC), context);
  const candidates = decodeCandidatePeaks(
    candidatePeaksFixture(TIC),
    context,
    grid,
  );
  const data: ReadyPeriodogram = {
    kind: "ready",
    selectionEnabled: true,
    periodogram: grid,
    candidates,
    rules: context.periodSelectionRules!,
  };
  return { context, data };
}

test("fold bins average the repeated display and skip thin bins", () => {
  const phases = Float64Array.from([0.1, 0.1, 0.6, 0.6, 0.95]);
  const flux = [1, 0.9, 1.2, 1.0, 0.5];
  const bins = foldBins(phases, flux, 0, 1, 2);
  assert.equal(bins.length, 2);
  assert.ok(Math.abs(bins[0]! - 0.95) < 1e-12);
  assert.ok(Math.abs(bins[1]! - (1.2 + 1.0 + 0.5) / 3) < 1e-12);
  // The two-cycle display repeats phase 0.95 at -0.05: only one point there.
  assert.deepEqual(foldBins(phases, flux, -0.1, 0, 1), [null]);
  assert.deepEqual(foldBins(phases, flux, 1, 1, 4), []);
});

test("bin count follows the plot width within bounds", () => {
  assert.equal(binsForWidth(60), 24);
  assert.equal(binsForWidth(480), 80);
  assert.equal(binsForWidth(4000), 160);
});

test("window stats count wrapped windows and estimate the relative depth", () => {
  const phases = Float64Array.from([0.001, 0.999, 0.5, 0.25, 0.75]);
  const flux = [0.99, 0.99, 1, 1, 1];
  const wrapped = windowStats(phases, flux, {
    phaseStart: 0.99,
    phaseEnd: 1.01,
  });
  assert.equal(wrapped.inside, 2);
  assert.equal(wrapped.outside, 3);
  assert.ok(Math.abs(wrapped.depth! - 0.01) < 1e-12);
  const empty = windowStats(phases, flux, { phaseStart: 0.3, phaseEnd: 0.31 });
  assert.equal(empty.inside, 0);
  assert.equal(empty.depth, null);
});

test("handles move 1/1000 of the view, Shift ten times, inside the display", () => {
  assert.ok(Math.abs(handleStep(1, 1, false, 0.5, 1.5) - 1.001) < 1e-12);
  assert.ok(Math.abs(handleStep(1, -1, true, 0.5, 1.5) - 0.99) < 1e-12);
  assert.equal(handleStep(1.4999, 1, true, -0.5, 1.5), 1.5);
  assert.equal(handleStep(-0.4999, -1, true, -0.5, 1.5), -0.5);
});

test("the keyboard window is the middle width, centred and kept on the display", () => {
  const limits = { minPhaseWidth: 0.002, maxPhaseWidth: 0.02 };
  const middle = keyboardWindow(limits, 1);
  assert.ok(Math.abs(middle.phaseEnd - middle.phaseStart - 0.011) < 1e-12);
  assert.ok(Math.abs((middle.phaseStart + middle.phaseEnd) / 2 - 1) < 1e-12);
  const edge = keyboardWindow(limits, 1.5);
  assert.ok(Math.abs(edge.phaseEnd - 1.5) < 1e-12);
  assert.equal(phaseAt(50, 100, 0.5, 1.5), 1);
  assert.equal(phaseAt(-20, 100, 0.5, 1.5), 0.5);
});

test("arrow keys fine-tune a peak inside the server range and never a direct pick", () => {
  const { data } = ready();
  const peak = data.candidates.peaks[0];
  const selection = choosePeriod(data, {
    kind: "peak",
    gridIndex: peak.gridIndex,
  });
  const right = periodKeyStep(selection, "ArrowRight", false)!;
  assert.ok(Math.abs(right - (peak.periodDays + selection.fineStep!)) < 1e-12);
  const coarse = periodKeyStep(selection, "ArrowLeft", true)!;
  assert.ok(Math.abs(coarse - (peak.periodDays - selection.step!)) < 1e-12);
  assert.equal(periodKeyStep(selection, "Home", false), selection.minimum);
  assert.equal(periodKeyStep(selection, "End", false), selection.maximum);
  const top = periodKeyStep(
    { ...selection, periodDays: selection.maximum },
    "PageUp",
    false,
  );
  assert.equal(top, selection.maximum, "never beyond the fine-tune range");
  assert.equal(periodKeyStep(selection, "Enter", false), null);
  const direct = choosePeriod(data, { kind: "direct", periodDays: 5 });
  assert.equal(periodKeyStep(direct, "ArrowRight", false), null);
  assert.equal(periodKeyStep(null, "ArrowRight", false), null);
  assert.equal(moveCursor(null, 10, 5, 100), 15);
  assert.equal(moveCursor(98, 0, 10, 100), 99);
  assert.equal(moveCursor(2, 0, -10, 100), 0);
});

test("periodogram notices keep the classic words and actions", () => {
  assert.equal(periodogramNotice({ kind: "loading" }).action, null);
  const bundle = periodogramNotice({
    kind: "error",
    error: new PeriodogramBundleChanged(),
  });
  assert.equal(bundle.action, "reload-analysis");
  assert.match(bundle.message, /데이터 판이 계속 바뀌어/);
  assert.equal(
    periodogramNotice({ kind: "error", error: new PeriodogramContextChanged() })
      .action,
    "reload-analysis",
  );
  const denied = periodogramNotice({
    kind: "error",
    error: new ApiError(403, "FORBIDDEN", "x"),
  });
  assert.equal(denied.action, "retry");
  assert.match(denied.message, /권한이 없습니다/);
  const empty = periodogramNotice({
    kind: "loaded",
    data: {
      kind: "unavailable",
      selectionEnabled: false,
      reason: "empty-peaks",
    },
  });
  assert.match(empty.message, /신호가 없다는 뜻은 아닙니다/);
  assert.equal(empty.action, "retry");
  const rules = periodogramNotice({
    kind: "loaded",
    data: {
      kind: "unavailable",
      selectionEnabled: false,
      reason: "rules-unavailable",
    },
  });
  assert.equal(rules.action, "reload-analysis");
  const failed = periodogramNotice({
    kind: "loaded",
    data: {
      kind: "unavailable",
      selectionEnabled: false,
      reason: "periodogram-not-ready",
      pending: { status: "FAILED", jobId: "j" },
    },
  });
  assert.match(failed.message, /계산에 실패했습니다/);
});

test("window hints follow the server width rule and the bridge gets the preview", () => {
  const { context, data } = ready();
  const peak = data.candidates.peaks[0];
  const change = periodChange(
    data,
    null,
    "reselect",
    choosePeriod(data, { kind: "peak", gridIndex: peak.gridIndex }),
  );
  const limits = getSelectionLimits(context, data, change);
  const wide = { phaseStart: 0.9, phaseEnd: 1.1 };
  const tooWide = previewPhaseSelection(context, data, change, 0.9, 1.1);
  assert.equal(tooWide.kind, "invalid");
  assert.match(windowHint(tooWide, wide, limits, peak.periodDays)!, /넓습니다/);
  const narrowRange = { phaseStart: 1, phaseEnd: 1 + limits.minPhaseWidth / 2 };
  const tooNarrow = previewPhaseSelection(
    context,
    data,
    change,
    narrowRange.phaseStart,
    narrowRange.phaseEnd,
  );
  assert.match(
    windowHint(tooNarrow, narrowRange, limits, peak.periodDays)!,
    /좁습니다/,
  );
  const width = (limits.minPhaseWidth + limits.maxPhaseWidth) / 2;
  const good = previewPhaseSelection(
    context,
    data,
    change,
    1 - width / 2,
    1 + width / 2,
  );
  assert.equal(good.kind, "preview");
  assert.equal(windowHint(good, wide, limits, peak.periodDays), null);
  const bridged = bridgeSelection(good, true)!;
  assert.equal(bridged.confirmed, true);
  assert.ok(bridged.startPhase >= 0 && bridged.startPhase < 1);
  assert.ok(bridged.endPhase > 1, "wrapping window keeps endPhase above 1");
  assert.equal(bridgeSelection(tooWide, false), null);
  assert.equal(bridgeSelection(null, false), null);
});

test("fold messages keep the classic recovery words", () => {
  const base = {
    inputError: null,
    points: 10,
    status: "success" as const,
    hasSuccess: true,
    hasChange: true,
  };
  assert.match(
    foldMessage({ ...base, points: 0 }),
    /신호가 없다는 뜻은 아닙니다/,
  );
  assert.match(
    foldMessage({ ...base, status: "error", message: "boom" }),
    /접기에 실패했습니다\. boom 마지막으로 성공한/,
  );
  assert.match(
    foldMessage({ ...base, status: "cancelled", hasSuccess: false }),
    /아직 성공한 접기 결과가 없습니다/,
  );
  assert.match(foldMessage({ ...base, hasChange: false }), /주기를 선택하면/);
});

test("the guidance line follows the state", () => {
  const g: GuidanceInput = {
    periodogram: "ready",
    stage: 1,
    period: "none",
    folding: false,
    foldProblem: false,
    zoom: 1,
    range: false,
    dragging: false,
    preview: "none",
    hint: null,
    judgment: false,
    submission: "idle",
    preparing: null,
  };
  assert.match(guidance(g), /추천 봉우리/);
  assert.equal(
    guidance({ ...g, preparing: "곡선 단계 1" }),
    "곡선 단계 1을 준비하고 있습니다. 준비되면 곡선이 바뀝니다.",
  );
  assert.match(guidance({ ...g, period: "peak" }), /다듬고/);
  assert.match(guidance({ ...g, folding: true, period: "peak" }), /접고/);
  assert.match(guidance({ ...g, stage: 2, period: "peak" }), /확대한 뒤/);
  assert.match(
    guidance({ ...g, stage: 2, period: "peak", zoom: 8 }),
    /^밝기가 떨어지는/,
  );
  assert.equal(
    guidance({
      ...g,
      stage: 2,
      period: "peak",
      range: true,
      preview: "invalid",
      hint: "넓다",
    }),
    "넓다",
  );
  assert.match(
    guidance({ ...g, stage: 2, range: true, preview: "valid" }),
    /판단을 고르세요/,
  );
  assert.match(guidance({ ...g, stage: 3, range: true }), /판단을 고르세요/);
  assert.match(
    guidance({ ...g, stage: 3, range: true, judgment: true }),
    /제출하세요/,
  );
  assert.match(guidance({ ...g, submission: "busy" }), /제출하고 있습니다/);
  assert.match(guidance({ ...g, periodogram: "loading" }), /불러오고/);
  for (const text of [
    guidance(g),
    guidance({ ...g, submission: "problem" }),
    guidance({ ...g, stage: 3, judgment: true }),
  ])
    assert.ok(!text.includes("—"), "no em-dash asides");
});

// Real receipts through the dev fixture and the production decoder.
function receipt(
  body: Record<string, unknown>,
  outcome: SubmissionOutcomeKind | null = null,
) {
  const requestId = randomUUID();
  const reply = submissionFixtureResponse({
    method: "POST",
    url: new URL(`http://fixture.invalid/v1/stars/${TIC}/submissions`),
    csrf: SUBMISSION_FIXTURE_CSRF,
    scenario: null,
    outcome,
    body: { requestId, ...body },
    contextFor: (tic) =>
      periodogramFixtureResponse(
        new URL(`http://fixture.invalid/v1/stars/${tic}/analysis-context`),
      ),
  });
  assert.ok(reply && reply.kind === "json");
  return decodeSubmissionReceipt(reply.body, { ticId: TIC, requestId }, 201);
}
const candidate = (
  rank: number | null,
  userJudgment: "LIKELY_PLANET" | "UNLIKELY_PLANET" | "UNSURE",
) => {
  const peaks = candidatePeaksFixture(TIC).peaks;
  const peak = rank === null ? null : peaks[rank - 1];
  return {
    submissionKind: "candidate",
    curveContext: periodContextFixture(TIC).currentCurveContext,
    selection: {
      periodDays: peak?.periodDays ?? 5,
      sourcePeakGridIndex: peak?.gridIndex ?? null,
      phaseStart: 0.995,
      phaseEnd: 1.005,
    },
    userJudgment,
    evidenceChecks: [],
    memo: "",
  };
};

test("inline results come from the real receipt for each outcome kind", () => {
  const matched = inlineResult(
    outcomeFromReceipt(receipt(candidate(1, "LIKELY_PLANET")), {
      firstView: true,
      userJudgment: "LIKELY_PLANET",
    }),
  );
  assert.equal(matched.kind, "matched");
  assert.equal(matched.title, "행성 신호를 찾았습니다");
  assert.deepEqual(
    matched.chips.map((chip) => chip.label),
    ["신호 일치", "판단 일치", "성과 인정", "새 별 1개"],
  );

  const numeric = inlineResult(
    outcomeFromReceipt(receipt(candidate(null, "LIKELY_PLANET")), {
      firstView: true,
      userJudgment: "LIKELY_PLANET",
    }),
  );
  assert.equal(numeric.kind, "numericMismatch");
  assert.equal(numeric.tone, "bad");
  // The eyebrow says 신호 불일치; no chip repeats it.
  assert.equal(numeric.eyebrow, "신호 불일치");
  assert.deepEqual(
    numeric.chips.map((chip) => chip.label),
    [],
  );

  const judgment = inlineResult(
    outcomeFromReceipt(receipt(candidate(1, "UNLIKELY_PLANET")), {
      firstView: true,
      userJudgment: "UNLIKELY_PLANET",
    }),
  );
  assert.equal(judgment.kind, "judgmentMismatch");
  assert.equal(judgment.title, "구간은 맞았고, 판단은 달랐습니다");
  assert.equal(judgment.eyebrow, "판단 불일치");
  assert.deepEqual(
    judgment.chips.map((chip) => [chip.label, chip.tone]),
    [
      ["신호 일치", "good"],
      ["성과 미인정", "warn"],
    ],
  );

  const fp = inlineResult(
    outcomeFromReceipt(receipt(candidate(3, "UNLIKELY_PLANET")), {
      firstView: true,
      userJudgment: "UNLIKELY_PLANET",
    }),
  );
  assert.equal(fp.title, "행성이 아닌 신호를 가려냈습니다");

  const unknown = inlineResult({
    kind: "unknown",
    matchStatus: "matched",
    evaluation: null,
    achievement: {
      result: "none",
      newlyRecognized: false,
      unlockedTicIds: [],
      starCount: 0,
      grade: null,
    },
    planet: null,
  });
  assert.equal(unknown.eyebrow, "접수");
  assert.match(unknown.title, /자세한 결과를 확인해 주세요/);
  assert.deepEqual(
    unknown.chips.map((chip) => chip.label),
    ["신호 일치"],
  );
});

test("depth never prints a negative zero", () => {
  assert.equal(format.depth(-0.0000004), "0.00");
  assert.equal(format.depth(0.00354), "0.35");
  assert.equal(format.depth(null), "—");
});

test("the judgment is read back only from a known stored value", () => {
  assert.equal(judgmentFromBody({ userJudgment: "UNSURE" }), "UNSURE");
  assert.equal(judgmentFromBody({ userJudgment: "MAYBE" }), null);
  assert.equal(judgmentFromBody({ submissionKind: "skipped" }), null);
  assert.equal(judgmentFromBody(null), null);
  assert.equal(judgmentFromBody(["LIKELY_PLANET"]), null);
});

test("every failed submission state keeps its recovery actions", () => {
  const options = { resendable: false, canPrepare: true };
  assert.equal(submissionView({ phase: "idle" }, options), null);
  const sending = submissionView(
    { phase: "sending", kind: "candidate" },
    options,
  )!;
  assert.equal(sending.busy, true);
  assert.match(sending.message, /두 번 접수되지 않습니다/);
  const lost = {
    phase: "settled" as const,
    kind: "candidate" as const,
    state: "unresolved" as const,
    requestId: randomUUID(),
    reason: "not-found" as const,
    message: "아직 접수 기록을 찾지 못했습니다.",
  };
  assert.deepEqual(submissionView(lost, options)!.actions, ["check"]);
  assert.deepEqual(
    submissionView(lost, { ...options, resendable: true })!.actions,
    ["check", "resend"],
  );
  assert.deepEqual(
    submissionView(
      {
        phase: "settled",
        kind: "candidate",
        state: "conflict",
        requestId: "r",
        message: "m",
      },
      options,
    )!.actions,
    ["check", "submitAsNew", "dismiss"],
  );
  assert.deepEqual(
    submissionView(
      {
        phase: "settled",
        kind: "candidate",
        state: "bundle-changed",
        currentBundleId: null,
      },
      options,
    )!.actions,
    ["reloadBundle", "dismiss"],
  );
  const notReady = submissionView(
    {
      phase: "settled",
      kind: "candidate",
      state: "context-not-ready",
      code: "SUBMISSION_CONTEXT_NOT_READY",
      message: "m",
      residual: { status: "QUEUED", jobId: "job-1", computedAt: null },
    },
    options,
  )!;
  assert.deepEqual(notReady.actions, ["prepare", "dismiss"]);
  assert.equal(notReady.note, "계산을 기다리는 중입니다. · 작업 번호 job-1");
  const rejected = submissionView(
    {
      phase: "settled",
      kind: "candidate",
      state: "rejected",
      code: "VALIDATION",
      message: "입력을 확인해 주세요.",
      fieldErrors: [
        { field: "selection.phaseEnd", reason: "빈 구간" },
        { field: "custom.path", reason: "x" },
      ],
    },
    options,
  )!;
  assert.deepEqual(
    rejected.fieldErrors.map((error) => error.label),
    ["구간 끝", "custom.path"],
  );
  assert.match(
    submissionView(
      { phase: "settled", kind: "candidate", state: "expired" },
      options,
    )!.message,
    /로그인이 만료되었습니다/,
  );
});
