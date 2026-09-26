// One scene for the whole app. SceneProvider and the canvas sit above every
// route (login included), so screens change by moving the camera, not by
// mounting a new map.
import { useEffect, useState, type ReactNode } from "react";
import "../styles/fonts";
import "../styles/tokens.css";
import "./shell.css";
import { SceneCanvas, SceneProvider, useSceneState } from "../scene";
import { GalaxyArtwork } from "../../components/GalaxyArtwork";

export function CinemaRoot({ children }: { children: ReactNode }) {
  return (
    <SceneProvider>
      <SceneStage />
      {children}
    </SceneProvider>
  );
}

/** Delay before a still illustration stands in for a scene that is not up. */
const FALLBACK_DELAY_MS = 700;

function SceneStage() {
  const state = useSceneState();
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
