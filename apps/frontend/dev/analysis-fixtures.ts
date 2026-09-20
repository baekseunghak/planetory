// Synthetic display fixtures, version analysis-read-v1. See docs/analysis-data.md.
// Deliberately short arrays, NOT a Gold export or a production-resolution sample.
export const ANALYSIS_FIXTURE_BUNDLE = "9007199254740993";
export const ANALYSIS_FIXTURE_TICS = {
  normal: "259377017",
  locked: "259377018",
  unpublished: "259377019",
  malformed: "259377020",
  unavailable: "259377021",
  notComputed: "259377022",
  changing: "259377023",
} as const;

/**
 * 단계 이동에 얽힌 값을 한꺼번에 다시 맞춘다(5.1절).
 *
 * 제거 조합은 **매칭한 후보의 부분집합**이어야 하고(7.1절), `nextCurveContext`는
 * 매칭한 것을 전부 제거한 문맥이다. 현재 단계만 손으로 바꾸면 이 관계가
 * 깨지므로 바꾼 뒤에는 반드시 이 함수를 부른다.
 */
export function withMatched<
  T extends {
    currentCurveContext: {
      curveStep: number;
      removedCandidateIds: string[];
    } & Record<string, unknown>;
    progress: Record<string, unknown>;
    residualForCurrentStep: { status: string | null; jobId: string | null };
    nextCurveContext?: unknown;
    residualForNextStep?: unknown;
  },
>(result: T, extraMatched: string[] = []): T {
  const current = result.currentCurveContext;
  const matched = [
    ...new Set([...current.removedCandidateIds, ...extraMatched]),
  ].sort();
  result.progress.matchedCandidateIds = matched;
  result.nextCurveContext = {
    ...current,
    curveStep: matched.length,
    removedCandidateIds: matched,
  };
  // 다음이 지금과 같으면 지금 것의 상태다. 다르면 아직 계산 전이다.
  result.residualForNextStep = {
    status:
      matched.length === current.curveStep
        ? result.residualForCurrentStep.status
        : null,
    jobId: null,
  };
  return result;
}

