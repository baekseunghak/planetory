import {
  contextKey,
  readCurveContext,
  type AnalysisContext,
  type CurveContext,
} from "./analysis-data.ts";

export type Periodogram = {
  context: CurveContext;
  periodMinDays: number;
  periodMaxDays: number;
  nPeriods: number;
  gridRule: "log";
  baselineHalfDays: number;
  power: number[];
};
export type PeriodPeak = {
  rank: number;
  gridIndex: number;
  periodDays: number;
  power: number;
  fineTune: {
    periodMinDays: number;
    periodMaxDays: number;
    periodStepDays: number;
  };
  suggestedDurationHours: number;
  suggestedPhaseCenter: number;
};
export type CandidatePeaks = {
  context: CurveContext;
  peakRuleVersion: string;
  peaks: PeriodPeak[];
  matchedCandidates: { candidateId: string; periodDays: number }[];
};

export class PeriodogramContextChanged extends Error {
  constructor() {
    super(
      "시간 곡선과 주기도의 문맥이 다릅니다. 분석 자료를 다시 불러와 주세요.",
    );
  }
}
function invalid(field: string): never {
  throw new Error(`주기도 응답의 ${field} 항목을 확인해 주세요.`);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
}
function positive(value: unknown, field: string): number {
  const result = finite(value, field);
  if (result <= 0) invalid(field);
  return result;
}
function integer(value: unknown, field: string, minimum: number): number {
  const result = finite(value, field);
  if (!Number.isSafeInteger(result) || result < minimum) invalid(field);
  return result;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(field);
  return value;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}
