import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { api } from "../../api";
import type {
  AnalysisContext,
  CurveData,
} from "../../features/analysis/analysis-data";
import { loadPeriodogram } from "../../features/analysis/load-periodogram";
import { PeriodogramBundleChanged } from "../../features/analysis/periodogram-data";
import { useScene } from "../scene/contract";
import type { CanvasSize } from "./draw";
import type { PeriodogramLoadState } from "./model";

/** Element size in CSS px and the device pixel ratio, kept current. */
export function useElementSize(ref: RefObject<HTMLElement | null>): CanvasSize {
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0, dpr: 1 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      setSize((previous) =>
        previous.width === rect.width &&
        previous.height === rect.height &&
        previous.dpr === dpr
          ? previous
          : { width: rect.width, height: rect.height, dpr },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    let resolution: MediaQueryList | null = null;
    const change = () => {
      measure();
      watch();
    };
    const watch = () => {
      resolution?.removeEventListener("change", change);
      resolution = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      resolution.addEventListener("change", change);
    };
    measure();
    watch();
    return () => {
      observer.disconnect();
      resolution?.removeEventListener("change", change);
    };
  }, [ref]);
  return size;
}

/**
 * The classic PeriodogramPanel's loading, without its screen: no cached
 * result, a Bundle change goes back to the page (recoverBundle), anything
 * else is an error the member can retry.
 */
export function usePeriodogram(
  context: AnalysisContext,
  curve: CurveData,
  recoverBundle: () => boolean,
) {
  const [state, setState] = useState<PeriodogramLoadState>({
    kind: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    loadPeriodogram(api, context, curve, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ kind: "loaded", data });
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        if (error instanceof PeriodogramBundleChanged && recoverBundle()) {
          setState({ kind: "loading" });
          return;
        }
        setState({ kind: "error", error });
      });
    return () => controller.abort();
  }, [context, curve, attempt, recoverBundle]);
  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((value) => value + 1);
  }, []);
  return { state, retry };
}

/**
 * Tells the scene how much of the canvas the panel covers, so the focused
 * star stays in the visible part. Cleared when the panel leaves.
 *
 * While the shell has stepped the panel aside (an inert / aria-hidden stage,
 * e.g. during a transit) the shell owns the inset, so a resize of the hidden
 * panel (the result arriving) is not reported.
 */
export function usePanelInset(ref: RefObject<HTMLElement | null>) {
  const scene = useScene();
  const last = useRef(-1);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      if (element.closest('[inert], [aria-hidden="true"]')) {
        last.current = -1;
        return;
      }
      const rect = element.getBoundingClientRect();
      const bottom = Math.max(0, Math.round(window.innerHeight - rect.top));
      if (bottom === last.current) return;
      last.current = bottom;
      scene.setViewInset({ bottom, right: 0 });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      last.current = -1;
      scene.setViewInset({ bottom: 0, right: 0 });
    };
  }, [ref, scene]);
}
