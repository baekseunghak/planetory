// Entry. Picks one app before anything renders; see ./ui-choice.ts.
// - VITE_CINEMA="true" (npm run dev:cinema) / "false" at build time forces the
//   cinema shell (./main-cinema.tsx) / develop's app (./legacy/main.tsx). The
//   literal conditions let such a build drop the other app entirely.
// - Unset (the production image): develop's app unless this browser opted
//   in with ?ui=cinema (remembered; ?ui=legacy forgets it). Both apps are
//   dynamic imports, so a visit loads one app's chunks and CSS only.
import { chooseUiForPage } from "./ui-choice";

if (import.meta.env.VITE_CINEMA === "true") void import("./main-cinema");
else if (import.meta.env.VITE_CINEMA === "false") void import("./legacy/main");
else if (chooseUiForPage(import.meta.env.VITE_CINEMA) === "cinema")
  void import("./main-cinema");
else void import("./legacy/main");
