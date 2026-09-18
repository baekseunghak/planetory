import { createContext, useContext, type ComponentType } from "react";
import {
  invalidMaterial,
  materialObject,
  materialText,
} from "../community/materialContracts";

// Shared DTO mirrors exploration-api-spec.md 5.2/8.3. No separate public array format.
export type GraphMode = "CURRENT" | "SUBMITTED";
export type HistoryGraphDto = Record<string, unknown> & {
  historyId: string;
  reproduction: Record<string, unknown> & {
    submittedBundleId: string;
    currentBundleId: string;
    residualReproducible: boolean;
    fallbackReason: string | null;
  };
  selection: Record<string, unknown>;
  curve:
    | (Record<string, unknown> & {
        bundleId: string;
        segments: unknown[] | null;
        residual?: { status: string | null; jobId: string | null };
        curveContext: Record<string, unknown>;
      })
    | null;
  snapshot: {
    bins: number;
    foldedFlux: (number | null)[];
    foldedError: (number | null)[];
  } | null;
};
export type HistoryGraphProps = {
  graph: HistoryGraphDto;
  mode: GraphMode;
  readOnly: true;
};
export const HistoryGraphRenderer =
  createContext<ComponentType<HistoryGraphProps> | null>(null);
export function SharedHistoryGraph(props: HistoryGraphProps) {
  const Renderer = useContext(HistoryGraphRenderer);
  return Renderer ? (
    <Renderer {...props} />
  ) : (
    <p className="material-empty" role="status">
      자료를 불러왔습니다. 공용 그래프 화면은 연결 준비 중입니다.
    </p>
  );
}
export function readHistoryGraph(
  value: unknown,
  id: string,
  ticId: string,
  mode: GraphMode,
): HistoryGraphDto {
  const g = materialObject(value),
    r = materialObject(g.reproduction);
  materialObject(g.selection);
  if (
    g.historyId !== id ||
    typeof r.residualReproducible !== "boolean" ||
    (r.fallbackReason !== null && typeof r.fallbackReason !== "string")
  )
    return invalidMaterial();
  materialText(r.currentBundleId);
  materialText(r.submittedBundleId);
  if (
    (mode === "CURRENT" && g.snapshot !== null) ||
    (mode === "SUBMITTED" && g.curve !== null)
  )
    return invalidMaterial();
  if (g.curve !== null) {
    const c = materialObject(g.curve),
      ctx = materialObject(c.curveContext);
    if (
      c.ticId !== ticId ||
      c.bundleId !== r.currentBundleId ||
      ctx.bundleId !== c.bundleId ||
      (c.segments !== null && !Array.isArray(c.segments))
    )
      return invalidMaterial();
    if (c.residual) {
      const residual = materialObject(c.residual);
      if (
        residual.status !== null &&
        ![
          "QUEUED",
          "RESIDUAL_CALCULATING",
          "RESIDUAL_READY",
          "PERIODOGRAM_CALCULATING",
          "COMPLETED",
          "FAILED",
        ].includes(String(residual.status))
      )
        return invalidMaterial();
      if (residual.jobId !== null) materialText(residual.jobId);
      if (residual.status === null && residual.jobId !== null)
        return invalidMaterial();
    }
    if (Array.isArray(c.segments))
      for (const value of c.segments) {
        const s = materialObject(value);
        if (
          !Number.isSafeInteger(s.nPoints) ||
          !Array.isArray(s.flux) ||
          s.flux.length !== s.nPoints ||
          s.flux.some(
            (v) => v !== null && (typeof v !== "number" || !Number.isFinite(v)),
          )
        )
          return invalidMaterial();
      }
  }
  if (g.snapshot !== null) {
    const s = materialObject(g.snapshot);
    if (
      s.bins !== 150 ||
      !Array.isArray(s.foldedFlux) ||
      !Array.isArray(s.foldedError) ||
      s.foldedFlux.length !== 150 ||
      s.foldedError.length !== 150 ||
      [...s.foldedFlux, ...s.foldedError].some(
        (v) => v !== null && (typeof v !== "number" || !Number.isFinite(v)),
      )
    )
      return invalidMaterial();
  }
  return g as HistoryGraphDto;
}
export const isGraphPending = (g: HistoryGraphDto) =>
  !!g.curve?.residual?.jobId &&
  [
    "QUEUED",
    "RESIDUAL_CALCULATING",
    "RESIDUAL_READY",
    "PERIODOGRAM_CALCULATING",
  ].includes(g.curve.residual.status ?? "");
