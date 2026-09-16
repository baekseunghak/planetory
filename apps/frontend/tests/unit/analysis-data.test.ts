import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisContextFixture,
  analysisCurveFixture,
  analysisFixtureResponse,
  ANALYSIS_FIXTURE_BUNDLE,
  ANALYSIS_FIXTURE_TICS,
} from "../../dev/analysis-fixtures";
import {
  contextKey,
  curvePath,
  decodeAnalysisContext,
  decodeCurve,
} from "../../src/features/analysis/analysis-data";

const context = () =>
  decodeAnalysisContext(analysisContextFixture(), ANALYSIS_FIXTURE_TICS.normal);

test("analysis preserves large string IDs, full segment arrays, null gaps and scalar scatter", () => {
  const current = context();
  const curve = decodeCurve(analysisCurveFixture(), current);
  assert.equal(current.curveContext.bundleId, "9007199254740993");
  assert.equal(current.foldReferenceTimeBtjd, 1683.4231);
  assert.equal(curve.kind, "ready");
  if (curve.kind !== "ready") throw new Error("expected ready");
  assert.deepEqual(
    curve.segments.map((segment) => segment.nPoints),
    [8, 6],
  );
  assert.deepEqual(
    curve.segments.map((segment) => segment.binMinutes),
    [10, 20],
  );
  assert.deepEqual(curve.segments[0].flux, [
    1,
    1.0001,
    null,
    null,
    0.9998,
    1.0002,
    1,
    1.0001,
  ]);
  assert.deepEqual(curve.segments[0].gaps, [[2, 3]]);
  assert.equal(curve.segments[0].fluxScatter, 0.0012);
  assert.equal(curve.segments[1].segmentId, "9007199254740996");
});
test("analysis rejects malformed context instead of inventing a current Bundle or permissions", () => {
  const original = analysisContextFixture();
  for (const value of [
    null,
    {},
    { ...original, ticId: 259377017 },
    { ...original, ticId: "another-star" },
    { ...original, hasConfirmedCandidate: undefined },
    { ...original, bundle: { ...original.bundle, bundleId: 9007199254740993 } },
    {
      ...original,
      bundle: { ...original.bundle, residualModelVersion: "different" },
    },
    { ...original, star: { ...original.star, sectorCount: 3 } },
  ])
    assert.throws(() => decodeAnalysisContext(value, original.ticId));
  const parsed = decodeAnalysisContext(
    { ...original, secretCandidate: { name: "hidden" } },
    original.ticId,
  );
  assert.equal("secretCandidate" in parsed, false);
});
test("curve decoder rejects mismatched TIC, Bundle, removal set, version and common reference time", () => {
  const original = analysisCurveFixture();
  for (const value of [
    { ...original, ticId: "wrong" },
    { ...original, bundleId: "wrong" },
    { ...original, foldReferenceTimeBtjd: original.foldReferenceTimeBtjd + 1 },
    {
      ...original,
      curveContext: {
        ...original.curveContext,
        periodogramConfigVersion: "wrong",
      },
    },
    {
      ...original,
      curveContext: {
        ...original.curveContext,
        curveStep: 1,
        removedCandidateIds: ["matched"],
      },
    },
    { ...original, residual: { status: "RESIDUAL_READY", jobId: "job" } },
  ])
    assert.throws(() => decodeCurve(value, context()));
});
test("curve decoder rejects truncated arrays, invalid numbers and gaps that contain observed flux", () => {
  const original = analysisCurveFixture(),
    segment = original.segments[0];
  for (const changed of [
    { ...segment, nPoints: 9 },
    { ...segment, binMinutes: 0 },
    { ...segment, fluxScatter: -1 },
    { ...segment, startBtjd: Infinity },
    { ...segment, flux: [NaN, ...segment.flux.slice(1)] },
    { ...segment, flux: ["1", ...segment.flux.slice(1)] },
    { ...segment, gaps: [[2, 8]] },
    { ...segment, gaps: [[3, 2]] },
    { ...segment, gaps: [[0, 1]] },
  ])
    assert.throws(() =>
      decodeCurve({ ...original, segments: [changed] }, context()),
    );
  assert.throws(() =>
    decodeCurve({ ...original, segments: [segment, segment] }, context()),
  );
});
test("curve identity includes sorted removal IDs and both calculation versions", () => {
  const a = {
    ...context().curveContext,
    curveStep: 2,
    removedCandidateIds: ["b", "a"],
  };
  assert.equal(
    contextKey(a),
    contextKey({ ...a, removedCandidateIds: ["a", "b"] }),
  );
  assert.notEqual(
    contextKey(a),
    contextKey({ ...a, removedCandidateIds: ["a", "c"] }),
  );
  assert.notEqual(
    contextKey(a),
    contextKey({ ...a, residualModelVersion: "next" }),
  );
  const url = new URL(
    curvePath({ ...context(), curveContext: a }),
    "http://localhost",
  );
  assert.equal(url.searchParams.get("bundleId"), ANALYSIS_FIXTURE_BUNDLE);
  assert.equal(url.searchParams.get("curveStep"), "2");
  assert.equal(
    new URL(curvePath(context()), "http://localhost").searchParams.has(
      "removed",
    ),
    false,
  );
});
test("not-computed residual remains unavailable rather than an empty success or fake queued job", () => {
  const ticId = ANALYSIS_FIXTURE_TICS.notComputed;
  const current = decodeAnalysisContext(analysisContextFixture(ticId), ticId);
  const body = {
    code: "CURVE_NOT_READY",
    segments: null,
    residual: { status: null, jobId: null },
  };
  assert.deepEqual(decodeCurve(body, current), {
    kind: "not-ready",
    status: null,
    jobId: null,
  });
  assert.throws(() => decodeCurve(body, context()));
  assert.throws(() =>
    decodeCurve(
      { ...body, residual: { status: "QUEUED", jobId: null } },
      current,
    ),
  );
  assert.throws(() => decodeCurve({ ...body, code: undefined }, current));
});
test("synthetic responses use the real query shape and never provide an answer catalog", () => {
  const response = analysisFixtureResponse(
    new URL(curvePath(context()), "http://fixture.invalid"),
  );
  assert.equal(response?.status, 200);
  const dto = analysisContextFixture();
  assert.equal("candidates" in dto, false);
  assert.equal("planetCount" in dto, false);
  assert.equal("planetNames" in dto, false);
  assert.equal(
    analysisFixtureResponse(
      new URL(
        "/v1/stars/259377017/curves?bundleId=old&curveStep=0",
        "http://fixture.invalid",
      ),
    )?.status,
    409,
  );
  assert.equal(
    analysisFixtureResponse(
      new URL("/v1/members/member", "http://fixture.invalid"),
    ),
    null,
  );
});
