import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisContextFixture,
  analysisCurveFixture,
} from "../../dev/analysis-fixtures";
import {
  decodeAnalysisContext,
  decodeCurve,
} from "../../src/features/analysis/analysis-data";
import {
  buildFoldData,
  foldTimes,
} from "../../src/features/analysis/fold-data";
import { createFoldProcessor } from "../../src/features/analysis/fold-worker-core";
import { buildTimeCurve } from "../../src/features/analysis/time-curve";

function sample() {
  const raw = analysisContextFixture();
  const context = decodeAnalysisContext(raw, raw.ticId);
  const curve = decodeCurve(analysisCurveFixture(), context, 200);
  if (curve.kind !== "ready") throw new Error("expected ready");
  return { context, curve };
}

test("10-minute Gold centers match the model's 9–63 minute window without changing storage times", () => {
  const { context, curve } = sample();
  curve.segments = [
    {
      ...curve.segments[0],
      startBtjd: 0 as (typeof curve.segments)[0]["startBtjd"],
      binMinutes: 10,
      nPoints: 12,
      flux: Array(12).fill(1),
      gaps: [],
    },
  ];
  const folded = buildFoldData(context, curve),
    time = buildTimeCurve(curve.segments);
  assert.deepEqual(
    folded.points
      .filter((p) => p.btjd * 1440 >= 9 && p.btjd * 1440 <= 63)
      .map((p) => p.index),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    [...folded.times],
    time.points.map((p) => p.btjd),
  );
  assert.equal(curve.segments[0].startBtjd, 0);
  assert.equal(JSON.parse(folded.dataId)[0], "gold-bin-center-v1");
});

test("fold input preserves every valid bin, original indices, flux and multi-Sector actual times", () => {
  const { context, curve } = sample();
  const original = structuredClone(curve);
  const data = buildFoldData(context, curve);
  assert.equal(data.points.length, 11);
  assert.equal(data.reference, context.foldReferenceTimeBtjd);
  assert.deepEqual(
    data.points.map((p) => p.index),
    [0, 1, 4, 5, 6, 7, 0, 2, 3, 4, 5],
  );
  assert.equal(data.times[1], 1683.35 + 15 / 1440);
  assert.equal(data.times[7], 2419.99 + 50 / 1440);
  assert.ok(data.times.at(-1)! - data.times[0] > 700);
  for (const point of data.points) {
    const source = curve.segments.find((s) => s.segmentId === point.segmentId)!;
    assert.equal(point.flux, source.flux[point.index]);
    assert.equal(point.sector, source.sector);
  }
  assert.deepEqual(curve, original);
  curve.segments[0].flux[0] = 0;
  assert.notEqual(data.points[0].flux, 0);
});

test("zero flux is an observation; all-null data is empty, not a successful fold", () => {
  const { context, curve } = sample();
  curve.segments[0].flux[0] = 0;
  assert.equal(buildFoldData(context, curve).points[0].flux, 0);
  for (const segment of curve.segments) segment.flux.fill(null);
  const empty = buildFoldData(context, curve);
  assert.equal(empty.points.length, 0);
  assert.throws(() => foldTimes(empty.times, empty.reference, 2), /관측 시각/);
});

test("fold input rejects mismatched/not-ready curves and invalid numeric bins", () => {
  const { context, curve } = sample();
  assert.throws(
    () =>
      buildFoldData(context, { kind: "not-ready", status: null, jobId: null }),
    /준비/,
  );
  assert.throws(
    () =>
      buildFoldData(context, {
        ...curve,
        context: { ...curve.context, bundleId: "other" },
      }),
    /일치/,
  );
  for (const value of [NaN, Infinity, -Infinity]) {
    const altered = structuredClone(curve);
    altered.segments[0].flux[0] = value;
    assert.throws(() => buildFoldData(context, altered), /유한/);
  }
  curve.segments[0].flux.pop();
  assert.throws(() => buildFoldData(context, curve), /길이/);
});

