/**
 * Developer tools in the cinema analysis (the "기존형 / 새 디자인" toggle, the
 * fold renderer switch). Off unless a dev server is started with an explicit
 * `VITE_CINEMA_DEV_TOOLS=true`; `npm run dev:cinema` (the demo server) and
 * every build leave it off, so members never see the toggle.
 */
export const cinemaDevTools: boolean =
  import.meta.env.DEV && import.meta.env.VITE_CINEMA_DEV_TOOLS === "true";

/**
 * The new design (variant B) for every member: the build defines
 * VITE_CINEMA_ANALYSIS="new" (`CINEMA_ANALYSIS=new npm run dev:cinema`).
 * Unset, as in production builds, it is the classic variant. A literal
 * comparison, so a build without it leaves variant B out of the bundle
 * (the same rule as ./variant.ts `analysisVariantFromBuild`).
 */
export const cinemaAnalysisNew: boolean =
  import.meta.env.VITE_CINEMA_ANALYSIS === "new";
