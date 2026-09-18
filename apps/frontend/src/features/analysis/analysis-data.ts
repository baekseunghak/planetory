import type { Btjd } from "../../shared/types.ts";
import {
  readSelectionContract,
  type SelectionContract,
} from "./selection-rules.ts";

export type CurveContext = {
  bundleId: string;
  curveStep: number;
  removedCandidateIds: string[];
  residualModelVersion: string;
  periodogramConfigVersion: string;
};
export type AnalysisContext = {
  ticId: string;
  sectors: number[];
  hasConfirmedCandidate: boolean;
  bundleVersion: string;
  foldReferenceTimeBtjd: Btjd;
  curveContext: CurveContext;
  periodSelectionRules?: { version: string; halfWidthCells: number };
  selectionContract: SelectionContract;
  notice?: "STEP_NOT_RESTORABLE";
};
export type CurveSegment = {
  segmentId: string;
  sector: number;
  binningRevision: string;
  startBtjd: Btjd;
  binMinutes: number;
  nPoints: number;
  flux: (number | null)[];
  fluxScatter: number;
  gaps: [number, number][];
};
export type CurveData =
  | {
      kind: "ready";
      context: CurveContext;
      fluxUnit: string;
      segments: CurveSegment[];
    }
  | { kind: "not-ready"; status: string | null; jobId: string | null };

function invalid(field: string): never {
  throw new Error(`분석 응답의 ${field} 항목을 확인해 주세요.`);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(field);
  return value;
}
function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
}
function integer(value: unknown, field: string, minimum = 0): number {
  const result = number(value, field);
  if (!Number.isSafeInteger(result) || result < minimum) invalid(field);
  return result;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}
export function readCurveContext(value: unknown): CurveContext {
  const data = record(value, "curveContext");
  const removed = array(data.removedCandidateIds, "removedCandidateIds")
    .map((id) => text(id, "removedCandidateIds"))
    .sort();
  if (new Set(removed).size !== removed.length) invalid("removedCandidateIds");
  const curveStep = integer(data.curveStep, "curveStep");
  if (curveStep !== removed.length) invalid("curveStep/removedCandidateIds");
  return {
    bundleId: text(data.bundleId, "bundleId"),
    curveStep,
    removedCandidateIds: removed,
    residualModelVersion: text(
      data.residualModelVersion,
      "residualModelVersion",
    ),
    periodogramConfigVersion: text(
      data.periodogramConfigVersion,
      "periodogramConfigVersion",
    ),
  };
}
export function contextKey(context: CurveContext): string {
  return JSON.stringify([
    context.bundleId,
    context.curveStep,
    [...context.removedCandidateIds].sort(),
    context.residualModelVersion,
    context.periodogramConfigVersion,
  ]);
}
export function decodeAnalysisContext(
  value: unknown,
  ticId: string,
): AnalysisContext {
  const data = record(value, "analysis-context");
  if (text(data.ticId, "ticId") !== ticId) invalid("ticId");
  const star = record(data.star, "star");
  const sectors = array(star.sectors, "sectors").map((sector) =>
    integer(sector, "sector", 1),
  );
  if (
    new Set(sectors).size !== sectors.length ||
    integer(star.sectorCount, "sectorCount") !== sectors.length
  )
    invalid("sectorCount/sectors");
  if (typeof data.hasConfirmedCandidate !== "boolean")
    invalid("hasConfirmedCandidate");
  const bundle = record(data.bundle, "bundle");
  const curveContext = readCurveContext(data.currentCurveContext);
  for (const field of [
    "bundleId",
    "residualModelVersion",
    "periodogramConfigVersion",
  ] as const)
    if (text(bundle[field], field) !== curveContext[field])
      invalid(`bundle/${field}`);
  // Keep only fields consumed here. Candidate answers and other unrelated data are not copied.
  const rules =
    data.selectionRules === undefined
      ? undefined
      : record(data.selectionRules, "selectionRules");
  const periodSelectionRules =
    rules === undefined
      ? undefined
      : {
          version: text(rules.version, "selectionRules.version"),
          halfWidthCells: integer(
            record(rules.fineTune, "fineTune").halfWidthCells,
            "halfWidthCells",
            1,
          ),
        };
  return {
    ticId,
    sectors,
    hasConfirmedCandidate: data.hasConfirmedCandidate,
    bundleVersion: text(bundle.bundleVersion, "bundleVersion"),
    foldReferenceTimeBtjd: number(
      bundle.foldReferenceTimeBtjd,
      "foldReferenceTimeBtjd",
    ) as Btjd,
    curveContext,
    selectionContract: readSelectionContract(
      data.selectionRules,
      bundle.observationBounds,
    ),
    ...(periodSelectionRules ? { periodSelectionRules } : {}),
    ...(record(data.currentCurveContext, "currentCurveContext").notice ===
    "STEP_NOT_RESTORABLE"
      ? ({ notice: "STEP_NOT_RESTORABLE" } as const)
      : {}),
  };
}
export function curvePath(context: AnalysisContext): string {
  const curve = context.curveContext;
  const query = new URLSearchParams({
    bundleId: curve.bundleId,
    curveStep: String(curve.curveStep),
  });
  if (curve.removedCandidateIds.length)
    query.set("removed", curve.removedCandidateIds.join(","));
  return `/v1/stars/${encodeURIComponent(context.ticId)}/curves?${query}`;
}
function readSegment(value: unknown): CurveSegment {
  const data = record(value, "segment");
  const nPoints = integer(data.nPoints, "nPoints", 1);
  const binMinutes = number(data.binMinutes, "binMinutes");
  const fluxScatter = number(data.fluxScatter, "fluxScatter");
  if (binMinutes <= 0 || fluxScatter < 0) invalid("binMinutes/fluxScatter");
  const flux = array(data.flux, "flux").map((point) =>
    point === null ? null : number(point, "flux"),
  );
  if (flux.length !== nPoints) invalid("nPoints/flux.length");
  const gaps = array(data.gaps, "gaps").map((value): [number, number] => {
    const pair = array(value, "gaps");
    if (pair.length !== 2) invalid("gaps");
    const start = integer(pair[0], "gaps.start"),
      end = integer(pair[1], "gaps.end");
    if (start > end || end >= nPoints) invalid("gaps");
    for (let i = start; i <= end; i++)
      if (flux[i] !== null) invalid("gaps/flux");
    return [start, end];
  });
  const startBtjd = number(data.startBtjd, "startBtjd") as Btjd;
  if (!Number.isFinite(startBtjd + (binMinutes / 1440) * (nPoints - 1)))
    invalid("time range");
  return {
    segmentId: text(data.segmentId, "segmentId"),
    sector: integer(data.sector, "sector", 1),
    binningRevision: text(data.binningRevision, "binningRevision"),
    startBtjd,
    binMinutes,
    nPoints,
    flux,
    fluxScatter,
    gaps,
  };
}
/**
 * 곡선 (5.2절). 잔차가 준비되지 않았으면 서버는 HTTP 202에 같은 본문 구조를 두고
 * segments만 null로 보낸다. 본문에 code 필드는 없으므로 상태 코드로 판정한다.
 */
