import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readPersonalStatistics,
  formatMetric,
  readMetric,
} from "../../src/features/statistics/contracts";
import { personalStatisticsFixture } from "../fixtures/personal-statistics";

test("policy identifier revisions preserve valid current metrics", () => {
  const fixture = personalStatisticsFixture();
  fixture.policyVersion = "2026-09-23";
  const result = readPersonalStatistics(fixture);
  assert.equal(result.policyVersion, fixture.policyVersion);
  assert.deepEqual(
    result.metrics,
    readPersonalStatistics(personalStatisticsFixture()).metrics,
  );
  fixture.policyVersion = "policy-next";
  assert.equal(readPersonalStatistics(fixture).policyVersion, "policy-next");
  fixture.current.metrics.firstMatchAccuracy.value = Number.NaN;
  assert.throws(() => readPersonalStatistics(fixture));
});
test("policy identifier must be a nonblank string", () => {
  for (const value of [undefined, null, 12, "", "   "]) {
    const fixture = { ...personalStatisticsFixture(), policyVersion: value };
    assert.throws(() => readPersonalStatistics(fixture));
  }
});
test("keeps server values, rounds only display, and ignores unavailable comparison", () => {
  const c = readPersonalStatistics(personalStatisticsFixture());
  assert.equal(c.metrics.evidencePerSubmission.value, 2 / 3);
  assert.equal(formatMetric(c.metrics.evidencePerSubmission), "0.7개/제출");
  assert.equal(formatMetric(c.metrics.retryRecognitionCount), "당시 기록 부족");
  assert.equal(c.evidence[0].excludedCount, 1);
});
test("zero counts and zero denominator have different meanings", () => {
  const c = readPersonalStatistics(personalStatisticsFixture(true));
  assert.equal(formatMetric(c.metrics.submissionCount), "0건");
  assert.equal(
    formatMetric(c.metrics.firstMatchAccuracy),
    "표본 없음 (분모 0)",
  );
  assert.equal(c.weeks.length, 8);
});
test("rejects broken week boundaries and duplicate evidence keys", () => {
  const f = personalStatisticsFixture();
  f.current.weeks[0].weekEnd = "2026-08-11";
  assert.throws(() => readPersonalStatistics(f));
  const g = personalStatisticsFixture();
  g.current.evidence[1].key = "oddeven";
  assert.throws(() => readPersonalStatistics(g));
});
test("invalid numeric states cannot become scientific zero", () => {
  assert.throws(() =>
    readMetric({
      unit: "PERCENT",
      value: 0,
      numerator: 0,
      denominator: 0,
      status: "NO_SAMPLE",
      reason: "ZERO_DENOMINATOR",
    }),
  );
  const f = personalStatisticsFixture();
  delete (f.current.metrics as Record<string, unknown>).activeDays;
  assert.throws(() => readPersonalStatistics(f));
});
