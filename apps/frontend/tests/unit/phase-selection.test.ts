import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisContextFixture,
  analysisCurveFixture,
} from "../../dev/analysis-fixtures";
import {
  periodContextFixture,
  periodogramFixture,
  candidatePeaksFixture,
} from "../../dev/periodogram-fixtures";
import {
  decodeAnalysisContext,
  decodeCurve,
} from "../../src/features/analysis/analysis-data";
import {
  decodePeriodogram,
  decodeCandidatePeaks,
} from "../../src/features/analysis/periodogram-data";
import {
  choosePeriod,
  periodChange,
  type ReadyPeriodogram,
} from "../../src/features/analysis/period-selection";
import {
  readSelectionContract,
  SelectionInputError,
} from "../../src/features/analysis/selection-rules";
import {
  closestEpoch,
  getSelectionLimits,
  normalizePhaseRange,
  previewPhaseSelection,
  type PhaseSelectionResult,
} from "../../src/features/analysis/phase-selection";

// Existing synthetic API envelope; test overrides below are not production rules.
function sample(period = 2) {
  const raw = periodContextFixture();
  raw.bundle.foldReferenceTimeBtjd = 100;
  raw.bundle.observationBounds = [90, 110];
  const context = decodeAnalysisContext(raw, raw.ticId);
  const grid = decodePeriodogram(periodogramFixture(), context);
  const candidates = decodeCandidatePeaks(
    candidatePeaksFixture(),
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
  const change = periodChange(
    data,
    null,
    "reselect",
    choosePeriod(data, { kind: "direct", periodDays: period }),
  );
  return { raw, context, data, change };
}
function preview(result: PhaseSelectionResult) {
  assert.equal(result.kind, "preview", JSON.stringify(result));
  if (result.kind !== "preview") throw new Error("expected preview");
  return result;
}
function invalid(result: PhaseSelectionResult, code: string, field?: string) {
  assert.equal(result.kind, "invalid", JSON.stringify(result));
  if (result.kind !== "invalid") throw new Error("expected invalid");
  assert.equal(result.issues[0].code, code);
  if (field) assert.equal(result.issues[0].field, field);
}
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("selection metadata reads only public rules and independent observation bounds", () => {
  const { raw, context } = sample();
  assert.equal(context.selectionContract.kind, "ready");
  if (context.selectionContract.kind !== "ready")
    throw new Error("expected rules");
  assert.deepEqual(context.selectionContract.rules, {
    version: raw.selectionRules.version,
    minWindowDays: 20 / 1440,
    phaseWidthMax: 0.25,
    maxDurationMultipleOfSuggested: 3,
    allowEmptyPhaseSpan: false,
  });
  raw.bundle.observationBounds[0] = -100;
  assert.deepEqual(context.selectionContract.observationBounds, [90, 110]);
  assert.equal("fineTune" in context.selectionContract.rules, false);
});

test("missing selection rules or bounds never invent defaults or block existing curve decoding", () => {
  const raw = analysisContextFixture();
  for (const response of [
    { ...raw, selectionRules: undefined },
    { ...raw, bundle: { ...raw.bundle, observationBounds: undefined } },
    {
      ...raw,
      selectionRules: { ...raw.selectionRules, minWindowDays: undefined },
    },
  ]) {
    const context = decodeAnalysisContext(response, raw.ticId);
    assert.equal(context.selectionContract.kind, "unavailable");
    assert.equal(decodeCurve(analysisCurveFixture(), context).kind, "ready");
  }
});

test("invalid rule values remain unavailable with a specific field", () => {
  const raw = analysisContextFixture();
  const mutations: [string, unknown][] = [
    ["minWindowDays", 0],
    ["minWindowDays", -1],
    ["minWindowDays", NaN],
    ["minWindowDays", Infinity],
    ["minWindowDays", "0.01"],
    ["phaseWidthMax", 0],
    ["phaseWidthMax", 1.1],
    ["maxDurationMultipleOfSuggested", 0],
    ["maxDurationMultipleOfSuggested", Infinity],
    ["allowEmptyPhaseSpan", undefined],
    ["allowEmptyPhaseSpan", "false"],
    ["version", ""],
  ];
  for (const [field, value] of mutations) {
    const contract = readSelectionContract(
      { ...raw.selectionRules, [field]: value },
      raw.bundle.observationBounds,
    );
    assert.equal(contract.kind, "unavailable");
    if (contract.kind === "unavailable")
      assert.equal(contract.issues[0].field, `selectionRules.${field}`);
  }
  for (const bounds of [
    null,
    [],
    [1],
    [1, 2, 3],
    [2, 1],
    [NaN, 2],
    [0, Infinity],
    ["1", 2],
  ]) {
    const contract = readSelectionContract(raw.selectionRules, bounds);
    assert.equal(contract.kind, "unavailable");
    if (contract.kind === "unavailable")
      assert.equal(contract.issues[0].field, "bundle.observationBounds");
  }
});

test("phase normalization preserves boundary crossing and equivalent repeated intervals", () => {
  for (const [start, end] of [
    [0.95, 1.05],
    [-0.05, 0.05],
    [1.95, 2.05],
  ]) {
    const range = normalizePhaseRange(start, end);
    close(range.phaseStart, 0.95);
    close(range.phaseEnd, 1.05);
    assert.ok(range.phaseEnd > 1);
  }
  assert.deepEqual(
    normalizePhaseRange(-0.125, 0.125),
    normalizePhaseRange(0.875, 1.125),
  );
  assert.equal(Object.is(normalizePhaseRange(-0, 0.125).phaseStart, -0), false);
});

test("invalid, reversed or whole-cycle ranges fail without clamping", () => {
  for (const [start, end] of [
    [0, 0],
    [0.2, 0.1],
    [0, 1],
    [-0.5, 1.5],
    [NaN, 1],
    [0, Infinity],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1],
  ])
    assert.throws(() => normalizePhaseRange(start, end), SelectionInputError);
});

