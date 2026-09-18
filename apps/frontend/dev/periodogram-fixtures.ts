import {
  analysisContextFixture,
  analysisCurveFixture,
  analysisFixtureResponse,
  ANALYSIS_FIXTURE_TICS,
} from "./analysis-fixtures.ts";

// Authored synthetic display data, not BLS output. Never mix with observation exports.
export const PERIODOGRAM_FIXTURE_TICS = {
  normal: "259377024",
  malformed: "259377025",
  mismatch: "259377026",
  empty: "259377027",
  unavailable: "259377028",
  pending: "259377029",
} as const;
export const PERIODOGRAM_FIXTURE_BUNDLE = "9007199254741093";
export function periodContextFixture(
  ticId: string = PERIODOGRAM_FIXTURE_TICS.normal,
) {
  const result = analysisContextFixture(ticId);
  const current = result.currentCurveContext;
  current.bundleId = PERIODOGRAM_FIXTURE_BUNDLE;
  current.residualModelVersion = "rm-fixture-183";
  current.periodogramConfigVersion = "pg-synthetic-183-v1";
  if (ticId === PERIODOGRAM_FIXTURE_TICS.pending) {
    current.curveStep = 1;
    current.removedCandidateIds = ["9007199254741094"];
  }
  result.star = { sectorCount: 1, sectors: [14], tmag: 9.8 };
  Object.assign(result.bundle, {
    bundleId: current.bundleId,
    residualModelVersion: current.residualModelVersion,
    periodogramConfigVersion: current.periodogramConfigVersion,
    baseDays: 7,
    observationBounds: [1683.35, 1690.35],
    foldReferenceTimeBtjd: 1686.85,
  });
  result.selectionRules.version = "selection-synthetic-183-v1";
  result.progress.currentCurveStep = current.curveStep;
  result.progress.matchedCandidateIds = ["9007199254741094"];
  return result;
}
export function periodCurveFixture(
  ticId: string = PERIODOGRAM_FIXTURE_TICS.normal,
) {
  const result = analysisCurveFixture(ticId),
    current = periodContextFixture(ticId);
  result.bundleId = current.bundle.bundleId;
  result.foldReferenceTimeBtjd = current.bundle.foldReferenceTimeBtjd;
  result.curveContext = current.currentCurveContext;
  result.segments = [
    {
      ...result.segments[0],
      nPoints: 1009,
      flux: Array.from(
        { length: 1009 },
        (_, index) => 1 + 0.001 * Math.sin(index / 20),
      ),
      gaps: [],
    },
  ];
  return result;
}
const grid = {
  periodMinDays: 0.5,
  periodMaxDays: 40,
  nPeriods: 5000,
  gridRule: "log" as const,
};
const peakIndices = [3600, 2500, 1600];
const amplitudes = [0.8, 0.5, 0.3];
export function periodogramFixture(
  ticId: string = PERIODOGRAM_FIXTURE_TICS.normal,
) {
  return {
    curveContext: periodContextFixture(ticId).currentCurveContext,
    residual: { status: "COMPLETED", jobId: null },
    ...grid,
    baselineHalfDays: 3.5,
    power: Array.from(
      { length: grid.nPeriods },
      (_, index) =>
        0.01 +
        peakIndices.reduce(
          (sum, center, rank) =>
            sum + amplitudes[rank] * Math.exp(-(((index - center) / 20) ** 2)),
          0,
        ),
    ),
  };
}
export function candidatePeaksFixture(
  ticId: string = PERIODOGRAM_FIXTURE_TICS.normal,
) {
  const data = periodogramFixture(ticId);
  const ratio =
    (grid.periodMaxDays / grid.periodMinDays) ** (1 / (grid.nPeriods - 1));
  const half =
    periodContextFixture(ticId).selectionRules.fineTune.halfWidthCells;
  return {
    curveContext: data.curveContext,
    peaks: peakIndices.map((gridIndex, index) => {
      const periodDays =
        grid.periodMinDays *
        (grid.periodMaxDays / grid.periodMinDays) **
          (gridIndex / (grid.nPeriods - 1));
      return {
        rank: index + 1,
        gridIndex,
        periodDays,
        power: data.power[gridIndex],
        fineTune: {
          periodMinDays: periodDays * ratio ** -half,
          periodMaxDays: periodDays * ratio ** half,
          periodStepDays: periodDays * (ratio - 1),
        },
        suggestedDurationHours: 2,
        suggestedPhaseCenter: 0.375,
      };
    }),
    matchedCandidates: [{ candidateId: "9007199254741094", periodDays: 3.25 }],
    peakRuleVersion: "peaks-synthetic-183-v1",
  };
}
export function periodogramFixtureResponse(
  url: URL,
): { status: number; body: unknown; currentBundleId?: string } | null {
  const match =
    /^\/v1\/stars\/([^/]+)\/(analysis-context|curves|periodogram|candidate-peaks)$/.exec(
      url.pathname,
    );
  if (!match) return null;
  const [, ticId, resource] = match;
  if (!Object.values(PERIODOGRAM_FIXTURE_TICS).some((tic) => tic === ticId)) {
    if (
      ["periodogram", "candidate-peaks"].includes(resource) &&
      (ticId === ANALYSIS_FIXTURE_TICS.locked ||
        ticId === ANALYSIS_FIXTURE_TICS.unpublished)
    ) {
      const access = new URL(url);
      access.pathname = `/v1/stars/${ticId}/analysis-context`;
      return analysisFixtureResponse(access);
    }
    return null;
  }
  const reply = (status: number, body: unknown) => ({
    status,
    body,
    currentBundleId: PERIODOGRAM_FIXTURE_BUNDLE,
  });
  const current = periodContextFixture(ticId);
  if (resource === "analysis-context") return reply(200, current);
  if (url.searchParams.get("bundleId") !== PERIODOGRAM_FIXTURE_BUNDLE)
    return reply(409, {
      code: "BUNDLE_CHANGED",
      message: "새 데이터 판을 다시 불러와 주세요.",
      currentBundleId: PERIODOGRAM_FIXTURE_BUNDLE,
    });
  if (
    url.searchParams.get("curveStep") !==
      String(current.currentCurveContext.curveStep) ||
    (url.searchParams.get("removed") ?? "") !==
      current.currentCurveContext.removedCandidateIds.join(",")
  )
    return reply(400, {
      code: "VALIDATION_FAILED",
      message: "곡선 문맥을 확인해 주세요.",
    });
  if (resource === "curves") return reply(200, periodCurveFixture(ticId));
  if (ticId === PERIODOGRAM_FIXTURE_TICS.unavailable)
    return reply(503, {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "주기도 자료를 불러오지 못했습니다.",
    });
  if (resource === "periodogram") {
    if (ticId === PERIODOGRAM_FIXTURE_TICS.pending)
      return reply(202, {
        // 서버는 202에도 같은 주기도 본문을 두고 power만 null로 보낸다.
        // code·segments 필드는 존재하지 않는다 (AnalysisViews.Periodogram).
        ...periodogramFixture(ticId),
        power: null,
        residual: { status: null, jobId: null },
      });
    const data = periodogramFixture(ticId);
    if (ticId === PERIODOGRAM_FIXTURE_TICS.malformed) data.power.pop();
    return reply(200, data);
  }
  const data = candidatePeaksFixture(ticId);
  if (ticId === PERIODOGRAM_FIXTURE_TICS.mismatch)
    data.curveContext.periodogramConfigVersion = "other-version";
  if (ticId === PERIODOGRAM_FIXTURE_TICS.empty) data.peaks = [];
  return reply(200, data);
}