function context(value: unknown, expected: CurveContext): CurveContext {
  const current = readCurveContext(value);
  if (contextKey(current) !== contextKey(expected))
    throw new PeriodogramContextChanged();
  return current;
}
// Floating point agreement only; never round the value stored for later selection.
function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}
export function periodAt(
  grid: Pick<Periodogram, "nPeriods" | "periodMinDays" | "periodMaxDays">,
  index: number,
): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= grid.nPeriods)
    invalid("gridIndex");
  if (index === 0) return grid.periodMinDays;
  if (index === grid.nPeriods - 1) return grid.periodMaxDays;
  return Math.exp(
    Math.log(grid.periodMinDays) +
      ((Math.log(grid.periodMaxDays) - Math.log(grid.periodMinDays)) * index) /
        (grid.nPeriods - 1),
  );
}
export function periodogramPath(
  expected: AnalysisContext,
  resource: "periodogram" | "candidate-peaks",
): string {
  const current = expected.curveContext;
  const query = new URLSearchParams({
    bundleId: current.bundleId,
    curveStep: String(current.curveStep),
  });
  if (current.removedCandidateIds.length)
    query.set("removed", [...current.removedCandidateIds].sort().join(","));
  return `/v1/stars/${encodeURIComponent(expected.ticId)}/${resource}?${query}`;
}
export function decodePeriodogram(
  value: unknown,
  expected: AnalysisContext,
): Periodogram {
  const data = record(value, "periodogram");
  const current = context(data.curveContext, expected.curveContext);
  if (record(data.residual, "residual").status !== "COMPLETED")
    invalid("residual.status");
  const periodMinDays = positive(data.periodMinDays, "periodMinDays");
  const periodMaxDays = positive(data.periodMaxDays, "periodMaxDays");
  if (periodMaxDays <= periodMinDays || data.gridRule !== "log")
    invalid("period range/gridRule");
  const nPeriods = integer(data.nPeriods, "nPeriods", 2);
  const power = array(data.power, "power").map((point) =>
    finite(point, "power"),
  );
  if (power.length !== nPeriods) invalid("nPeriods/power.length");
  return {
    context: current,
    periodMinDays,
    periodMaxDays,
    nPeriods,
    gridRule: "log",
    baselineHalfDays: positive(data.baselineHalfDays, "baselineHalfDays"),
    power,
  };
}
export function decodeCandidatePeaks(
  value: unknown,
  expected: AnalysisContext,
  grid: Periodogram,
): CandidatePeaks {
  const data = record(value, "candidate-peaks");
  const current = context(data.curveContext, expected.curveContext);
  if (contextKey(grid.context) !== contextKey(current))
    throw new PeriodogramContextChanged();
  const peaks = array(data.peaks, "peaks").map((value): PeriodPeak => {
    const peak = record(value, "peak");
    const rank = integer(peak.rank, "rank", 1);
    const gridIndex = integer(peak.gridIndex, "gridIndex", 0);
    const periodDays = positive(peak.periodDays, "periodDays");
    const power = finite(peak.power, "peak.power");
    if (
      periodDays < grid.periodMinDays ||
      periodDays > grid.periodMaxDays ||
      !close(periodDays, periodAt(grid, gridIndex)) ||
      !close(power, grid.power[gridIndex])
    )
      invalid("peak/grid mismatch");
    const fine = record(peak.fineTune, "fineTune");
    const periodMinDays = positive(
      fine.periodMinDays,
      "fineTune.periodMinDays",
    );
    const periodMaxDays = positive(
      fine.periodMaxDays,
      "fineTune.periodMaxDays",
    );
    const periodStepDays = positive(
      fine.periodStepDays,
      "fineTune.periodStepDays",
    );
    if (
      periodMinDays > periodDays ||
      periodMaxDays < periodDays ||
      periodMinDays >= periodMaxDays ||
      periodStepDays > periodMaxDays - periodMinDays
    )
      invalid("fineTune range/step");
    const suggestedPhaseCenter = finite(
      peak.suggestedPhaseCenter,
      "suggestedPhaseCenter",
    );
    if (suggestedPhaseCenter < 0 || suggestedPhaseCenter >= 1)
      invalid("suggestedPhaseCenter");
    return {
      rank,
      gridIndex,
      periodDays,
      power,
      fineTune: { periodMinDays, periodMaxDays, periodStepDays },
      suggestedDurationHours: positive(
        peak.suggestedDurationHours,
        "suggestedDurationHours",
      ),
      suggestedPhaseCenter,
    };
  });
  if (
    new Set(peaks.map((peak) => peak.gridIndex)).size !== peaks.length ||
    new Set(peaks.map((peak) => peak.rank)).size !== peaks.length
  )
    invalid("duplicate peak rank/gridIndex");
  const matchedCandidates = array(
    data.matchedCandidates,
    "matchedCandidates",
  ).map((value) => {
    const matched = record(value, "matchedCandidate");
    return {
      candidateId: text(matched.candidateId, "matchedCandidate.candidateId"),
      periodDays: positive(matched.periodDays, "matchedCandidate.periodDays"),
    };
  });
  if (
    new Set(matchedCandidates.map((matched) => matched.candidateId)).size !==
    matchedCandidates.length
  )
    invalid("duplicate matchedCandidate");
  // Project only the public contract. This is not a substitute for server disclosure checks.
  return {
    context: current,
    peakRuleVersion: text(data.peakRuleVersion, "peakRuleVersion"),
    peaks,
    matchedCandidates,
  };
}

export function decodePendingPeriodogram(
  value: unknown,
  expected: AnalysisContext,
) {
  const data = record(value, "periodogram");
  // 5.3 inherits the 5.2 pending envelope, including segments:null.
  if (
    expected.curveContext.curveStep === 0 ||
    data.code !== "CURVE_NOT_READY" ||
    data.segments !== null
  )
    invalid("pending periodogram");
  if (data.curveContext !== undefined)
    context(data.curveContext, expected.curveContext);
  const residual = record(data.residual, "residual");
  const status =
    residual.status === null ? null : text(residual.status, "residual.status");
  const jobId =
    residual.jobId === null ? null : text(residual.jobId, "residual.jobId");
  if (
    (status === null) !== (jobId === null) ||
    (status !== null &&
      ![
        "QUEUED",
        "RESIDUAL_CALCULATING",
        "RESIDUAL_READY",
        "PERIODOGRAM_CALCULATING",
        "FAILED",
      ].includes(status))
  )
    invalid("residual.status/jobId");
  return { status, jobId };
}
