import { test } from "node:test";
import assert from "node:assert/strict";
import { readGlobalStatistics } from "../../src/features/statistics/global-contracts";
import { readMetric } from "../../src/features/statistics/contracts";
import {
  globalStatisticsFixture,
  unavailableGlobalStatistics,
} from "../fixtures/global-statistics";

test("global transport preserves values, AI exception and string identifiers independently from comparison", () => {
  const input = globalStatisticsFixture();
  input.policyVersion = "future-policy-id";
  const result = readGlobalStatistics(input);
  assert.equal(result.policyVersion, "future-policy-id");
  assert.equal(
    result.data?.metrics.aiAttemptUnknown.reason,
    "AI_ATTEMPT_UNKNOWN",
  );
  assert.equal(result.data?.metrics.aiAttemptUnknown.value, 15);
  assert.equal(result.data?.metrics.firstMatchAccuracy.value, (100 * 20) / 30);
  assert.equal(result.data?.challenges[0].roundId, "9007199254740993");
  assert.equal(result.data?.weeklySubmissions.length, 8);
  assert.throws(() => readMetric(input.global.data.metrics.aiAttemptUnknown));
});
test("stale retains the exact successful values and timestamps", () => {
  const input = globalStatisticsFixture();
  const ready = readGlobalStatistics(input);
  input.global.status = "STALE";
  input.global.reason = "REFRESH_DELAYED";
  const stale = readGlobalStatistics(input);
  assert.equal(stale.status, "STALE");
  assert.deepEqual(stale.data, ready.data);
  assert.equal(stale.asOf, ready.asOf);
  assert.equal(stale.generatedAt, ready.generatedAt);
});
test("empty counts are zero but ratios have no sample; unavailable has no values or clock", () => {
  const empty = readGlobalStatistics(globalStatisticsFixture(true));
  assert.equal(empty.data?.metrics.discoveredStars.value, 0);
  assert.equal(empty.data?.metrics.firstMatchAccuracy.value, null);
  assert.equal(empty.data?.metrics.firstMatchAccuracy.status, "NO_SAMPLE");
  const unavailable = readGlobalStatistics(unavailableGlobalStatistics());
  assert.equal(unavailable.data, null);
  assert.equal(unavailable.asOf, null);
});
test("unknown block states and contradictory empty or stale responses fail closed", () => {
  for (const patch of [
    { status: "UNKNOWN" },
    { status: "STALE", reason: null },
    { status: "UNAVAILABLE", reason: "AGGREGATE_NOT_READY" },
    { asOf: "invalid" },
  ]) {
    const f = globalStatisticsFixture();
    Object.assign(f.global, patch);
    assert.throws(() => readGlobalStatistics(f));
  }
});
test("invalid units, absent fields and fabricated AI data are rejected", () => {
  const cases = [
    (f: ReturnType<typeof globalStatisticsFixture>) => {
      f.global.data.metrics.discoveredStars.unit = "PERCENT";
    },
    (f: ReturnType<typeof globalStatisticsFixture>) => {
      f.global.data.metrics.aiAttemptUnknown.value = 99;
    },
    (f: ReturnType<typeof globalStatisticsFixture>) => {
      f.global.data.aiJudgmentBands.status = "AVAILABLE";
    },
    (f: ReturnType<typeof globalStatisticsFixture>) => {
      f.global.data.metrics.firstMatchAccuracy.denominator = 0;
    },
    (f: ReturnType<typeof globalStatisticsFixture>) => {
      f.global.data.weeklySubmissions[1].weekStart = "2026-02-30";
    },
    (f: ReturnType<typeof globalStatisticsFixture>) => {
      f.global.data.weeklySubmissions.pop();
    },
  ];
  for (const change of cases) {
    const f = globalStatisticsFixture();
    change(f);
    assert.throws(() => readGlobalStatistics(f));
  }
  const f = globalStatisticsFixture();
  assert.throws(() =>
    readGlobalStatistics({
      ...f,
      global: { ...f.global, data: { ...f.global.data, metrics: {} } },
    }),
  );
});
