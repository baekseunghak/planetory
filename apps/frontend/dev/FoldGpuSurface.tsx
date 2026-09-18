import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  FoldCanvasSurface,
  type DevFoldSurfaceProps,
} from "../src/features/analysis/FoldCanvasSurface";
import { FoldWebglRenderer } from "./fold-webgl-renderer";

// Development-only integration. Failure is sticky until this surface is remounted.
export default function FoldGpuSurface(props: DevFoldSurfaceProps) {
  const { data, domain, result, size, view, onStatus } = props;
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<FoldWebglRenderer | null>(null);
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => {
    setFailed(true);
    onStatus("fallback");
  }, [onStatus]);
  useLayoutEffect(() => {
    if (failed) return;
    // StrictMode's effect replay also gets a fresh context after disposal.
    const element = document.createElement("canvas");
    element.setAttribute("aria-hidden", "true");
    element.dataset.renderer = "webgl";
    host.current!.append(element);
    const lost = (event: Event) => {
      event.preventDefault();
      fail();
    };
    element.addEventListener("webglcontextlost", lost);
    let active: FoldWebglRenderer | null = null;
    try {
      active = new FoldWebglRenderer(
        element,
        Float32Array.from(
          data.points,
          (p) => (p.flux - domain[0]) / (domain[1] - domain[0]),
        ),
        1,
      );
      renderer.current = active;
    } catch {
      fail();
    }
    return () => {
      element.removeEventListener("webglcontextlost", lost);
      if (renderer.current === active) renderer.current = null;
      active?.dispose();
      element.remove();
    };
  }, [data, domain, failed, fail]);
  useLayoutEffect(() => {
    if (failed || !renderer.current || size.width <= 0 || size.height <= 0)
      return;
    try {
      renderer.current.resize(size.width, size.height, size.dpr);
      renderer.current.draw(result.phases, view);
      onStatus("webgl");
    } catch {
      fail();
    }
  }, [
    data,
    domain,
    result,
    size,
    view.zoom,
    view.center,
    failed,
    fail,
    onStatus,
  ]);
  // A WebGL canvas cannot acquire a 2D context; mount a different element on failure.
  return failed ? (
    <FoldCanvasSurface {...props} />
  ) : (
    <div ref={host} className="fold-gpu-surface" />
  );
}
