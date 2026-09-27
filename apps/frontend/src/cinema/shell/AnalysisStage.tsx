// /analysis/:ticId: the star system stays on screen and the analysis variant
// sits over it in its own bottom panel (each variant lays out and reports its
// panel; see analysis-classic / analysis-new). The shell only steps the panel
// aside for a discovery (transit, card) and brings it back unchanged: the
// variant stays mounted the whole time.
import { useContext, useMemo, type ReactNode } from "react";
import { ModalHoldContext } from "../../features/analysis/use-modal-dialog";
import { OnboardingLookContext } from "../../features/onboarding/Onboarding";
import { AnalysisSwitch } from "../analysis/AnalysisSwitch";
import { useShell } from "./context";
import { TutorialGuideView, useTutorialGuide } from "./TutorialGuide";
import "./analysis-stage.css";

/** Route element for `analysis`: the two-variant switch, toggle in the HUD. */
export function CinemaAnalysis() {
  return <AnalysisSwitch toggleClassName="cinema-variant-toggle" />;
}

export const ANALYSIS_STAGE_CLASS = "cinema-analysis-stage";

export function AnalysisStage({ children }: { children: ReactNode }) {
  const { sequence, target } = useShell();
  const away = sequence.phase !== "idle";
  // One guide at a time: this star's tutorial line wins over the generic
  // onboarding line inside the variant (its steps are what the line says).
  const guide = useTutorialGuide(target.ticId, "analysis");
  const outer = useContext(OnboardingLookContext);
  const guideShown = !!guide;
  const look = useMemo(
    () => (outer ? { ...outer, hidden: outer.hidden || guideShown } : null),
    [outer, guideShown],
  );
  // While away, the variant's modal dialogs (the classic result) are held
  // closed: a modal in the top layer escapes `inert` and would keep focus
  // and working buttons behind the transit. They reopen unchanged.
  return (
    <ModalHoldContext.Provider value={away}>
      <OnboardingLookContext.Provider value={look}>
        <div
          className={ANALYSIS_STAGE_CLASS}
          data-away={away ? "true" : "false"}
          aria-hidden={away || undefined}
          inert={away}
        >
          {children}
          {/* Anchored just above either variant's analysis panel. */}
          {guide && (
            <TutorialGuideView
              key={target.ticId}
              guide={guide}
              place="analysis"
            />
          )}
        </div>
      </OnboardingLookContext.Provider>
    </ModalHoldContext.Provider>
  );
}

/**
 * Height of the bottom panel a variant laid out inside the stage (the widest
 * fixed box resting on the bottom edge), so the shell can give the scene the
 * same inset the variant reports. 0 when there is none.
 */
export function analysisPanelCover(root: Element | null): number {
  if (!root) return 0;
  const width = window.innerWidth,
    height = window.innerHeight;
  let cover = 0;
  for (const node of root.querySelectorAll<HTMLElement>("*")) {
    const style = getComputedStyle(node);
    if (style.position !== "fixed") continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < width * 0.5 || rect.height < 40) continue;
    // Where the panel rests, not where a rise animation has it right now.
    let shift = 0;
    try {
      shift =
        style.transform && style.transform !== "none"
          ? new DOMMatrixReadOnly(style.transform).m42
          : 0;
    } catch {
      shift = 0;
    }
    const top = rect.top - shift;
    if (Math.abs(rect.bottom - shift - height) > 48) continue;
    cover = Math.max(cover, height - top);
  }
  return Math.round(Math.max(0, cover));
}
