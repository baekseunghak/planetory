// One scene for the whole app. SceneProvider and the canvas sit above every
// route (login included), so screens change by moving the camera, not by
// mounting a new map.
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import "../styles/fonts";
import "../styles/tokens.css";
import "./shell.css";
import { SceneCanvas, SceneProvider, useScene, useSceneState } from "../scene";
import { GalaxyArtwork } from "../../components/GalaxyArtwork";
import { CinemaWording } from "../../shared/cinema-wording";
import { readSceneEffects } from "./preferences";
import { cinemaTitle } from "./stage";

// Demo scenario switch: the dev:cinema server only (shell/demo). The literal
// condition lets a build drop the import.
const DemoSwitch =
  import.meta.env.DEV && import.meta.env.VITE_CINEMA_DEMO === "true"
    ? lazy(() => import("./demo/DemoSwitch"))
    : null;

export function CinemaRoot({ children }: { children: ReactNode }) {
  return (
    <SceneProvider>
      <SceneStage />
      <TabIdentity />
      {/* Cinema copy in the shared feature screens (src/shared/cinema-wording). */}
      <CinemaWording.Provider value={true}>{children}</CinemaWording.Provider>
      {DemoSwitch && (
        <Suspense fallback={null}>
          <DemoSwitch />
        </Suspense>
      )}
    </SceneProvider>
  );
}

// A small ringed planet for the browser tab (cinema only: the develop app
// keeps its page head as it is).
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<circle cx="16" cy="16" r="16" fill="#070a0f"/>' +
      '<circle cx="16" cy="16" r="6.5" fill="#f5c46a"/>' +
      '<ellipse cx="16" cy="16" rx="13" ry="4.6" fill="none" stroke="#5ec4f7" stroke-width="2" transform="rotate(-24 16 16)"/>' +
      "</svg>",
  );

/** Tab title per screen ("나의 은하 · Planetory") and the favicon. */
function TabIdentity() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    document.title = cinemaTitle(pathname, search);
  }, [pathname, search]);
  useEffect(() => {
    if (document.querySelector('link[rel="icon"]')) return;
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = FAVICON;
    document.head.append(link);
  }, []);
  return null;
}

/** Delay before a still illustration stands in for a scene that is not up. */
const FALLBACK_DELAY_MS = 700;

function SceneStage() {
  const state = useSceneState();
  const scene = useScene();
  // The member's '빛 효과' choice, once per controller (the proxy keeps it
  // for the engine). No choice: the scene's power tier decides.
  useEffect(() => {
    const choice = readSceneEffects();
    if (choice !== null) scene.setEffects(choice);
  }, [scene]);
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (state.ready) return;
    const timer = setTimeout(
      () => setLate(true),
      state.failed ? 0 : FALLBACK_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [state.ready, state.failed]);
  return (
    <div
      className="cinema-stage"
      data-mode={state.mode}
      data-ready={state.ready ? "true" : "false"}
    >
      <SceneCanvas />
      {/* Login only: while no scene is drawing (no engine, or still starting),
          a still, clearly decorative galaxy keeps the page from being empty. */}
      {late && state.mode === "intro" && !state.ready && (
        <div className="cinema-stage-still" aria-hidden="true">
          <GalaxyArtwork decorative />
        </div>
      )}
    </div>
  );
}