export function decodeCurve(
  value: unknown,
  expected: AnalysisContext,
  status: number,
): CurveData {
  const data = record(value, "curves");
  const residual = record(data.residual, "residual");
  if (status === 202) {
    if (data.segments !== null) invalid("pending curve segments");
    if (expected.curveContext.curveStep === 0) invalid("original curve status");
    const jobStatus =
      residual.status === null
        ? null
        : text(residual.status, "residual.status");
    const jobId =
      residual.jobId === null ? null : text(residual.jobId, "residual.jobId");
    if (
      (jobStatus === null) !== (jobId === null) ||
      (jobStatus !== null &&
        ![
          "QUEUED",
          "RESIDUAL_CALCULATING",
          "RESIDUAL_READY",
          "PERIODOGRAM_CALCULATING",
          "FAILED",
        ].includes(jobStatus))
    )
      invalid("residual.status/jobId");
    return { kind: "not-ready", status: jobStatus, jobId };
  }
  const context = readCurveContext(data.curveContext);
  if (
    text(data.ticId, "ticId") !== expected.ticId ||
    text(data.bundleId, "bundleId") !== context.bundleId ||
    contextKey(context) !== contextKey(expected.curveContext)
  )
    invalid("curveContext mismatch");
  if (
    number(data.foldReferenceTimeBtjd, "foldReferenceTimeBtjd") !==
    expected.foldReferenceTimeBtjd
  )
    invalid("foldReferenceTimeBtjd mismatch");
  if (residual.status !== "COMPLETED") invalid("residual.status");
  const segments = array(data.segments, "segments").map(readSegment);
  if (
    new Set(segments.map((segment) => segment.segmentId)).size !==
    segments.length
  )
    invalid("segmentId");
  for (let i = 0; i < segments.length; i++) {
    if (
      !expected.sectors.includes(segments[i].sector) ||
      (i > 0 && segments[i - 1].sector > segments[i].sector)
    )
      invalid("segment sector");
  }
  return {
    kind: "ready",
    context,
    fluxUnit: text(data.fluxUnit, "fluxUnit"),
    segments,
  };
}
