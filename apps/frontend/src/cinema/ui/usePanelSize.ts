import { useEffect, useRef, type RefObject } from "react";

/**
 * Reports how much of the viewport a fixed panel covers from one edge, in CSS
 * px, whenever its box changes. 0 when the panel is gone.
 */
export function usePanelCover(
  ref: RefObject<HTMLElement | null>,
  edge: "right" | "bottom",
  report: (px: number) => void,
) {
  const latest = useRef(report);
  latest.current = report;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const cover =
        rect.width < 1 || rect.height < 1
          ? 0
          : edge === "right"
            ? Math.max(0, window.innerWidth - rect.left)
            : Math.max(0, window.innerHeight - rect.top);
      latest.current(Math.round(cover));
    };
    measure();
    // Transforms change the covered area without triggering ResizeObserver.
    // Sample the rendered edge while the panel itself is moving.
    let frame = 0;
    const motions = new Set<string>();
    const track = () => {
      measure();
      frame = motions.size ? requestAnimationFrame(track) : 0;
    };
    const motionKey = (event: TransitionEvent | AnimationEvent) =>
      "propertyName" in event ? `transition:${event.propertyName}` : `animation:${event.animationName}`;
    const start = (event: TransitionEvent | AnimationEvent) => {
      if (event.target !== node) return;
      motions.add(motionKey(event));
      if (!frame) frame = requestAnimationFrame(track);
    };
    const finish = (event: TransitionEvent | AnimationEvent) => {
      if (event.target !== node) return;
      motions.delete(motionKey(event));
      measure();
    };
    node.addEventListener("transitionrun", start);
    node.addEventListener("transitionend", finish);
    node.addEventListener("transitioncancel", finish);
    node.addEventListener("animationstart", start);
    node.addEventListener("animationend", finish);
    node.addEventListener("animationcancel", finish);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("transitionrun", start);
      node.removeEventListener("transitionend", finish);
      node.removeEventListener("transitioncancel", finish);
      node.removeEventListener("animationstart", start);
      node.removeEventListener("animationend", finish);
      node.removeEventListener("animationcancel", finish);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      latest.current(0);
    };
  }, [ref, edge]);
}
