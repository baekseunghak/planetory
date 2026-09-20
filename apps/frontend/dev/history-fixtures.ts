// #190 개발용 기록 응답. 탐사 API 8.2·8.3 그대로 답한다.
//
// 실제 백엔드(C14 · S15P21C206-148)는 develop에 있으므로 인수는 그쪽으로
// 한다. 이 응답은 **화면 회귀를 클릭으로 재현하기 위한 것**이며, 실제
// 연동의 근거가 아니다.

const BINS = 150;
const REFERENCE = 1683.4231;
const PERIOD = 11.802;

/** 당시 배열. 칸 87~92에 통과가 오도록 만든다(명세 Q11 회귀 기준과 같은 자리). */
function snapshotArrays() {
  const flux: (number | null)[] = [];
  const error: (number | null)[] = [];
  for (let i = 0; i < BINS; i++) {
    const inTransit = i >= 87 && i <= 92;
    // 값이 없는 칸도 섞어 둔다. 화면이 0으로 바꾸지 않는지 보기 위해서다.
    if (i === 12) {
      flux.push(null);
      error.push(null);
      continue;
    }
    flux.push(inTransit ? 0.9962 : 1.0001);
    error.push(0.0004);
  }
  return { bins: BINS, foldedFlux: flux, foldedError: error };
}

/** 현재 판 곡선. 한 세그먼트로 두 주기를 덮는다. */
function segments() {
  const nPoints = 240;
  const binMinutes = (PERIOD * 2 * 1440) / nPoints;
  const flux: (number | null)[] = [];
  for (let i = 0; i < nPoints; i++) {
    const phase = ((i * binMinutes) / 1440 / PERIOD) % 1;
    flux.push(phase > 0.985 || phase < 0.015 ? 0.9964 : 1.0002);
  }
  return [
    {
      segmentId: "s-14-1",
      sector: 14,
      binningRevision: "r1",
      startBtjd: REFERENCE,
      binMinutes,
      nPoints,
      flux,
    },
  ];
}

const submission = (patch: Record<string, unknown> = {}) => ({
  submissionId: "sub-7001",
  historyId: "h-501",
  requestId: "6f0b3a1e-548a-4a52-897a-135729468abc",
  ticId: "259377024",
  bundleId: "b-3",
  submittedAt: "2026-09-10T02:30:00Z",
  submissionKind: "candidate",
  curveContext: {
    bundleId: "b-3",
    curveStep: 1,
    removedCandidateIds: ["c-401"],
    residualModelVersion: "rm-1",
    periodogramConfigVersion: "pg-1",
  },
  original: {
    periodDays: PERIOD,
    sourcePeakGridIndex: 3311,
    phaseStart: 0.9874,
    phaseEnd: 0.9974,
  },
  serverDerived: {
    foldReferenceTimeBtjd: REFERENCE,
    phaseCenter: 0.9924,
    epochBtjd: REFERENCE,
    durationHours: 2.83,
    sourcePeakSuggestedDurationHours: 3.1,
    durationLimitHours: 9.3,
    centroidDataStatus: "unavailable",
  },
  match: {
    status: "matched_harmonic",
    candidateId: "c-402",
    harmonicMultiplier: 2,
    correctedPeriodDays: 23.604,
    correctionReason: "P/2 alias",
  },
  signal: {
    candidateId: "c-402",
    disposition: "UNCONFIRMED",
    answerClass: "analysis",
    planetTruth: null,
    bls: {
      periodDays: 23.604,
      epochBtjd: 1695.11,
      durationHours: 3.4,
      depthPpm: 380,
      sde: null,
      snr: null,
    },
    ai: {
      status: "completed",
      score: 0.71,
      verdict: "hold",
      modelVersion: "astronet-triage-fixture-190",
    },
    external: [],
  },
  judgment: { value: "LIKELY_PLANET", evaluation: "UNSCORED" },
  skyVersion: "u-190:1",
  achievement: {
    result: "pending_publish",
    newlyRecognized: false,
    unlockedStars: [],
    star: { count: 2, grade: "S" },
  },
  // 8.2절은 6.4절보다 넓다. 공개된 기록은 여기서만 나온다.
  publication: { state: "PUBLISHED", publicAnalysisId: "pa-9" },
  detail: { available: true, targetKind: "CURRENT_MATCH", answerViewed: true },
  progress: {
    stage: "in_progress",
    completionReason: null,
    reopenPending: false,
    currentCurveStep: 1,
    remainingDiscoverableCount: 1,
  },
  judgmentStatistics: null,
  nextActions: ["VIEW_RESULT"],
  ...patch,
});

