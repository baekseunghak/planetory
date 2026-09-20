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
  // 튜토리얼 별. 정상 샘플과 자료는 같고 건너뛰기만 허용된다(#187 특수 제출).
  tutorial: "259377030",
} as const;
export const PERIODOGRAM_FIXTURE_BUNDLE = "9007199254741093";
const grid = {
  periodMinDays: 0.5,
  periodMaxDays: 40,
  nPeriods: 5000,
  gridRule: "log" as const,
};
const peakIndices = [3600, 2500, 1600];
const gridPeriod = (index: number) =>
  grid.periodMinDays *
  (grid.periodMaxDays / grid.periodMinDays) ** (index / (grid.nPeriods - 1));

// Deterministic, compact source for a folding demonstration, not an astrophysical fit.
export const FOLD_SAMPLE = {
  startBtjd: 1683.35,
  baseDays: 120,
  binMinutes: 10,
  nPoints: 17281,
  referenceBtjd: 1743.35,
  periodDays: gridPeriod(peakIndices[0]),
  durationHours: 2,
  depth: 0.008,
  noiseAmplitude: 0.0002,
} as const;
function sampleFlux(index: number): number {
  const elapsed =
    FOLD_SAMPLE.startBtjd +
    (index * FOLD_SAMPLE.binMinutes) / 1440 -
    FOLD_SAMPLE.referenceBtjd;
  const cycle = Math.round(elapsed / FOLD_SAMPLE.periodDays);
  const distanceDays = Math.abs(elapsed - cycle * FOLD_SAMPLE.periodDays);
  const halfDuration = FOLD_SAMPLE.durationHours / 48;
  const transit = Math.max(
    0,
    Math.min(1, (halfDuration - distanceDays) / (halfDuration * 0.3)),
  );
  // Reproducible irregular noise, independent of the injected transit period.
  let hash = Math.imul(index + 1, 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  const noise =
    (((hash >>> 0) / 0xffffffff) * 2 - 1) * FOLD_SAMPLE.noiseAmplitude;
  return 1 - FOLD_SAMPLE.depth * transit + noise;
}
export function periodContextFixture(
  ticId: string = PERIODOGRAM_FIXTURE_TICS.normal,
) {
  const result = analysisContextFixture(ticId);
  const current = result.currentCurveContext;
  current.bundleId = PERIODOGRAM_FIXTURE_BUNDLE;
  current.residualModelVersion = "rm-fixture-183";
  current.periodogramConfigVersion = "pg-synthetic-184-v2";
  if (ticId === PERIODOGRAM_FIXTURE_TICS.pending) {
    current.curveStep = 1;
    current.removedCandidateIds = ["9007199254741094"];
  }
  if (ticId === PERIODOGRAM_FIXTURE_TICS.tutorial)
    result.tutorial = { seq: 1, skipAvailable: true };
  result.star = { sectorCount: 1, sectors: [14], tmag: 9.8 };
  Object.assign(result.bundle, {
    bundleId: current.bundleId,
    residualModelVersion: current.residualModelVersion,
    periodogramConfigVersion: current.periodogramConfigVersion,
    baseDays: FOLD_SAMPLE.baseDays,
    observationBounds: [
      FOLD_SAMPLE.startBtjd,
      FOLD_SAMPLE.startBtjd + FOLD_SAMPLE.baseDays,
    ],
    foldReferenceTimeBtjd: FOLD_SAMPLE.referenceBtjd,
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
      binningRevision: "10m-v2",
      startBtjd: FOLD_SAMPLE.startBtjd,
      binMinutes: FOLD_SAMPLE.binMinutes,
      nPoints: FOLD_SAMPLE.nPoints,
      flux: Array.from({ length: FOLD_SAMPLE.nPoints }, (_, index) =>
        sampleFlux(index),
      ),
      fluxScatter: FOLD_SAMPLE.noiseAmplitude / Math.sqrt(3),
      gaps: [],
    },
  ];
  return result;
}
const amplitudes = [0.8, 0.5, 0.3];
export function periodogramFixture(
  ticId: string = PERIODOGRAM_FIXTURE_TICS.normal,
) {
  return {
    curveContext: periodContextFixture(ticId).currentCurveContext,
    residual: { status: "COMPLETED", jobId: null },
    ...grid,
    baselineHalfDays: FOLD_SAMPLE.baseDays / 2,
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
      const periodDays = gridPeriod(gridIndex);
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
        suggestedPhaseCenter: index === 0 ? 0 : 0.375,
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
