// Which analysis screen the cinema app shows on /analysis/:ticId. Pure (no
// import.meta.env, no React) so tests/unit/cinema-analysis-variant.test.ts can
// run it; ./dev-tools.ts reads the build values and ./AnalysisSwitch.tsx
// renders the plan.
//
// - Build define VITE_CINEMA_ANALYSIS: "new" = the new design (variant B,
//   ../analysis-new) for every member, with no toggle. Anything else, and a
//   build without the variable (production), is the classic variant.
//   `npm run dev:cinema` defines it from CINEMA_ANALYSIS (classic by default).
// - The "기존형 / 새 디자인" toggle is a developer tool only
//   (VITE_CINEMA_DEV_TOOLS on a dev server). There the stored choice wins and
//   the build variant is only the starting value.

export type AnalysisVariant = "classic" | "cinematic";

export const ANALYSIS_VARIANT_KEY = "planetory:analysis-variant";

/**
 * VITE_CINEMA_ANALYSIS as a variant: exactly "new" selects the new design
 * (the demo server normalizes CINEMA_ANALYSIS before defining it).
 */
export function analysisVariantFromBuild(
  value: string | boolean | undefined | null,
): AnalysisVariant {
  return value === "new" || value === true ? "cinematic" : "classic";
}

/** A stored toggle choice, or null when there is none or it is unknown. */
export function parseAnalysisVariant(
  value: string | null | undefined,
): AnalysisVariant | null {
  return value === "classic" || value === "cinematic" ? value : null;
}

export type AnalysisVariantPlan = {
  /** The variant to mount first. */
  variant: AnalysisVariant;
  /** Show the "기존형 / 새 디자인" toggle (developer tools only). */
  toggle: boolean;
};

/**
 * Members get the build's variant and never a toggle, whatever is stored.
 * With developer tools on, a stored choice wins over the build's variant and
 * the toggle is shown.
 */
export function planAnalysisVariant({
  build,
  devTools,
  stored,
}: {
  /** VITE_CINEMA_ANALYSIS, or whether it is "new". */
  build: string | boolean | undefined | null;
  devTools: boolean;
  stored: string | null | undefined;
}): AnalysisVariantPlan {
  const fromBuild = analysisVariantFromBuild(build);
  if (!devTools) return { variant: fromBuild, toggle: false };
  return { variant: parseAnalysisVariant(stored) ?? fromBuild, toggle: true };
}
