/**
 * Developer tools in the cinema analysis (the "기존형 / 새 디자인" toggle, the
 * fold renderer switch). Off unless a dev server is started with an explicit
 * `VITE_CINEMA_DEV_TOOLS=true`; `npm run dev:cinema` (the demo server) and
 * every build leave it off, so members only ever see the classic variant.
 */
export const cinemaDevTools: boolean =
  import.meta.env.DEV && import.meta.env.VITE_CINEMA_DEV_TOOLS === "true";
