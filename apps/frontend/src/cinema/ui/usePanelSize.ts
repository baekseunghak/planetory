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
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      latest.current(0);
    };
  }, [ref, edge]);
}
