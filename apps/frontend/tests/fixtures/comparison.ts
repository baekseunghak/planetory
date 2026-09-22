// Synthetic PersonalStatisticsService.Comparison, develop bdafb0ce.
// No AVAILABLE historical myValue is produced by the current backend.
export function comparisonFixture(unavailable = false) {
  return {
    status: unavailable ? "UNAVAILABLE" : "READY",
    unavailableReason: unavailable ? "AGGREGATE_NOT_READY" : null,
    asOf: unavailable ? null : "2026-09-21T15:00:00Z",
    sourceObservedAt: unavailable ? null : "2026-09-21T15:05:00Z",
    generatedAt: unavailable ? null : "2026-09-21T15:05:01Z",
    snapshotDate: unavailable ? null : "2026-09-21",
    cohortStart: unavailable ? null : "2026-06-23T15:00:00Z",
    cohortEnd: unavailable ? null : "2026-09-21T15:00:00Z",
    cohortMemberCount: unavailable ? null : 10,
    inCohort: null as boolean | null,
    metrics: Object.fromEntries(
      [
        ["firstMatchAccuracy", "PERCENT", 50],
        ["submissionsPerStar", "SUBMISSIONS_PER_STAR", 1.5],
        ["harmonicRecognitionRate", "PERCENT", 0],
        ["evidencePerSubmission", "CHECKS_PER_SUBMISSION", 0.75],
      ].map(([key, unit, median]) => [
        key,
        {
          myValue: {
            unit,
            value: null,
            numerator: null,
            denominator: null,
            status: "UNAVAILABLE",
            reason: unavailable
              ? "AGGREGATE_NOT_READY"
              : "HISTORICAL_SOURCE_UNAVAILABLE",
          },
          median: unavailable ? null : median,
          sampleCount: unavailable ? null : 8,
          status: unavailable ? "UNAVAILABLE" : "AVAILABLE",
          reason: unavailable ? "AGGREGATE_NOT_READY" : null,
        },
      ]),
    ),
  };
}
