import { useCallback, useState, type ComponentType } from "react";
import { ClassicAnalysis } from "../analysis-classic";
import { CinematicAnalysis } from "../analysis-new";
import { cinemaAnalysisClassic, cinemaDevTools } from "./dev-tools";
import {
  ANALYSIS_VARIANT_KEY,
  planAnalysisVariant,
  type AnalysisVariant,
} from "./variant";
import "./analysis-switch.css";

// Route element for /analysis/:ticId. Both variants read the route themselves
// (usePageContext) and emit the same bridge events (./bridge).

export type { AnalysisVariant };
export { ANALYSIS_VARIANT_KEY };
/** The build's variant (VITE_CINEMA_ANALYSIS, the new design unless "classic"). */
export const DEFAULT_ANALYSIS_VARIANT: AnalysisVariant = cinemaAnalysisClassic
  ? "classic"
  : "cinematic";

const variants: Record<AnalysisVariant, ComponentType> = {
  classic: ClassicAnalysis,
  cinematic: CinematicAnalysis,
};

function readStored(): string | null {
  try {
    return localStorage.getItem(ANALYSIS_VARIANT_KEY);
  } catch {
    return null;
  }
}

/** The toggle's current choice (developer tools): stored, else the build's. */
export function readAnalysisVariant(): AnalysisVariant {
  return planAnalysisVariant({
    build: cinemaAnalysisClassic ? "classic" : undefined,
    devTools: true,
    stored: readStored(),
  }).variant;
}

export function writeAnalysisVariant(value: AnalysisVariant): void {
  try {
    localStorage.setItem(ANALYSIS_VARIANT_KEY, value);
  } catch {
    /* Storage blocked: the choice lasts for this page only. */
  }
}

export function useAnalysisVariant(): [
  AnalysisVariant,
  (value: AnalysisVariant) => void,
] {
  const [variant, setVariant] = useState(readAnalysisVariant);
  const choose = useCallback((value: AnalysisVariant) => {
    writeAnalysisVariant(value);
    setVariant(value);
  }, []);
  return [variant, choose];
}

export function AnalysisVariantToggle({
  value,
  onChange,
  className = "analysis-variant-toggle",
}: {
  value: AnalysisVariant;
  onChange(value: AnalysisVariant): void;
  className?: string;
}) {
  return (
    <div className={className} role="group" aria-label="분석 화면 디자인">
      {(
        [
          ["classic", "기존형"],
          ["cinematic", "새 디자인"],
        ] as const
      ).map(([option, label]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Switching remounts the analysis. Drafts survive (session draft storage) and
 * an in-flight submission keeps its request ID for recovery, as on reload.
 *
 * Members get the build's variant (./variant.ts: the new design unless the
 * build defines VITE_CINEMA_ANALYSIS=classic) and no toggle: the team chose
 * the new design. The toggle (and a stored choice) only count on a dev
 * server started with VITE_CINEMA_DEV_TOOLS=true (./dev-tools.ts).
 */
export function AnalysisSwitch({
  toggleClassName,
}: {
  toggleClassName?: string;
}) {
  // Both flags are build constants, so a production build keeps neither the
  // toggle nor the variant it does not show. A choice a member's browser may
  // hold from an earlier dev session is never read here.
  if (cinemaDevTools)
    return <DevAnalysisSwitch toggleClassName={toggleClassName} />;
  return cinemaAnalysisClassic ? (
    <ClassicAnalysis key="classic" />
  ) : (
    <CinematicAnalysis key="cinematic" />
  );
}

function DevAnalysisSwitch({ toggleClassName }: { toggleClassName?: string }) {
  const [variant, setVariant] = useAnalysisVariant();
  const Variant = variants[variant];
  return (
    <>
      <AnalysisVariantToggle
        value={variant}
        onChange={setVariant}
        className={toggleClassName}
      />
      <Variant key={variant} />
    </>
  );
}