const detail = (historyId: string, patch: Record<string, unknown> = {}) => ({
  historyId,
  submission: submission({ historyId }),
  versions: {
    data: "sec-14-41-54/r1",
    // 143이 보존하지 않은 값이다. 꾸며 채우지 않는다.
    preprocess: null,
    pipeline: null,
    rule: "rule-3",
    residualModel: "rm-1",
    periodogramConfig: "pg-1",
    snapshotVersion: "folded-mad-v1",
  },
  snapshotParams: {
    periodogramViewport: { minDays: 8, maxDays: 16 },
    foldedXZoomRatio: 4,
    foldSettings: { referenceTimeBtjd: REFERENCE },
    centroidDataStatus: "unavailable",
  },
  isPreviousBundle: false,
  relabel: null,
  createdAt: "2026-09-10T02:30:00Z",
  ...patch,
});

const graph = (
  historyId: string,
  mode: string,
  patch: Record<string, unknown> = {},
) => {
  const retired = historyId === "h-502";
  const common = {
    historyId,
    reproduction: {
      submittedBundleId: retired ? "b-2" : "b-3",
      currentBundleId: "b-3",
      isPreviousSubmission: retired,
      residualReproducible: !retired,
      fallbackReason: retired ? "RETIRED_CANDIDATE" : null,
      currentFoldReferenceTimeBtjd: REFERENCE,
    },
    // 구기록에는 저장 버전이 없다. 없다고 최신으로 추정하지 않는다.
    snapshotVersion: retired ? null : "folded-mad-v1",
  };
  if (mode === "SUBMITTED")
    return {
      ...common,
      selection: {
        userPeriodDays: PERIOD,
        correctedPeriodDays: 23.604,
        harmonicMultiplier: 2,
        epochBtjd: REFERENCE,
        durationHours: 2.83,
        currentPhaseStart: null,
        currentPhaseEnd: null,
      },
      curve: null,
      snapshot: snapshotArrays(),
      ...patch,
    };
  return {
    ...common,
    selection: {
      userPeriodDays: PERIOD,
      correctedPeriodDays: 23.604,
      harmonicMultiplier: 2,
      epochBtjd: REFERENCE,
      durationHours: 2.83,
      currentPhaseStart: 0.9874,
      currentPhaseEnd: 0.9974,
    },
    curve: {
      ticId: "259377024",
      bundleId: "b-3",
      segments: segments(),
      residual: retired
        ? { status: "COMPLETED", jobId: null }
        : { status: "COMPLETED", jobId: "job-1" },
      curveContext: {
        bundleId: "b-3",
        curveStep: retired ? 0 : 1,
        removedCandidateIds: retired ? [] : ["c-401"],
        residualModelVersion: "rm-1",
        periodogramConfigVersion: "pg-1",
      },
    },
    snapshot: null,
    ...patch,
  };
};

export type HistoryFixtureReply = {
  status: number;
  body: unknown;
};

/** `h-503`은 최초 응답이 없는 기록이다. 상세만 503이고 그래프는 온다(8.2절). */
export function historyFixtureResponse(
  pathname: string,
  search: URLSearchParams,
): HistoryFixtureReply | null {
  const match = /^\/v1\/histories\/([^/]+)(\/graph)?$/.exec(pathname);
  if (!match) return null;
  const historyId = decodeURIComponent(match[1]);
  const known = ["h-501", "h-502", "h-503"].includes(historyId);
  if (!known)
    return {
      status: 404,
      body: { code: "RESOURCE_NOT_FOUND", message: "없는 기록입니다." },
    };

  if (match[2]) {
    const mode = search.get("mode") ?? "CURRENT";
    if (mode !== "CURRENT" && mode !== "SUBMITTED")
      return {
        status: 400,
        body: {
          code: "VALIDATION_FAILED",
          message: "mode 값을 확인해 주세요.",
        },
      };
    return { status: 200, body: graph(historyId, mode) };
  }

  if (historyId === "h-503")
    return {
      status: 503,
      body: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "최초 응답이 없어 상세를 제공할 수 없는 기록입니다.",
      },
    };
  return {
    status: 200,
    body: detail(
      historyId,
      historyId === "h-502"
        ? {
            isPreviousBundle: true,
            relabel: {
              relabeledAt: "2026-09-18T05:00:00Z",
              newDisposition: "CONFIRMED",
            },
            versions: {
              data: "sec-14-41-54/r1",
              preprocess: null,
              pipeline: null,
              rule: "rule-2",
              residualModel: "rm-1",
              periodogramConfig: "pg-1",
              snapshotVersion: null,
            },
          }
        : {},
    ),
  };
}
