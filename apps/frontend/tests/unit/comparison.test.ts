import { test } from "node:test";
import assert from "node:assert/strict";
import { readComparison } from "../../src/features/statistics/comparison";
import { comparisonFixture } from "../fixtures/comparison";
test("preserves source observation and cutoff separately, zero median and absent historical mine", () => {
  const c = readComparison(comparisonFixture());
  assert.notEqual(c.asOf, c.sourceObservedAt);
  assert.equal(c.metrics[2].median, 0);
  assert.equal(c.metrics[0].myValue.value, null);
  assert.equal(c.metrics[0].myValue.reason, "HISTORICAL_SOURCE_UNAVAILABLE");
  assert.equal(c.inCohort, null);
});
test("equivalent fractional-second formatting preserves source strings", () => {
  for (const field of ["asOf", "cohortEnd"] as const) {
    const f = comparisonFixture();
    f[field] = "2026-09-21T15:00:00.000Z";
    const c = readComparison(f);
    assert.equal(c.asOf, f.asOf);
    assert.equal(c.cohortEnd, f.cohortEnd);
  }
});
test("different cutoff instants remain invalid", () => {
  for (const field of ["asOf", "cohortEnd"] as const) {
    const f = comparisonFixture();
    f[field] = "2026-09-21T15:00:00.001Z";
    assert.throws(() => readComparison(f));
  }
});
test("unavailable retains null dates and samples", () => {
  const c = readComparison(comparisonFixture(true));
  assert.equal(c.asOf, null);
  assert.equal(c.cohortMemberCount, null);
  assert.equal(c.metrics[0].median, null);
});
test("stale retains successful dates, new members and no sample remain distinct", () => {
  const f = comparisonFixture();
  f.status = "STALE";
  f.inCohort = false;
  f.metrics.firstMatchAccuracy.myValue.status = "NOT_APPLICABLE";
  f.metrics.firstMatchAccuracy.myValue.reason = "JOINED_AFTER_CUTOFF";
  f.metrics.firstMatchAccuracy.median = null;
  f.metrics.firstMatchAccuracy.sampleCount = 0;
  f.metrics.firstMatchAccuracy.status = "NO_SAMPLE";
  f.metrics.firstMatchAccuracy.reason = "ZERO_DENOMINATOR";
  const c = readComparison(f);
  assert.equal(c.status, "STALE");
  assert.equal(c.snapshotDate, f.snapshotDate);
  assert.equal(c.metrics[0].myValue.status, "NOT_APPLICABLE");
  assert.equal(c.metrics[0].sampleCount, 0);
});
test("rejects inconsistent temporal or sample contracts", () => {
  for (const patch of [
    { cohortEnd: "2026-09-22T15:00:00Z" },
    { snapshotDate: "2026-02-30" },
    { cohortStart: "2026-06-22T15:00:00Z" },
    { cohortMemberCount: 7 },
    { status: "OTHER" },
  ])
    assert.throws(() => readComparison({ ...comparisonFixture(), ...patch }));
  const f = comparisonFixture();
  f.metrics.firstMatchAccuracy.median = 101;
  assert.throws(() => readComparison(f));
  delete f.metrics.firstMatchAccuracy;
  assert.throws(() => readComparison(f));
});