test("preview preserves source values, uses hours, and does not grant submission readiness", () => {
  const { context, data, change } = sample();
  const before = JSON.stringify({ context, data, change });
  const result = preview(
    previewPhaseSelection(context, data, change, 0.95, 1.05),
  );
  close(result.durationPreviewDays, 0.2);
  close(result.durationPreviewHours, 4.8);
  assert.equal(result.epochPreviewBtjd, 100);
  assert.equal(result.selection.periodDays, 2);
  assert.equal(result.selection.sourcePeakGridIndex, null);
  assert.deepEqual(result.pendingChecks, [
    "phase-coverage",
    "server-validation",
  ]);
  assert.equal("epochBtjd" in result.selection, false);
  assert.equal("durationHours" in result.selection, false);
  assert.equal(JSON.stringify({ context, data, change }), before);
});

test("minimum phase width follows current period rather than a fixed phase minimum", () => {
  const a = sample(1),
    b = sample(2);
  close(
    getSelectionLimits(a.context, a.data, a.change).minPhaseWidth,
    20 / 1440,
  );
  close(
    getSelectionLimits(b.context, b.data, b.change).minPhaseWidth,
    10 / 1440,
  );
  invalid(
    previewPhaseSelection(a.context, a.data, a.change, 0, 0.01),
    "DURATION_OUT_OF_RANGE",
  );
  preview(previewPhaseSelection(b.context, b.data, b.change, 0, 0.01));
});

test("exact binary minimum and maximum bounds are inclusive and never silently clamped", () => {
  const { raw, data, change } = sample();
  raw.selectionRules.minWindowDays = 0.125;
  const context = decodeAnalysisContext(raw, raw.ticId);
  for (const width of [0.0625, 0.25])
    preview(previewPhaseSelection(context, data, change, 0, width));
  for (const width of [0.0625 - 1e-10, 0.25 + 1e-10])
    invalid(
      previewPhaseSelection(context, data, change, 0, width),
      "DURATION_OUT_OF_RANGE",
      "selection.phaseEnd",
    );
});

test("overlapping peak ranges use only the chosen gridIndex, including a non-default multiplier", () => {
  const { raw, data, change } = sample();
  raw.selectionRules.maxDurationMultipleOfSuggested = 2;
  const context = decodeAnalysisContext(raw, raw.ticId);
  const [short, long] = data.candidates.peaks;
  for (const peak of [short, long])
    peak.fineTune = {
      periodMinDays: 1,
      periodMaxDays: 3,
      periodStepDays: 0.01,
    };
  short.suggestedDurationHours = 0.75;
  long.suggestedDurationHours = 6;
  change.selection.sourcePeakGridIndex = short.gridIndex;
  invalid(
    previewPhaseSelection(context, data, change, 0, 0.125),
    "DURATION_OUT_OF_RANGE",
  );
  close(getSelectionLimits(context, data, change).maxWindowDays, 1.5 / 24);
  change.selection.sourcePeakGridIndex = long.gridIndex;
  preview(previewPhaseSelection(context, data, change, 0, 0.125));
  change.selection.sourcePeakGridIndex = null;
  preview(previewPhaseSelection(context, data, change, 0, 0.25));
});

test("source null stays direct even at a recommended period; missing source never guesses", () => {
  const { context, data, change } = sample();
  change.selection.periodDays = data.candidates.peaks[0].periodDays;
  const direct = getSelectionLimits(context, data, change);
  assert.equal(
    direct.maxPhaseWidth,
    context.selectionContract.kind === "ready"
      ? context.selectionContract.rules.phaseWidthMax
      : 0,
  );
  for (const source of [-1, 1.5, 999999, data.candidates.peaks[0].rank]) {
    change.selection.sourcePeakGridIndex = source;
    invalid(
      previewPhaseSelection(context, data, change, 0, 0.125),
      "INVALID_PEAK_SOURCE",
      "selection.sourcePeakGridIndex",
    );
  }
  change.selection.sourcePeakGridIndex = data.candidates.peaks[0].gridIndex;
  change.selection.periodDays = 2;
  invalid(
    previewPhaseSelection(context, data, change, 0, 0.125),
    "INVALID_PEAK_SOURCE",
  );
});

