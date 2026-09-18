import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOLD_SAMPLE,
  periodContextFixture,
  periodCurveFixture,
  candidatePeaksFixture,
} from "../../dev/periodogram-fixtures";
import {
  decodeAnalysisContext,
  decodeCurve,
} from "../../src/features/analysis/analysis-data";
import {
  buildFoldData,
  foldTimes,
} from "../../src/features/analysis/fold-data";

test("synthetic transit sample is deterministic and matches its time bounds, cadence and recommended period", () => {
  const context = periodContextFixture(),
    curve = periodCurveFixture(),
    peak = candidatePeaksFixture().peaks[0];
  assert.deepEqual(periodCurveFixture(), curve);
  assert.equal(peak.periodDays, FOLD_SAMPLE.periodDays);
  assert.equal(peak.suggestedPhaseCenter, 0);
  assert.equal(peak.suggestedDurationHours, FOLD_SAMPLE.durationHours);
  const segment = curve.segments[0];
  assert.equal(segment.flux.length, FOLD_SAMPLE.nPoints);
  assert.equal(
    segment.startBtjd + ((segment.nPoints - 1) * segment.binMinutes) / 1440,
    context.bundle.observationBounds[1],
  );
  assert.equal(
    context.bundle.foldReferenceTimeBtjd,
    (context.bundle.observationBounds[0] +
      context.bundle.observationBounds[1]) /
      2,
  );
  assert.ok(
    segment.flux.every(
      (value) =>
        value !== null &&
        value >= 1 - FOLD_SAMPLE.depth - FOLD_SAMPLE.noiseAmplitude &&
        value <= 1 + FOLD_SAMPLE.noiseAmplitude,
    ),
  );
});

test("at least ten separate transits align at the injected period and spread at both fine-tune limits", () => {
  const raw = periodContextFixture();
  const context = decodeAnalysisContext(raw, raw.ticId);
  const data = buildFoldData(
    context,
    decodeCurve(periodCurveFixture(), context, 200),
  );
  const peak = candidatePeaksFixture().peaks[0];
  const transits = data.points
    .map((point, i) => ({ point, i }))
    .filter(({ point }) => point.flux < 1 - FOLD_SAMPLE.depth * 0.8);
  const cycles = new Set(
    transits.map(({ point }) =>
      Math.round((point.btjd - data.reference) / peak.periodDays),
    ),
  );
  assert.ok(cycles.size >= 10, `only ${cycles.size} distinct transits`);
  function width(period: number) {
    const phases = foldTimes(data.times, data.reference, period);
    const centers = transits.map(({ i }) =>
      phases[i] >= 0.5 ? phases[i] - 1 : phases[i],
    );
    return Math.max(...centers) - Math.min(...centers);
  }
  const correct = width(peak.periodDays);
  assert.ok(
    correct > 0 && correct < FOLD_SAMPLE.durationHours / 24 / peak.periodDays,
  );
  for (const wrong of [
    peak.fineTune.periodMinDays,
    peak.fineTune.periodMaxDays,
  ])
    assert.ok(
      width(wrong) > correct * 4,
      `expected smearing beyond ${correct * 4}, got ${width(wrong)}`,
    );
});
