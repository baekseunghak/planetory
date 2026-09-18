import { useLayoutEffect, useMemo, useRef } from "react";
import type { FoldData } from "./fold-data";
import type { FoldResult } from "./fold-client";
import { drawFoldedCurve, type FoldView } from "./folded-curve";

export type FoldSurfaceProps = {
  data: FoldData;
  result: FoldResult;
  domain: [number, number];
  view: FoldView;
  size: { width: number; height: number; dpr: number };
};
export type DevFoldSurfaceProps = FoldSurfaceProps & {
  onStatus: (status: "webgl" | "fallback") => void;
};

export function FoldCanvasSurface({
  data,
  result,
  domain,
  view,
  size,
}: FoldSurfaceProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const raster = useMemo(() => {
    if (data.points.length <= 2000) return undefined;
    const surface = document.createElement("canvas");
    surface.width = Math.max(1, Math.round(size.width * size.dpr));
    surface.height = Math.max(1, Math.round(size.height * size.dpr));
    const ctx = surface.getContext("2d");
    if (!ctx) return undefined;
    return {
      surface,
      ctx,
      image: ctx.createImageData(surface.width, surface.height),
      dpr: size.dpr,
    };
  }, [data.points.length, size.width, size.height, size.dpr]);
  useLayoutEffect(() => {
    const element = canvas.current!;
    if (size.width <= 0 || size.height <= 0) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const width = Math.round(size.width * size.dpr),
      height = Math.round(size.height * size.dpr);
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    drawFoldedCurve(
      ctx,
      data.points,
      result.phases,
      domain,
      view,
      size.width,
      size.height,
      raster,
    );
  }, [data, result, domain, view.zoom, view.center, size, raster]);
  return <canvas ref={canvas} aria-hidden="true" data-renderer="canvas" />;
}

export function UnavailableGpuSurface(props: DevFoldSurfaceProps) {
  useLayoutEffect(() => props.onStatus("fallback"), [props.onStatus]);
  return <FoldCanvasSurface {...props} />;
}
