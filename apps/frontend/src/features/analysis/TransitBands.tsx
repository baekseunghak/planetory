import { useLayoutEffect, useMemo, useRef } from "react";
import { useCurrentPhasePreview } from "./AnalysisSession";
import { projectTransitBands } from "./transit-bands";
import type { TimeCurve } from "./time-curve";

export function TransitBands({
  curve,
  low,
  high,
  size,
}: {
  curve: TimeCurve;
  low: number;
  high: number;
  size: { width: number; height: number; dpr: number };
}) {
  const preview = useCurrentPhasePreview();
  const canvas = useRef<HTMLCanvasElement>(null);
  const projection = useMemo(() => {
    if (!preview) return { bands: [], error: "" };
    try {
      return {
        bands: projectTransitBands(
          curve,
          { ...preview, periodDays: preview.selection.periodDays },
          low,
          high,
        ),
        error: "",
      };
    } catch (error) {
      return { bands: [], error: (error as Error).message };
    }
  }, [curve, preview, low, high]);
  useLayoutEffect(() => {
    const element = canvas.current!;
    const ctx = element.getContext("2d");
    if (!ctx || size.width <= 0 || size.height <= 0) return;
    const width = Math.round(size.width * size.dpr),
      height = Math.round(size.height * size.dpr);
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.fillStyle = "rgba(255,211,105,0.12)";
    for (const band of projection.bands) {
      const x = ((band.xStart - low) / (high - low)) * size.width;
      ctx.fillRect(
        x,
        0,
        ((band.xEnd - band.xStart) / (high - low)) * size.width,
        size.height,
      );
    }
  }, [projection, size, low, high]);
  return (
    <>
      <canvas
        ref={canvas}
        className="analysis-transit-bands"
        aria-hidden="true"
        data-testid="transit-bands"
        data-band-count={projection.bands.length}
        data-period={preview?.selection.periodDays}
        data-epoch={preview?.epochPreviewBtjd}
        data-duration={preview?.durationPreviewDays}
      />
      {(projection.error || (preview && projection.bands.length === 0)) && (
        <span role="status" className="analysis-transit-error">
          {projection.error || "현재 보이는 관측 구간에는 예상 띠가 없습니다."}
        </span>
      )}
    </>
  );
}
