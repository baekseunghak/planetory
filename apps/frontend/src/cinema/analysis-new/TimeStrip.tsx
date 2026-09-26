import { useLayoutEffect, useMemo, useRef } from "react";
import type { CurveSegment } from "../../features/analysis/analysis-data";
import { useCurrentPhasePreview } from "../../features/analysis/AnalysisSession";
import { buildTimeCurve } from "../../features/analysis/time-curve";
import { projectTransitBands } from "../../features/analysis/transit-bands";
import { drawStrip, prepareCanvas } from "./draw";
import { useElementSize } from "./hooks";

/**
 * Raw time curve as a thin strip. Once a valid window exists, the predicted
 * repeats of that window are shaded (classic TransitBands, read only).
 */
export function TimeStrip({
  segments,
  fluxUnit,
}: {
  segments: CurveSegment[];
  fluxUnit: string;
}) {
  const curve = useMemo(() => buildTimeCurve(segments), [segments]);
  const preview = useCurrentPhasePreview();
  const plot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useElementSize(plot);
  const projection = useMemo(() => {
    if (!preview) return { bands: [], error: "" };
    try {
      return {
        bands: projectTransitBands(
          curve,
          { ...preview, periodDays: preview.selection.periodDays },
          0,
          curve.width,
        ),
        error: "",
      };
    } catch (error) {
      return { bands: [], error: (error as Error).message };
    }
  }, [curve, preview]);
  useLayoutEffect(() => {
    const ctx = canvas.current && prepareCanvas(canvas.current, size);
    if (ctx) drawStrip(ctx, curve, size.width, size.height, projection.bands);
  }, [curve, size, projection]);
  const first = curve.segments[0]?.source.startBtjd;
  const lastSegment = curve.segments.at(-1)?.source;
  const last =
    lastSegment &&
    lastSegment.startBtjd +
      (lastSegment.nPoints * lastSegment.binMinutes) / 1440;
  return (
    <div className="cx-strip">
      <div className="cx-row">
        <span className="cx-sublabel">밝기 변화</span>
        <span className="cx-ro">
          {first !== undefined && last !== undefined
            ? `BTJD ${first.toFixed(1)} – ${last.toFixed(1)}`
            : ""}
          {preview ? ` · 예상 반복 ${projection.bands.length}회` : ""}
        </span>
      </div>
      <div
        ref={plot}
        className="cx-strip-plot"
        role="img"
        aria-label={`시간에 따른 밝기 변화. 관측점 ${curve.points.length.toLocaleString("ko-KR")}개, 밝기 단위 ${fluxUnit}.${preview ? ` 선택한 구간이 반복될 위치 ${projection.bands.length}곳을 표시합니다.` : ""}`}
        data-testid="cx-time-strip"
        data-band-count={projection.bands.length}
      >
        <canvas ref={canvas} aria-hidden="true" />
      </div>
      {projection.error && (
        <p className="cx-note" role="status">
          {projection.error}
        </p>
      )}
    </div>
  );
}
