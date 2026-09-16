import { ApiError, type createApiClient } from "../../api/client.ts";
import {
  contextKey,
  type AnalysisContext,
  type CurveData,
} from "./analysis-data.ts";
import {
  decodeCandidatePeaks,
  decodePendingPeriodogram,
  decodePeriodogram,
  periodogramPath,
  PeriodogramContextChanged,
  type CandidatePeaks,
  type Periodogram,
} from "./periodogram-data.ts";

export type PeriodogramLoad =
  | {
      kind: "ready";
      selectionEnabled: true;
      periodogram: Periodogram;
      candidates: CandidatePeaks;
      rules: NonNullable<AnalysisContext["periodSelectionRules"]>;
    }
  | {
      kind: "unavailable";
      selectionEnabled: false;
      reason:
        | "curve-not-ready"
        | "rules-unavailable"
        | "periodogram-not-ready"
        | "empty-peaks";
      pending?: { status: string | null; jobId: string | null };
    };

// No cached previous result or automatic calculation. The caller must clear selection before loading.
// A Bundle change is returned to the page orchestration: reload context and curve together there.
export async function loadPeriodogram(
  request: ReturnType<typeof createApiClient>["request"],
  expected: AnalysisContext,
  curve: CurveData,
  signal: AbortSignal,
): Promise<PeriodogramLoad> {
  signal.throwIfAborted();
  if (
    curve.kind !== "ready" ||
    !curve.segments.some((segment) =>
      segment.flux.some((flux) => flux !== null),
    )
  )
    return {
      kind: "unavailable",
      selectionEnabled: false,
      reason: "curve-not-ready",
    };
  if (contextKey(curve.context) !== contextKey(expected.curveContext))
    throw new PeriodogramContextChanged();
  if (!expected.periodSelectionRules)
    return {
      kind: "unavailable",
      selectionEnabled: false,
      reason: "rules-unavailable",
    };
  async function read(resource: "periodogram" | "candidate-peaks") {
    let status = 0;
    let bundleId: string | null = null;
    try {
      const body = await request<unknown>(periodogramPath(expected, resource), {
        signal,
        onResponse: (response) => {
          status = response.status;
          bundleId = response.headers.get("X-Current-Bundle")?.trim() || null;
        },
      });
      signal.throwIfAborted();
      if (bundleId && bundleId !== expected.curveContext.bundleId)
        throw new PeriodogramContextChanged();
      return { body, status };
    } catch (error) {
      signal.throwIfAborted();
      if (
        (error instanceof ApiError &&
          error.status === 409 &&
          error.code === "BUNDLE_CHANGED") ||
        (status >= 200 &&
          status < 300 &&
          bundleId &&
          bundleId !== expected.curveContext.bundleId)
      )
        throw new PeriodogramContextChanged();
      throw error;
    }
  }
  const response = await read("periodogram");
  if (response.status === 202)
    return {
      kind: "unavailable",
      selectionEnabled: false,
      reason: "periodogram-not-ready",
      pending: decodePendingPeriodogram(response.body, expected),
    };
  const periodogram = decodePeriodogram(response.body, expected);
  const peaks = await read("candidate-peaks");
  if (peaks.status !== 200)
    throw new Error("봉우리 응답이 준비되지 않았습니다. 다시 불러와 주세요.");
  const candidates = decodeCandidatePeaks(peaks.body, expected, periodogram);
  signal.throwIfAborted();
  if (!candidates.peaks.length)
    return {
      kind: "unavailable",
      selectionEnabled: false,
      reason: "empty-peaks",
    };
  return {
    kind: "ready",
    selectionEnabled: true,
    periodogram,
    candidates,
    rules: expected.periodSelectionRules,
  };
}
