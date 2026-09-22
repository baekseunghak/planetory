// #193 API 8.4에 맞춘 합성 화면 회귀 자료. 실제 API/DB 검증을 대체하지 않는다.
export function relabeledStarResultFixture(newDisposition = "FP") {
  const body = starResultFixture();
  body.signals[0].disposition = newDisposition;
  body.signals[0].relabel = {
    newDisposition,
    relabeledAt: "2026-09-22T04:00:00Z",
  };
  return body;
}

export function starResultFixture(ticId = "259377024") {
  return {
    ticId,
    star: { sectorCount: 3, tmag: 9.8 },
    bundle: { bundleId: "b-3", publishedAt: "2026-09-21T01:00:00Z" },
    progress: {
      stage: "completed",
      completionReason: "all_found",
      reopenPending: true,
      currentCurveStep: 1,
      matchedCandidateIds: ["c-402"],
      remainingDiscoverableCount: 0,
    },
    achievement: {
      count: 1,
      grade: "A",
      byType: { confirmed: 1, unconfirmed: 0, fp: 0 },
    },
    signals: [
      {
        candidateId: "c-402",
        disposition: "UNCONFIRMED",
        status: "active",
        latestSubmissionId: "sub-7001",
        latestHistoryId: "h-501",
        matchResult: "duplicate",
        userJudgment: "LIKELY_PLANET",
        judgmentEvaluation: "UNSCORED",
        achievement: { result: "pending_publish", recognizedAt: null },
        publication: { state: "UNPUBLISHED", publicAnalysisId: null },
        ai: { status: "not_evaluated", modelVersion: null },
        judgmentStatistics: {
          kind: "public_analyses",
          candidateId: "c-402",
          participantCount: 0,
          likelyPlanet: 0,
          unlikelyPlanet: 0,
          unsure: 0,
          percentages: null,
          asOf: "2026-09-21T01:00:00Z",
        },
        relabel: null as { relabeledAt: string; newDisposition: string } | null,
        curveStepAtMatch: 0,
        submissionIds: ["sub-6990", "sub-7001"],
        threadId: "st-301",
      },
    ],
    unmatchedSubmissions: [
      {
        submissionId: "sub-7002",
        historyId: "h-502",
        matchResult: "not_matched",
        submittedAt: "2026-09-21T02:00:00Z",
      },
    ],
    curveSteps: [
      {
        curveStep: 0,
        removedCandidateIds: [] as string[],
        residual: { status: "COMPLETED", jobId: null, computedAt: null },
      },
      {
        curveStep: 1,
        removedCandidateIds: ["c-402"],
        residual: { status: "FAILED", jobId: "rj-1", computedAt: null },
      },
    ],
    discoveredStars: [
      {
        ticId: "199574208",
        unlockedAt: "2026-09-21T02:00:00Z",
        triggerAchievementId: "ach-31",
      },
    ],
    unpublishedSignalCount: 1,
    links: { boardOpen: true, threadIds: ["st-301"] },
    nextActions: ["PUBLISH_ALL", "LATER", "RETRY"],
  };
}
