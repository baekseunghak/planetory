import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidatePeaksFixture,
  periodContextFixture,
  periodogramFixture,
  PERIODOGRAM_FIXTURE_TICS,
} from "../../dev/periodogram-fixtures";
import { decodeAnalysisContext } from "../../src/features/analysis/analysis-data";
import {
  decodeCandidatePeaks,
  decodePeriodogram,
} from "../../src/features/analysis/periodogram-data";
import {
  choosePeriod,
  fineTunePeriod,
  periodChange,
  sliderPeriod,
  stepPeriod,
  type ReadyPeriodogram,
} from "../../src/features/analysis/period-selection";

const context = decodeAnalysisContext(
  periodContextFixture(),
  PERIODOGRAM_FIXTURE_TICS.normal,
);
const grid = decodePeriodogram(periodogramFixture(), context);
const candidates = decodeCandidatePeaks(candidatePeaksFixture(), context, grid);
const data: ReadyPeriodogram = {
  kind: "ready",
  selectionEnabled: true,
  periodogram: grid,
  candidates,
  rules: context.periodSelectionRules!,
};

test("peak selection retains server precision and source grid index rather than rank or nearest period", () => {
  const before = JSON.stringify(data),
    peak = candidates.peaks[0];
  const selection = choosePeriod(data, {
    kind: "peak",
    gridIndex: peak.gridIndex,
  });
  assert.equal(selection.sourcePeakGridIndex, 3600);
  assert.equal(selection.periodDays, peak.periodDays);
  assert.equal(selection.step, peak.fineTune.periodStepDays);
  assert.equal(selection.minimum, peak.fineTune.periodMinDays);
  assert.equal(selection.maximum, peak.fineTune.periodMaxDays);
  assert.throws(() =>
    choosePeriod(data, { kind: "peak", gridIndex: peak.rank }),
  );
  assert.equal(JSON.stringify(data), before);
});

test("direct selection preserves arbitrary float64 values and null source even exactly on a public peak", () => {
  for (const period of [
    0.5,
    40,
    1.2345678901234567,
    candidates.peaks[0].periodDays,
  ]) {
    const selection = choosePeriod(data, {
      kind: "direct",
      periodDays: period,
    });
    assert.equal(selection.periodDays, period);
    assert.equal(selection.sourcePeakGridIndex, null);
    assert.ok(selection.minimum >= 0.5 && selection.maximum <= 40);
    assert.equal(selection.step, null);
    assert.throws(() => stepPeriod(selection, 1));
    assert.throws(() => sliderPeriod(selection, selection.periodDays));
    assert.throws(() => fineTunePeriod(selection, selection.periodDays));
  }
  for (const period of [
    NaN,
    Infinity,
    -Infinity,
    -1,
    0,
    0.499999999,
    40.000000001,
  ])
    assert.throws(() =>
      choosePeriod(data, { kind: "direct", periodDays: period }),
    );
});

test("fine tuning keeps original anchor and source and rejects out-of-range values without recentering", () => {
  const selection = choosePeriod(data, { kind: "peak", gridIndex: 2500 });
  const tuned = fineTunePeriod(selection, selection.minimum);
  assert.equal(tuned.anchorPeriodDays, selection.periodDays);
  assert.equal(tuned.sourcePeakGridIndex, 2500);
  assert.equal(tuned.minimum, selection.minimum);
  assert.equal(
    fineTunePeriod(tuned, selection.maximum).periodDays,
    selection.maximum,
  );
  for (const value of [
    NaN,
    Infinity,
    0,
    selection.minimum - 1e-12,
    selection.maximum + 1e-12,
  ])
    assert.throws(() => fineTunePeriod(tuned, value));
  assert.equal(tuned.periodDays, selection.minimum);
});

test("step and pointer adjustments use server increment, preserve both inclusive endpoints and never escape them", () => {
  const selection = choosePeriod(data, { kind: "peak", gridIndex: 1600 });
  assert.equal(
    stepPeriod(selection, 1),
    selection.periodDays + selection.step!,
  );
  assert.equal(
    sliderPeriod(selection, selection.periodDays),
    selection.periodDays,
  );
  assert.equal(sliderPeriod(selection, selection.minimum), selection.minimum);
  assert.equal(sliderPeriod(selection, selection.maximum), selection.maximum);
  let current = selection;
  for (let i = 0; i < 100; i++)
    current = fineTunePeriod(current, stepPeriod(current, 1));
  assert.equal(current.periodDays, selection.maximum);
  for (let i = 0; i < 100; i++)
    current = fineTunePeriod(current, stepPeriod(current, -1));
  assert.equal(current.periodDays, selection.minimum);
});

test("effective range intersects server peak limits with the full grid without rewriting server metadata", () => {
  const altered = structuredClone(data),
    peak = altered.candidates.peaks[0];
  peak.periodDays = 0.5;
  peak.fineTune = {
    periodMinDays: 0.49,
    periodMaxDays: 0.51,
    periodStepDays: 0.001,
  };
  const selection = choosePeriod(altered, {
    kind: "peak",
    gridIndex: peak.gridIndex,
  });
  assert.equal(selection.minimum, 0.5);
  assert.equal(peak.fineTune.periodMinDays, 0.49);
});

test("operation events retain full context, versions and monotonic revision even when reselecting the same number", () => {
  const selection = choosePeriod(data, { kind: "peak", gridIndex: 3600 });
  const first = periodChange(data, null, "reselect", selection);
  const second = periodChange(
    data,
    first,
    "fine-tune",
    fineTunePeriod(selection, stepPeriod(selection, 1)),
  );
  const third = periodChange(
    data,
    second,
    "reselect",
    choosePeriod(data, {
      kind: "direct",
      periodDays: second.selection.periodDays,
    }),
  );
  assert.deepEqual(
    [first.revision, second.revision, third.revision],
    [1, 2, 3],
  );
  assert.equal(second.kind, "fine-tune");
  assert.equal(second.selection.sourcePeakGridIndex, 3600);
  assert.equal(third.kind, "reselect");
  assert.equal(third.selection.sourcePeakGridIndex, null);
  assert.equal(third.context.bundleId, "9007199254741093");
  assert.deepEqual(third.context, grid.context);
  assert.equal(third.selectionRulesVersion, data.rules.version);
  assert.equal(third.peakRuleVersion, candidates.peakRuleVersion);
});