test("current context and both rule versions must match", () => {
  for (const mutate of [
    (x: ReturnType<typeof sample>) => {
      x.change.context = { ...x.change.context, bundleId: "other" };
    },
    (x: ReturnType<typeof sample>) => {
      x.change.selectionRulesVersion = "old";
    },
    (x: ReturnType<typeof sample>) => {
      x.change.peakRuleVersion = "old";
    },
    (x: ReturnType<typeof sample>) => {
      x.data.rules = { ...x.data.rules, version: "old" };
    },
    (x: ReturnType<typeof sample>) => {
      x.data.candidates.context = {
        ...x.data.candidates.context,
        residualModelVersion: "old",
      };
    },
  ]) {
    const x = sample();
    mutate(x);
    invalid(
      previewPhaseSelection(x.context, x.data, x.change, 0, 0.125),
      "STALE_SELECTION",
      "curveContext",
    );
  }
});

test("no feasible width and missing metadata return distinct errors", () => {
  const { raw, data, change } = sample();
  raw.selectionRules.minWindowDays = 3;
  invalid(
    previewPhaseSelection(
      decodeAnalysisContext(raw, raw.ticId),
      data,
      change,
      0,
      0.125,
    ),
    "NO_VALID_SELECTION_WIDTH",
  );
  const missing = decodeAnalysisContext(
    { ...raw, bundle: { ...raw.bundle, observationBounds: undefined } },
    raw.ticId,
  );
  invalid(
    previewPhaseSelection(missing, data, change, 0, 0.125),
    "INVALID_OBSERVATION_BOUNDS",
  );
});

test("invalid periods and phase values cannot produce a preview", () => {
  for (const periodDays of [NaN, Infinity, -1, 0, 0.49, 41]) {
    const { context, data, change } = sample();
    change.selection.periodDays = periodDays;
    invalid(
      previewPhaseSelection(context, data, change, 0, 0.125),
      Number.isFinite(periodDays) ? "PERIOD_OUT_OF_RANGE" : "NON_FINITE",
      "selection.periodDays",
    );
  }
  const { context, data, change } = sample();
  invalid(
    previewPhaseSelection(context, data, change, NaN, 0.125),
    "NON_FINITE",
    "selection.phaseStart",
  );
});

test("epoch uses the nearest allowed cycle, prefers earlier ties and includes bounds", () => {
  assert.equal(closestEpoch(100, 2, 0.5, [90, 110]), 99);
  assert.equal(closestEpoch(100, 2, 0.5, [100, 110]), 101);
  assert.equal(closestEpoch(100, 2, 0.5, [103, 105]), 103);
  assert.equal(closestEpoch(100, 2, 0.5, [95, 97]), 97);
  assert.equal(closestEpoch(100, 2, 0.5, [99, 99]), 99);
  assert.equal(closestEpoch(100, 2, 0, [100, 100]), 100);
  assert.throws(
    () => closestEpoch(100, 2, 0.5, [99.1, 100.9]),
    (e: unknown) =>
      e instanceof SelectionInputError && e.issue.code === "EPOCH_OUT_OF_RANGE",
  );
});

test("epoch search agrees with enumerated cycles across deterministic ranges", () => {
  for (const reference of [-100, 0, 1683.4231])
    for (const period of [0.5, 2, 3.125])
      for (const center of [0, 0.125, 0.5, 0.95])
        for (const [start, end] of [
          [-5.1, -1.1],
          [-0.1, 0.1],
          [-2.2, 2.2],
          [1.1, 5.1],
        ]) {
          const bounds: [number, number] = [
            reference + start * period,
            reference + end * period,
          ];
          const candidates = Array.from(
            { length: 21 },
            (_, i) => reference + (center + i - 10) * period,
          )
            .filter((value) => value >= bounds[0] && value <= bounds[1])
            .sort(
              (a, b) =>
                Math.abs(a - reference) - Math.abs(b - reference) || a - b,
            );
          if (candidates.length)
            close(
              closestEpoch(reference, period, center, bounds),
              candidates[0],
            );
          else
            assert.throws(
              () => closestEpoch(reference, period, center, bounds),
              SelectionInputError,
            );
        }
});

test("out-of-observation epoch and unsafe numeric inputs are explicit errors", () => {
  const { raw, data, change } = sample();
  raw.bundle.observationBounds = [100.1, 100.2];
  invalid(
    previewPhaseSelection(
      decodeAnalysisContext(raw, raw.ticId),
      data,
      change,
      0.95,
      1.05,
    ),
    "EPOCH_OUT_OF_RANGE",
    "selection",
  );
  for (const args of [
    [NaN, 2, 0],
    [100, Infinity, 0],
    [100, 0, 0],
    [100, 2, 1],
    [100, 2, NaN],
    [100, Number.MIN_VALUE, 0],
  ])
    assert.throws(
      () => closestEpoch(args[0], args[1], args[2], [90, 110]),
      SelectionInputError,
    );
});
