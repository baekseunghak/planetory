import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidatePeaksFixture,
  periodogramFixture,
  periodContextFixture,
  periodCurveFixture,
  PERIODOGRAM_FIXTURE_TICS as tics,
} from "../../dev/periodogram-fixtures.ts";
import {
  decodeAnalysisContext,
  decodeCurve,
} from "../../src/features/analysis/analysis-data.ts";
import {
  decodePeriodogram,
  decodeCandidatePeaks,
  decodePendingPeriodogram,
  periodAt,
  periodogramPath,
  PeriodogramContextChanged,
} from "../../src/features/analysis/periodogram-data.ts";

const context = (tic: string = tics.normal) =>
  decodeAnalysisContext(periodContextFixture(tic), tic);
const grid = () => decodePeriodogram(periodogramFixture(), context());

test("5000 log periods preserve the full power array, exact endpoints, public peak source and matched ID", () => {
  const current = context(),
    data = grid(),
    peaks = decodeCandidatePeaks(candidatePeaksFixture(), current, data);
  assert.equal(data.power.length, 5000);
  assert.equal(periodAt(data, 0), 0.5);
  assert.equal(periodAt(data, 4999), 40);
  assert.ok(Math.abs(periodAt(data, 2500) - 0.5 * 80 ** (2500 / 4999)) < 1e-12);
  assert.deepEqual(data.power, periodogramFixture().power);
  assert.equal(data.baselineHalfDays, 3.5);
  assert.equal(peaks.peaks[0].gridIndex, 3600);
  assert.equal(peaks.peaks[0].rank, 1);
  assert.equal(
    peaks.peaks[0].periodDays,
    candidatePeaksFixture().peaks[0].periodDays,
  );
  assert.equal(peaks.matchedCandidates[0].candidateId, "9007199254741094");
  assert.deepEqual(current.periodSelectionRules, {
    version: "selection-synthetic-183-v1",
    halfWidthCells: 3,
  });
});
test("each part of CurveContext is checked on both responses; full removal-set identity matters", () => {
  for (const patch of [
    { bundleId: "wrong" },
    { residualModelVersion: "wrong" },
    { periodogramConfigVersion: "wrong" },
    { curveStep: 1, removedCandidateIds: ["other"] },
  ]) {
    const dto = periodogramFixture();
    Object.assign(dto.curveContext, patch);
    assert.throws(
      () => decodePeriodogram(dto, context()),
      PeriodogramContextChanged,
    );
    const peaks = candidatePeaksFixture();
    Object.assign(peaks.curveContext, patch);
    assert.throws(
      () => decodeCandidatePeaks(peaks, context(), grid()),
      PeriodogramContextChanged,
    );
  }
  const pending = context(tics.pending),
    dto = periodogramFixture(tics.pending);
  dto.curveContext.removedCandidateIds = ["different-same-count"];
  assert.throws(
    () => decodePeriodogram(dto, pending),
    PeriodogramContextChanged,
  );
});
test("empty/truncated power, unknown grid, nonfinite or null values and invalid bounds are rejected", () => {
  const original = periodogramFixture();
  for (const patch of [
    { power: [] },
    { power: original.power.slice(1) },
    { power: [null, ...original.power.slice(1)] },
    { power: [NaN, ...original.power.slice(1)] },
    { power: [Infinity, ...original.power.slice(1)] },
    { nPeriods: 1 },
    { nPeriods: 2.5 },
    { gridRule: "linear" },
    { periodMinDays: 0 },
    { periodMaxDays: 0.25 },
    { baselineHalfDays: 0 },
    { residual: { status: "PERIODOGRAM_CALCULATING" } },
  ])
    assert.throws(() =>
      decodePeriodogram({ ...original, ...patch }, context()),
    );
  // No invented power normalization limit or truncation at the observing boundary.
  assert.equal(
    decodePeriodogram(
      {
        ...original,
        power: original.power.map(() => 2.5),
        baselineHalfDays: 100,
      },
      context(),
    ).power[4999],
    2.5,
  );
});
test("peaks must refer to the same grid and valid server-provided fine tuning and suggestion values", () => {
  const original = candidatePeaksFixture(),
    peak = original.peaks[0];
  for (const patch of [
    { gridIndex: 5000 },
    { gridIndex: -1 },
    { gridIndex: 3.5 },
    { rank: 0 },
    { periodDays: peak.periodDays + 0.1 },
    { power: 0 },
    { suggestedDurationHours: 0 },
    { suggestedPhaseCenter: 1 },
    { fineTune: { ...peak.fineTune, periodStepDays: 0 } },
    { fineTune: { ...peak.fineTune, periodMinDays: peak.periodDays + 1 } },
    { fineTune: { ...peak.fineTune, periodStepDays: 20 } },
  ])
    assert.throws(() =>
      decodeCandidatePeaks(
        { ...original, peaks: [{ ...peak, ...patch }] },
        context(),
        grid(),
      ),
    );
  assert.throws(() =>
    decodeCandidatePeaks(
      { ...original, peaks: [peak, peak] },
      context(),
      grid(),
    ),
  );
  assert.throws(() =>
    decodeCandidatePeaks(
      { ...original, peaks: [{ ...peak, rank: 2 }, original.peaks[1]] },
      context(),
      grid(),
    ),
  );
  assert.throws(() =>
    decodeCandidatePeaks(
      { ...original, peakRuleVersion: "" },
      context(),
      grid(),
    ),
  );
  assert.throws(() =>
    decodeCandidatePeaks(
      {
        ...original,
        matchedCandidates: [
          { candidateId: 9007199254741094, periodDays: 3.25 },
        ],
      },
      context(),
      grid(),
    ),
  );
});
test("the frontend projects only permitted peak fields; no answer catalog is copied", () => {
  const original = candidatePeaksFixture();
  const result = decodeCandidatePeaks(
    {
      ...original,
      candidates: [{ name: "secret" }],
      peaks: original.peaks.map((peak) => ({
        ...peak,
        candidateId: "secret-id",
        name: "secret-name",
        isPlanet: true,
      })),
      matchedCandidates: [
        { ...original.matchedCandidates[0], name: "not-consumed" },
      ],
    },
    context(),
    grid(),
  );
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal("candidateId" in result.peaks[0], false);
  assert.equal("name" in result.matchedCandidates[0], false);
});
test("paths retain large string Bundle IDs and canonical removal set with no implicit step", () => {
  const current = context();
  current.curveContext = {
    ...current.curveContext,
    curveStep: 2,
    removedCandidateIds: ["b", "a"],
  };
  for (const resource of ["periodogram", "candidate-peaks"] as const) {
    const url = new URL(periodogramPath(current, resource), "http://test");
    assert.equal(url.pathname, `/v1/stars/${tics.normal}/${resource}`);
    assert.equal(url.searchParams.get("bundleId"), "9007199254741093");
    assert.equal(url.searchParams.get("removed"), "a,b");
    assert.equal(url.searchParams.get("curveStep"), "2");
  }
  assert.deepEqual(current.curveContext.removedCandidateIds, ["b", "a"]);
});
test("pending residual is unavailable, preserves real job identity and never fabricates a queued job", () => {
  const pending = {
    code: "CURVE_NOT_READY",
    segments: null,
    residual: { status: null, jobId: null },
  };
  assert.deepEqual(decodePendingPeriodogram(pending, context(tics.pending)), {
    status: null,
    jobId: null,
  });
  assert.throws(() => decodePendingPeriodogram(pending, context()));
  assert.throws(() =>
    decodePendingPeriodogram(
      { ...pending, residual: { status: "QUEUED", jobId: null } },
      context(tics.pending),
    ),
  );
  assert.deepEqual(
    decodePendingPeriodogram(
      {
        ...pending,
        residual: {
          status: "PERIODOGRAM_CALCULATING",
          jobId: "9007199254741999",
        },
      },
      context(tics.pending),
    ),
    { status: "PERIODOGRAM_CALCULATING", jobId: "9007199254741999" },
  );
});
test("missing rules are kept absent for legacy observations, but malformed supplied rules are rejected", () => {
  const dto = periodContextFixture();
  assert.equal(
    decodeAnalysisContext({ ...dto, selectionRules: undefined }, tics.normal)
      .periodSelectionRules,
    undefined,
  );
  for (const fineTune of [{ halfWidthCells: 0 }, { halfWidthCells: 1.2 }, {}])
    assert.throws(() =>
      decodeAnalysisContext(
        { ...dto, selectionRules: { ...dto.selectionRules, fineTune } },
        tics.normal,
      ),
    );
  assert.equal(decodeCurve(periodCurveFixture(), context()).kind, "ready");
});