export function analysisContextFixture(
  ticId: string = ANALYSIS_FIXTURE_TICS.normal,
) {
  const removedCandidateIds =
    ticId === ANALYSIS_FIXTURE_TICS.notComputed ? ["9007199254740994"] : [];
  const currentCurveContext = {
    bundleId: ANALYSIS_FIXTURE_BUNDLE,
    curveStep: removedCandidateIds.length,
    removedCandidateIds,
    residualModelVersion: "rm-fixture-182",
    periodogramConfigVersion: "pg-fixture-182",
  };
  // 보통 별은 하나를 이미 매칭해 둬서 [다음 곡선]이 실제로 다음 단계를
  // 가리키게 한다. 같으면 전환할 것이 없어 흐름을 볼 수 없다.
  return withMatched(
    {
      ticId,
      star: { sectorCount: 2, sectors: [14, 41], tmag: 9.8 },
      hasConfirmedCandidate: true,
      bundle: {
        bundleId: ANALYSIS_FIXTURE_BUNDLE,
        bundleVersion: "v7",
        publishedAt: "2026-09-14T00:00:00Z",
        foldReferenceTimeBtjd: 1683.4231,
        baseDays: 0.12,
        observationBounds: [1683.35, 2420.0594444444446],
        residualModelVersion: currentCurveContext.residualModelVersion,
        periodogramConfigVersion: currentCurveContext.periodogramConfigVersion,
        binningRevision: "10m-v1",
        curveStepRule: "one_candidate_per_step",
      },
      selectionRules: {
        version: "sel-fixture-182",
        minWindowDays: 20 / 1440,
        phaseWidthMax: 0.25,
        maxDurationMultipleOfSuggested: 3,
        allowEmptyPhaseSpan: false,
        fineTune: { halfWidthCells: 3 },
      },
      progress: {
        stage: "in_progress",
        currentCurveStep: currentCurveContext.curveStep,
        matchedCandidateIds: removedCandidateIds,
        completionReason: null,
        reopenPending: false,
        achievementCount: 0,
        grade: null,
      },
      currentCurveContext,
      residualForCurrentStep: {
        status: removedCandidateIds.length ? null : "COMPLETED",
        jobId: null,
      },
      tutorial: { seq: null as number | null, skipAvailable: false },
      ruleVersion: "rule-fixture-182",
    },
    ticId === ANALYSIS_FIXTURE_TICS.normal ? ["9007199254740994"] : [],
  );
}
export function analysisCurveFixture(
  ticId: string = ANALYSIS_FIXTURE_TICS.normal,
) {
  const context = analysisContextFixture(ticId);
  return {
    ticId,
    bundleId: ANALYSIS_FIXTURE_BUNDLE,
    foldReferenceTimeBtjd: context.bundle.foldReferenceTimeBtjd,
    curveContext: context.currentCurveContext,
    residual: { status: "COMPLETED", jobId: null },
    fluxUnit: "normalized",
    segments: [
      {
        segmentId: "9007199254740995",
        sector: 14,
        binningRevision: "10m-v1",
        startBtjd: 1683.35,
        binMinutes: 10,
        nPoints: 8,
        flux: [1, 1.0001, null, null, 0.9998, 1.0002, 1, 1.0001],
        fluxScatter: 0.0012,
        gaps: [[2, 3]],
      },
      {
        segmentId: "9007199254740996",
        sector: 41,
        binningRevision: "10m-v1",
        startBtjd: 2419.99,
        binMinutes: 20,
        nPoints: 6,
        flux: [1.0002, null, 1, 0.9999, 1.0001, 1],
        fluxScatter: 0.0011,
        gaps: [[1, 1]],
      },
    ],
  };
}
export function analysisFixtureResponse(
  url: URL,
): { status: number; body: unknown; currentBundleId?: string } | null {
  const match = /^\/v1\/stars\/([^/]+)\/(analysis-context|curves)$/.exec(
    url.pathname,
  );
  if (!match) return null;
  const [, ticId, resource] = match;
  const error = (status: number, code: string, message: string) => ({
    status,
    body: { code, message, fieldErrors: [] },
  });
  if (ticId === ANALYSIS_FIXTURE_TICS.locked)
    return error(403, "STAR_LOCKED", "아직 열리지 않은 별입니다.");
  if (
    ticId === ANALYSIS_FIXTURE_TICS.unpublished ||
    !Object.values(ANALYSIS_FIXTURE_TICS).some((id) => id === ticId)
  )
    return error(
      404,
      "STAR_NOT_PUBLISHED",
      "이 별의 분석 자료를 볼 수 없습니다.",
    );
  if (ticId === ANALYSIS_FIXTURE_TICS.unavailable)
    return error(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "분석 자료를 불러오지 못했습니다.",
    );
  const context = analysisContextFixture(ticId);
  if (resource === "analysis-context") return { status: 200, body: context };
  // A deliberately persistent race: bounded recovery must end in manual retry.
  if (ticId === ANALYSIS_FIXTURE_TICS.changing)
    return {
      status: 200,
      body: analysisCurveFixture(ticId),
      currentBundleId: "9007199254740997",
    };
  if (url.searchParams.get("bundleId") !== ANALYSIS_FIXTURE_BUNDLE)
    return {
      status: 409,
      body: {
        code: "BUNDLE_CHANGED",
        message: "새 데이터 판을 다시 불러와 주세요.",
        currentBundleId: ANALYSIS_FIXTURE_BUNDLE,
      },
    };
  if (
    url.searchParams.get("curveStep") !==
      String(context.currentCurveContext.curveStep) ||
    (url.searchParams.get("removed") ?? "") !==
      context.currentCurveContext.removedCandidateIds.join(",")
  )
    return error(400, "VALIDATION_FAILED", "곡선 문맥을 확인해 주세요.");
  if (ticId === ANALYSIS_FIXTURE_TICS.notComputed)
    return {
      status: 202,
      // 서버는 202에도 같은 본문 구조를 두고 segments만 null로 보낸다.
      // code 필드는 존재하지 않는다 (AnalysisViews.Curve).
      body: {
        ticId,
        bundleId: ANALYSIS_FIXTURE_BUNDLE,
        foldReferenceTimeBtjd: context.bundle.foldReferenceTimeBtjd,
        curveContext: context.currentCurveContext,
        residual: { status: null, jobId: null },
        fluxUnit: "normalized",
        segments: null,
      },
    };
  const curve = analysisCurveFixture(ticId);
  if (ticId === ANALYSIS_FIXTURE_TICS.malformed) curve.segments[0].nPoints += 1;
  return { status: 200, body: curve };
}
