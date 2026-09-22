// Synthetic transport fixture matching backend V21 global_stats payload.
export function globalStatisticsFixture(empty = false) {
  const count = (unit: string, n: number) => ({
    unit,
    value: empty ? 0 : n,
    numerator: empty ? 0 : n,
    denominator: null,
    status: "AVAILABLE",
    reason: null as string | null,
  });
  const ratio = (n: number, d: number) => ({
    unit: "PERCENT",
    value: empty ? null : (100 * n) / d,
    numerator: empty ? 0 : n,
    denominator: empty ? 0 : d,
    status: empty ? "NO_SAMPLE" : "AVAILABLE",
    reason: empty ? "ZERO_DENOMINATOR" : null,
  });
  return {
    policyVersion: "2026-09-22",
    timeZone: "Asia/Seoul",
    global: {
      status: "READY",
      asOf: "2026-09-22T03:00:00Z",
      generatedAt: "2026-09-22T03:00:01Z",
      reason: null as string | null,
      data: {
        metrics: {
          discoveredStars: count("STAR", 30),
          uniqueDiscoveredStars: count("STAR", 15),
          startedStars: count("STAR", 35),
          currentCompletedStars: count("STAR", 20),
          uniqueCurrentCompletedStars: count("STAR", 12),
          recognizedSignals: count("ACHIEVEMENT", 50),
          confirmedAchievements: count("ACHIEVEMENT", 20),
          unconfirmedAchievements: count("ACHIEVEMENT", 20),
          fpAchievements: count("ACHIEVEMENT", 10),
          uniqueRecognizedSignals: count("SIGNAL", 25),
          uniqueConfirmedSignals: count("SIGNAL", 12),
          uniqueFpSignals: count("SIGNAL", 5),
          uniqueUnconfirmedSignals: count("SIGNAL", 8),
          firstMatchAccuracy: ratio(20, 30),
          publicLikelyPlanet: count("PARTICIPATION", 8),
          publicUnlikelyPlanet: count("PARTICIPATION", 4),
          publicUnsure: count("PARTICIPATION", 3),
          publicLikelyPlanetRate: ratio(8, 15),
          publicUnlikelyPlanetRate: ratio(4, 15),
          publicUnsureRate: ratio(3, 15),
          publicParticipations: count("PARTICIPATION", 15),
          aiAttemptUnknown: {
            ...count("PARTICIPATION", 15),
            reason: "AI_ATTEMPT_UNKNOWN",
          },
        },
        weeklySubmissions: Array.from({ length: 8 }, (_, i) => ({
          weekStart: new Date(Date.UTC(2026, 7, 3 + i * 7))
            .toISOString()
            .slice(0, 10),
          submissions: empty ? 0 : i * 3,
          partial: i === 7,
        })),
        mostPostsStars: empty ? [] : [{ ticId: "259377024", postCount: 5 }],
        sectorCompletion: empty
          ? []
          : [{ sector: 1, ...ratio(2, 3) }].map(
              ({ reason: _reason, ...s }) => s,
            ),
        challenges: empty
          ? []
          : [
              {
                roundId: "9007199254740993",
                roundNo: 1,
                participantCount: 2,
                participationCount: 3,
                likelyPlanet: 2,
                unlikelyPlanet: 1,
                unsure: 0,
              },
            ],
        aiJudgmentBands: {
          status: "NO_SAMPLE",
          reason: "AI_ATTEMPT_UNKNOWN",
          items: [],
        },
      },
    },
    // A separate comparison block must never turn valid global values into errors.
    comparison: { status: "UNAVAILABLE" },
  };
}
export const unavailableGlobalStatistics = () => ({
  policyVersion: "2026-09-22",
  timeZone: "Asia/Seoul",
  global: {
    status: "UNAVAILABLE",
    asOf: null,
    generatedAt: null,
    reason: "AGGREGATE_NOT_READY",
    data: null,
  },
});
