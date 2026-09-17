import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisContextFixture,
  analysisCurveFixture,
} from "../../dev/analysis-fixtures.ts";
import {
  decodeAnalysisContext,
  decodeCurve,
  type CurveSegment,
} from "../../src/features/analysis/analysis-data.ts";
import { buildTimeCurve } from "../../src/features/analysis/time-curve.ts";
import { projectTransitBands } from "../../src/features/analysis/transit-bands.ts";

function segment(startBtjd: number, binMinutes = 1440): CurveSegment {
  const raw = analysisContextFixture();
  const curve = decodeCurve(
    analysisCurveFixture(),
    decodeAnalysisContext(raw, raw.ticId),
  );
  if (curve.kind !== "ready") throw new Error("expected ready");
  return {
    ...curve.segments[0],
    segmentId: String(startBtjd),
    startBtjd: startBtjd as CurveSegment["startBtjd"],
    binMinutes,
    nPoints: 4,
    flux: [1, null, 1, 1],
  };
}
test("expected centers align with BTJD bin centers across compressed gaps and different cadences", () => {
  const curve = buildTimeCurve([segment(100), segment(1100, 720)]);
  const bands = projectTransitBands(
    curve,
    { periodDays: 2, epochPreviewBtjd: 100, durationPreviewDays: 0.5 },
    0,
    curve.width,
  );
  assert.deepEqual(
    bands.map((b) => b.centerBtjd),
    [100, 102, 1100],
  );
  assert.deepEqual(
    bands.map((b) => b.cycle),
    [0, 1, 500],
  );
  for (const band of bands) {
    const part = curve.segments.find(
      (s) => s.source.segmentId === band.segmentId,
    )!;
    const point = curve.points.find((p) => p.btjd === band.centerBtjd)!;
    assert.ok(Math.abs((band.xStart + band.xEnd) / 2 - point.x) < 1e-10);
    assert.ok(band.xStart >= part.start && band.xEnd <= part.end);
  }
  assert.equal(curve.points.length, 6);
});
test("visible clipping uses actual time and does not enumerate centuries of hidden Sector gaps", () => {
  const curve = buildTimeCurve([segment(100), segment(1_000_100)]);
  const second = curve.segments[1];
  const bands = projectTransitBands(
    curve,
    { periodDays: 2, epochPreviewBtjd: 100, durationPreviewDays: 1 },
    second.start + 0.5,
    second.start + 0.75,
  );
  assert.equal(bands.length, 1);
  assert.equal(bands[0].cycle, 500000);
  assert.equal(bands[0].startBtjd, 1_000_100);
  assert.equal(bands[0].endBtjd, 1_000_100.25);
  assert.ok(Math.abs(bands[0].xStart - (second.start + 0.5)) < 1e-9);
  assert.ok(Math.abs(bands[0].xEnd - (second.start + 0.75)) < 1e-9);
});
test("predictions may cross null bins without adding observations; segment separators stay empty", () => {
  const curve = buildTimeCurve([segment(100), segment(200)]);
  const pointsBefore = curve.points.slice();
  const bands = projectTransitBands(
    curve,
    { periodDays: 2, epochPreviewBtjd: 101, durationPreviewDays: 0.5 },
    0,
    curve.width,
  );
  assert.equal(bands[0].centerBtjd, 101);
  assert.equal(bands[0].xStart, 1.25);
  assert.equal(bands[0].xEnd, 1.75);
  assert.deepEqual(curve.points, pointsBefore);
  assert.deepEqual(
    projectTransitBands(
      curve,
      { periodDays: 2, epochPreviewBtjd: 101, durationPreviewDays: 0.5 },
      curve.segments[0].end,
      curve.segments[1].start,
    ),
    [],
  );
});
test("segment edges clip partial windows and viewports without transit centers return no bands", () => {
  const curve = buildTimeCurve([segment(100)]);
  const window = {
    periodDays: 2,
    epochPreviewBtjd: 99.5,
    durationPreviewDays: 0.5,
  };
  assert.equal(projectTransitBands(curve, window, 0, curve.width)[0].xStart, 0);
  assert.deepEqual(projectTransitBands(curve, window, 0.5, 1), []);
});
test("invalid windows and unsafe cycle indices fail explicitly", () => {
  const curve = buildTimeCurve([segment(100)]);
  for (const periodDays of [0, -1, NaN, Infinity, 1e-30])
    assert.throws(() =>
      projectTransitBands(
        curve,
        {
          periodDays,
          epochPreviewBtjd: 0,
          durationPreviewDays: Math.abs(periodDays) / 2,
        },
        0,
        curve.width,
      ),
    );
  assert.throws(() =>
    projectTransitBands(
      curve,
      { periodDays: 1, epochPreviewBtjd: 100, durationPreviewDays: 1 },
      0,
      curve.width,
    ),
  );
});
