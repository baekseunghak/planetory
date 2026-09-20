import assert from "node:assert/strict";
import { test } from "node:test";
import {
  convertObservation,
  type ObservationInput,
} from "../../dev/observation-data";
import { observationFixtureResponse } from "../../dev/observation-fixtures";

function source(): ObservationInput {
  const cadence = 10 / 1440;
  return {
    id: "cm-dra",
    tic_id: "199574208",
    bundle_id: "test-source",
    point_count: 4,
    sectors: [16],
    time_btjd: [0, cadence / 2, cadence * 3, cadence * 3.5],
    normalized_flux: [1, 3, 0, 2],
    point_source_index: [0, 0, 0, 0],
    fold_reference_time_btjd: 0.12345678901234567,
    observation_windows: [
      { source_index: 0, sector: 16, start_btjd: 0, end_btjd: cadence * 4 },
    ],
  };
}
test("10 minute means account for every point, preserve null gaps and reference without mutating export", () => {
  const input = source(),
    before = structuredClone(input);
  const result = convertObservation(input, "test-hash");
  const segment = result.curve.segments[0];
  assert.deepEqual(segment.flux, [2, null, null, 1, null]);
  assert.deepEqual(segment.gaps, [
    [1, 2],
    [4, 4],
  ]);
  assert.deepEqual(result.provenance.accounting[0].counts, [2, 0, 0, 2, 0]);
  assert.equal(
    result.context.bundle.foldReferenceTimeBtjd,
    input.fold_reference_time_btjd,
  );
  assert.deepEqual(input, before);
  assert.equal(result.curve.bundleId, result.context.bundle.bundleId);
  assert.notEqual(
    convertObservation(input, "other-hash").curve.bundleId,
    result.curve.bundleId,
  );
  assert(BigInt(result.curve.bundleId) < 2n ** 63n);
  assert(!("periodogram" in result.curve));
});
test("invalid source lengths, time, identity and sector membership fail before conversion", () => {
  for (const mutate of [
    (input: ObservationInput) => input.normalized_flux.pop(),
    (input: ObservationInput) => (input.time_btjd[1] = input.time_btjd[0]),
    (input: ObservationInput) => (input.time_btjd[1] = NaN),
    (input: ObservationInput) => (input.tic_id = "wrong"),
    (input: ObservationInput) => (input.point_source_index[0] = 7),
  ]) {
    const input = source();
    mutate(input);
    assert.throws(() => convertObservation(input, "hash"));
  }
});
test("missing actual-observation export returns 503, not a synthetic successful curve", async () => {
  const result = await observationFixtureResponse(
    new URL("http://test/v1/stars/259377017/analysis-context"),
    "missing-observation-directory",
  );
  assert.equal(result?.status, 503);
  assert.equal(result?.body.code, "OBSERVATION_DATA_UNAVAILABLE");
  assert.equal(
    await observationFixtureResponse(
      new URL("http://test/v1/stars/259377023/analysis-context"),
      "missing-observation-directory",
    ),
    null,
  );
});
