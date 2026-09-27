import { useEffect, useLayoutEffect, useRef } from "react";
import { usePageContext } from "../../app/usePageContext";
import { AnalysisPage } from "../../features/analysis/AnalysisPage";
import { emitAnalysis } from "../analysis/bridge";
import { useScene } from "../scene/contract";
import { ClassicBridgeScope } from "./classic-bridge";
import "../styles/tokens.css";
import "./classic-analysis.css";

const PANEL_HEIGHT = "--pc-analysis-panel-height";
/** The shell's top bar sits over the scene; the star is framed below it. */
const TOP_BAR = 56;

/**
 * Variant A: the existing analysis screen (AnalysisPage and everything under
 * it, unchanged) in a bottom panel over the scene.
 *
 * - Presentation only: ./classic-analysis.css restyles the page under
 *   `.pc-classic-analysis` with the cinema tokens and lays it out for a panel
 *   of at most 60% of the viewport height, so the focused star stays visible
 *   above it.
 * - Bridge: `sessionChanged` from here; period, window, stage, submitted,
 *   outcome and submitFailed from the screen's own state through
 *   ./classic-bridge (a few lines in src/features/analysis, active only inside
 *   <ClassicBridgeScope>).
 * - Scene: reports the panel height with `setViewInset({ bottom })` so the
 *   engine centres the star in the area left above the panel.
 */
export function ClassicAnalysis() {
  const { ticId } = usePageContext();
  const scene = useScene();
  const panel = useRef<HTMLDivElement>(null);

  // Layout effect: the session opens before any child emits (children emit
  // from passive effects) and closes as the panel leaves.
  useLayoutEffect(() => {
    if (!ticId) return;
    emitAnalysis("sessionChanged", { ticId, active: true });
    return () => emitAnalysis("sessionChanged", { ticId, active: false });
  }, [ticId]);

  // The panel height is the scene's bottom inset, and a CSS variable for HUD
  // pieces that must clear the panel (the variant toggle).
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const root = document.documentElement.style;
    let reported = -1;
    const report = () => {
      const bottom = Math.round(element.getBoundingClientRect().height);
      if (bottom === reported) return;
      reported = bottom;
      root.setProperty(PANEL_HEIGHT, `${bottom}px`);
      scene.setViewInset({ top: TOP_BAR, right: 0, bottom, left: 0 });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.removeProperty(PANEL_HEIGHT);
      scene.setViewInset({ top: 0, right: 0, bottom: 0, left: 0 });
    };
  }, [scene]);

  return (
    <ClassicBridgeScope>
      <div
        ref={panel}
        className="pc-classic-analysis"
        data-analysis-variant="classic"
      >
        <AnalysisPage />
      </div>
    </ClassicBridgeScope>
  );
}
