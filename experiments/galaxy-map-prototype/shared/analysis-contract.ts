/** HIS-02: graph state is distinct from the sky-map camera. Null means not supplied. */
export interface PlotViewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}
export interface FoldingSettings {
  phaseOrigin: "bundle_reference";
  timeSystem: "BTJD";
  phaseOffset: number;
}
export interface AnalysisViewState {
  periodogramViewport: PlotViewport | null;
  folding: FoldingSettings | null;
}
export interface ReproductionState extends AnalysisViewState {
  schema: 1;
  /** Filled by the calculation service, never trusted from a submission form. */
  versions: Record<
    | "preprocessing"
    | "residual"
    | "periodogram"
    | "feature"
    | "ai"
    | "matching"
    | "external"
    | "folding",
    string | null
  >;
}
export function readAnalysisView(value: unknown): AnalysisViewState {
  if (value == null) return { periodogramViewport: null, folding: null };
  if (typeof value !== "object")
    throw new Error("분석 표시 설정을 확인해 주세요.");
  const v = value as Partial<AnalysisViewState>;
  const p = v.periodogramViewport;
  if (
    p != null &&
    (!Number.isFinite(p.xMin) ||
      !Number.isFinite(p.xMax) ||
      !Number.isFinite(p.yMin) ||
      !Number.isFinite(p.yMax) ||
      p.xMin >= p.xMax ||
      p.yMin >= p.yMax)
  )
    throw new Error("주기도 확대·이동 범위를 확인해 주세요.");
  const f = v.folding;
  if (
    f != null &&
    (f.phaseOrigin !== "bundle_reference" ||
      f.timeSystem !== "BTJD" ||
      !Number.isFinite(f.phaseOffset) ||
      f.phaseOffset < 0 ||
      f.phaseOffset >= 1)
  )
    throw new Error("위상 접기 설정을 확인해 주세요.");
  return {
    periodogramViewport: p
      ? { xMin: p.xMin, xMax: p.xMax, yMin: p.yMin, yMax: p.yMax }
      : null,
    folding: f
      ? {
          phaseOrigin: f.phaseOrigin,
          timeSystem: f.timeSystem,
          phaseOffset: f.phaseOffset,
        }
      : null,
  };
}
