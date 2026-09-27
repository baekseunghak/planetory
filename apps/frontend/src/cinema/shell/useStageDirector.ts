// Route -> camera. One place issues flights so two screens never fight over
// the camera. Every step checks that it is still the latest request: scene
// promises resolve when superseded, and a stale follow-up must not run.
import { useEffect, useRef } from "react";
import type { SceneController, SceneMode } from "../scene";
import type { StageTarget } from "./stage";

const FOCUSED: ReadonlySet<SceneMode> = new Set([
  "system",
  "analysis",
  "transit",
]);

export async function directStage(
  scene: SceneController,
  target: StageTarget,
  options: {
    starLoaded: boolean;
    /** The fully loaded sky has no such star (locked or unknown TIC). */
    starMissing?: boolean;
    flight: { current: { ticId: string; loaded: boolean } | null };
    current(): boolean;
    onGalaxy(): void;
    /** The login fly-in starts (true) and ends (false). */
    onIntro?(playing: boolean): void;
    /**
     * The first-login story is on (FirstStory): the galaxy stays far away
     * (`intro`, put there if needed) and the fly-in waits for its end.
     */
    holdIntro?: boolean;
  },
): Promise<void> {
  const { flight, current } = options;
  const state = scene.getState();
  const intro = async () => {
    options.onIntro?.(true);
    try {
      await scene.playIntro();
    } finally {
      options.onIntro?.(false);
    }
  };
  if (target.stage === "backdrop") {
    scene.setMode("backdrop");
    return;
  }
  // Another member's galaxy: leave my star, then the public view feeds its
  // stars and moves the camera itself (showOverview, focusStar).
  if (target.stage === "public") {
    flight.current = null;
    if (state.mode === "intro") await intro();
    else if (state.focusedTicId || FOCUSED.has(state.mode))
      await scene.returnToGalaxy();
    else if (state.mode !== "galaxy") scene.setMode("galaxy");
    if (!current()) return;
    scene.setSystem(null);
    return;
  }
  // Nothing to fly to: the page says why (locked star, unknown TIC) over
  // the galaxy, and the scene is not left waiting for a star that won't come.
  if (options.starMissing && target.stage !== "galaxy") {
    flight.current = null;
    if (target.stage === "analysis") {
      scene.setMode("backdrop");
      return;
    }
    if (state.mode === "intro") await intro();
    else if (state.focusedTicId || FOCUSED.has(state.mode))
      await scene.returnToGalaxy();
    else if (state.mode !== "galaxy") scene.setMode("galaxy");
    return;
  }
  if (target.stage === "galaxy") {
    if (options.holdIntro) {
      flight.current = null;
      if (state.mode !== "intro") scene.setMode("intro");
      return;
    }
    if (state.mode === "intro") await intro();
    else if (state.focusedTicId || FOCUSED.has(state.mode))
      await scene.returnToGalaxy();
    else if (state.mode !== "galaxy") scene.setMode("galaxy");
    if (!current()) return;
    flight.current = null;
    scene.setSystem(null);
    options.onGalaxy();
    return;
  }
  const ticId = target.ticId;
  if (!ticId) {
    if (target.stage === "analysis") scene.setMode("analysis");
    return;
  }
  // Login lands on a star: fly into the galaxy first, then on to the star.
  if (state.mode === "intro" && target.stage === "system") {
    await intro();
    if (!current()) return;
  }
  const now = scene.getState();
  // A transit owns the camera until it ends; the sequence brings it back.
  if (now.mode === "transit" && now.focusedTicId === ticId) return;
  const previous = flight.current;
  const again =
    previous?.ticId === ticId && !previous.loaded && options.starLoaded;
  if (now.focusedTicId !== ticId || previous?.ticId !== ticId || again) {
    flight.current = { ticId, loaded: options.starLoaded };
    await scene.focusStar(ticId);
    if (!current()) return;
  }
  const mode = target.stage === "analysis" ? "analysis" : "system";
  if (scene.getState().mode !== mode) scene.setMode(mode);
}

export function useStageDirector(
  scene: SceneController,
  target: StageTarget,
  starLoaded: boolean,
  onGalaxy: () => void,
  extra: {
    starMissing?: boolean;
    onIntro?(playing: boolean): void;
    holdIntro?: boolean;
  } = {},
) {
  const generation = useRef(0);
  const flight = useRef<{ ticId: string; loaded: boolean } | null>(null);
  const arrive = useRef(onGalaxy);
  arrive.current = onGalaxy;
  const introRef = useRef(extra.onIntro);
  introRef.current = extra.onIntro;
  // A star that arrives after the flight began gets a second, real flight.
  const focused = target.stage === "system" || target.stage === "analysis";
  const loadedKey = focused ? starLoaded : false;
  const missingKey = focused ? !!extra.starMissing : false;
  const holdKey = target.stage === "galaxy" && !!extra.holdIntro;
  useEffect(() => {
    const id = ++generation.current;
    void directStage(scene, target, {
      starLoaded: loadedKey,
      starMissing: missingKey,
      flight,
      current: () => id === generation.current,
      onGalaxy: () => arrive.current(),
      onIntro: (playing) => introRef.current?.(playing),
      holdIntro: holdKey,
    }).catch((error) => console.error("scene direction failed", error));
    // target is read by value; stage and ticId are its identity.
  }, [scene, target.stage, target.ticId, loadedKey, missingKey, holdKey]);
}
