import { useCallback, useState, type ComponentType } from "react";
import { ClassicAnalysis } from "../analysis-classic";
import { CinematicAnalysis } from "../analysis-new";
import "./analysis-switch.css";

// Route element for /analysis/:ticId. Both variants read the route themselves
// (usePageContext) and emit the same bridge events (./bridge).

export type AnalysisVariant = "classic" | "cinematic";
export const ANALYSIS_VARIANT_KEY = "planetory:analysis-variant";
export const DEFAULT_ANALYSIS_VARIANT: AnalysisVariant = "classic";

const variants: Record<AnalysisVariant, ComponentType> = {
  classic: ClassicAnalysis,
  cinematic: CinematicAnalysis,
};

export function readAnalysisVariant(): AnalysisVariant {
  try {
    const value = localStorage.getItem(ANALYSIS_VARIANT_KEY);
    return value === "classic" || value === "cinematic"
      ? value
      : DEFAULT_ANALYSIS_VARIANT;
  } catch {
    return DEFAULT_ANALYSIS_VARIANT;
  }
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
 */
export function AnalysisSwitch({
  toggleClassName,
}: {
  toggleClassName?: string;
}) {
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
