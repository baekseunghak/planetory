// Synthetic DTO fixture: service-api-spec 12.2.1, policy 2026-09-22,
// PersonalStatisticsService/StatisticsDtos at develop 02b734b9. No real account data.
import type { Metric } from "../../src/features/statistics/contracts";
const count = (unit: string, value: number): Metric => ({
  unit,
  value,
  numerator: value,
  denominator: null,
  status: "AVAILABLE",
  reason: null,
});
const ratio = (
  unit: string,
  numerator: number,
  denominator: number,
  value: number | null,
): Metric => ({
  unit,
  value,
  numerator,
  denominator,
  status: denominator ? "AVAILABLE" : "NO_SAMPLE",
  reason: denominator ? null : "ZERO_DENOMINATOR",
});
export function personalStatisticsFixture(empty = false) {
  const n = empty ? 0 : 3;
  const distribution = () =>
    Object.fromEntries(
      ["LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE"].map((k) => [
        k,
        ratio("PERCENT", empty ? 0 : 1, n, empty ? null : 33.333333333333336),
      ]),
    );
  return {
    policyVersion: "2026-09-22",
    timeZone: "Asia/Seoul",
    current: {
      status: "READY",
      asOf: "2026-09-22T02:00:00Z",
      generatedAt: "2026-09-22T02:00:01Z",
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: "2026-09-22T02:00:00Z",
      metrics: {
        discoveredStarCount: count("STARS", n),
        startedStarCount: count("STARS", empty ? 0 : 2),
        completedStarCount: count("STARS", empty ? 0 : 1),
        recognizedTotal: count("SIGNALS", n),
        submissionCount: count("SUBMISSIONS", n),
        activeDays: count("DAYS", n),
        retryRecognitionCount: empty
          ? count("SIGNALS", 0)
          : {
              unit: "SIGNALS",
              value: null,
              numerator: null,
              denominator: null,
              status: "UNAVAILABLE",
              reason: "MISSING_BASIS",
            },
        postCount: count("POSTS", 0),
        commentCount: count("COMMENTS", 0),
        unpublishedSignalCount: count("SIGNALS", empty ? 0 : 1),
        firstMatchAccuracy: ratio(
          "PERCENT",
          empty ? 0 : 1,
          empty ? 0 : 2,
          empty ? null : 50,
        ),
        submissionsPerStar: ratio(
          "SUBMISSIONS_PER_STAR",
          n,
          empty ? 0 : 2,
          empty ? null : 1.5,
        ),
        harmonicRecognitionRate: ratio("PERCENT", 0, n, empty ? null : 0),
        evidencePerSubmission: ratio(
          "CHECKS_PER_SUBMISSION",
          empty ? 0 : 2,
          n,
          empty ? null : 0.6666666666666666,
        ),
      },
      achievementByType: {
        confirmed: count("SIGNALS", n),
        unconfirmed: count("SIGNALS", 0),
        fp: count("SIGNALS", 0),
      },
      gradeDistribution: {
        A: count("STARS", empty ? 0 : 1),
        S: count("STARS", 0),
        SS: count("STARS", 0),
        SSS: count("STARS", 0),
      },
      judgmentDistribution: distribution(),
      judgmentAccuracy: {
        LIKELY_PLANET: ratio(
          "PERCENT",
          empty ? 0 : 1,
          empty ? 0 : 1,
          empty ? null : 100,
        ),
        UNLIKELY_PLANET: ratio("PERCENT", 0, empty ? 0 : 1, empty ? null : 0),
      },
      publicJudgmentDistribution: distribution(),
      weeks: Array.from({ length: 8 }, (_, i) => ({
        weekStart: new Date(Date.UTC(2026, 7, 3 + i * 7))
          .toISOString()
          .slice(0, 10),
        weekEnd: new Date(Date.UTC(2026, 7, 10 + i * 7))
          .toISOString()
          .slice(0, 10),
        partial: i === 7,
        submissionCount: empty ? 0 : i === 7 ? 2 : i === 6 ? 1 : 0,
      })),
      evidence: ["oddeven", "secondary", "ushape"].map((key, i) => ({
        key,
        useCount: !empty && i === 0 ? 2 : 0,
        accuracy: ratio(
          "PERCENT",
          !empty && i === 0 ? 1 : 0,
          !empty && i === 0 ? 1 : 0,
          !empty && i === 0 ? 100 : null,
        ),
        excludedCount: !empty && i === 0 ? 1 : 0,
      })),
      nextGoal: empty
        ? "별을 선택해 첫 탐사 기록을 남겨 보세요."
        : "최근 탐사 기록과 선택한 근거를 함께 살펴보세요.",
    },
    comparison: {
      status: "UNAVAILABLE",
      unavailableReason: "AGGREGATE_NOT_READY",
    },
  };
}