test("fold identity distinguishes TIC, reference, Bundle, residual step and segment revision", () => {
  const { context, curve } = sample();
  const key = buildFoldData(context, curve).dataId;
  assert.notEqual(
    buildFoldData({ ...context, ticId: "another-star" }, curve).dataId,
    key,
  );
  assert.notEqual(
    buildFoldData(
      {
        ...context,
        foldReferenceTimeBtjd: (context.foldReferenceTimeBtjd +
          1) as typeof context.foldReferenceTimeBtjd,
      },
      curve,
    ).dataId,
    key,
  );
  for (const change of [
    { bundleId: "new" },
    { curveStep: 1, removedCandidateIds: ["candidate-1"] },
    { residualModelVersion: "v2" },
  ]) {
    const curveContext = { ...curve.context, ...change };
    assert.notEqual(
      buildFoldData(
        { ...context, curveContext },
        { ...curve, context: curveContext },
      ).dataId,
      key,
    );
  }
  curve.segments[0].binningRevision = "10m-v2";
  assert.notEqual(buildFoldData(context, curve).dataId, key);
});

test("phase arithmetic uses the original period and preserves negative-time and exact boundaries", () => {
  assert.deepEqual(
    Array.from(
      foldTimes([95, 96, 97, 98, 99, 100, 101, 102, 103, 104], 100, 4),
    ),
    [0.75, 0, 0.25, 0.5, 0.75, 0, 0.25, 0.5, 0.75, 0],
  );
  const phases = foldTimes(
    [-Number.MIN_VALUE, -0, 0, Number.MIN_VALUE, 1 - Number.EPSILON],
    0,
    1,
  );
  assert.equal(phases[0], 0);
  assert.equal(Object.is(phases[1], -0), false);
  assert.equal(phases[3], Number.MIN_VALUE);
  assert.equal(phases[4], 1 - Number.EPSILON);
  assert.notDeepEqual(foldTimes([101], 100, 4), foldTimes([101], 100, 8));
});

test("invalid periods, times, references, overflow and unsafe cycle counts fail explicitly", () => {
  for (const period of [0, -1, NaN, Infinity, -Infinity])
    assert.throws(() => foldTimes([100], 100, period));
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => foldTimes([bad], 100, 4));
    assert.throws(() => foldTimes([100], bad, 4));
  }
  assert.throws(() => foldTimes([Number.MAX_VALUE], -Number.MAX_VALUE, 1));
  assert.throws(() => foldTimes([1], 0, Number.MIN_VALUE));
  assert.throws(() => foldTimes([Number.MAX_SAFE_INTEGER + 1], 0, 1));
});

test("large inputs are neither sampled nor sorted and retain original result order", () => {
  const times = Float64Array.from(
    { length: 100_000 },
    (_, i) => 100 + (i % 100) / 4,
  );
  const result = foldTimes(times, 100, 4);
  assert.equal(result.length, times.length);
  for (let i = 0; i < result.length; i++)
    assert.equal(result[i], ((i % 100) % 16) / 16);
});

test("Worker processor reuses initialized times and rejects wrong context/revision", () => {
  const process = createFoldProcessor();
  const fold = { type: "fold" as const, dataId: "A", revision: 1, period: 4 };
  assert.equal(process(fold).type, "fold-error");
  assert.equal(
    process({
      type: "init",
      dataId: "A",
      reference: 100,
      times: new Float64Array([99, 100, 101]),
    }).type,
    "ready",
  );
  assert.deepEqual(process(fold), {
    type: "folded",
    dataId: "A",
    revision: 1,
    phases: new Float64Array([0.75, 0, 0.25]),
  });
  assert.deepEqual(process({ ...fold, revision: 2, period: 2 }), {
    type: "folded",
    dataId: "A",
    revision: 2,
    phases: new Float64Array([0.5, 0, 0.5]),
  });
  assert.equal(process({ ...fold, dataId: "B" }).type, "fold-error");
  assert.equal(process({ ...fold, revision: 0 }).type, "fold-error");
  assert.equal(process({ ...fold, period: 0 }).type, "fold-error");
});

test("failed Worker reinitialization invalidates the old cached curve", () => {
  const process = createFoldProcessor();
  process({
    type: "init",
    dataId: "A",
    reference: 100,
    times: new Float64Array([100]),
  });
  assert.equal(
    process({
      type: "init",
      dataId: "B",
      reference: 0,
      times: new Float64Array([NaN]),
    }).type,
    "init-error",
  );
  assert.equal(
    process({ type: "fold", dataId: "A", revision: 1, period: 2 }).type,
    "fold-error",
  );
});
