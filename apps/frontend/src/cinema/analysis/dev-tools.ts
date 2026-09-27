/**
 * Developer tools in the cinema analysis (the "기존형 / 새 디자인" toggle, the
 * fold renderer switch). Off unless a dev server is started with an explicit
 * `VITE_CINEMA_DEV_TOOLS=true`; `npm run dev:cinema` (the demo server) and
 * every build leave it off, so members never see the toggle.
 */
export const cinemaDevTools: boolean =
  import.meta.env.DEV && import.meta.env.VITE_CINEMA_DEV_TOOLS === "true";

/**
 * The classic variant instead of the new design: only when the build defines
 * VITE_CINEMA_ANALYSIS="classic" (`CINEMA_ANALYSIS=classic npm run
 * dev:cinema`). Unset, as in production builds, every member gets the new
 * design (variant B). A literal comparison, so a build without it leaves the
 * classic variant's code out of the bundle (its stylesheet stays, scoped to
 * `.pc-classic-analysis`; the same rule as ./variant.ts
 * `analysisVariantFromBuild`).
 */
export const cinemaAnalysisClassic: boolean =
  import.meta.env.VITE_CINEMA_ANALYSIS === "classic";
