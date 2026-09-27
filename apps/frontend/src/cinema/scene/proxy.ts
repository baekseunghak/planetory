// The controller SceneCanvas registers on mount. It is stable for the
// canvas' lifetime, so the shell never re-registers, and it bridges the time
// before the engine chunk (three.js) has loaded: it keeps the mode/focus state
// machine and the latest data, then replays them into the engine instantly.
// No three.js import here.
import type {
  AnalysisHint,
  PlanetPointer,
  SceneController,
  SceneError,
  SceneFrame,
  SceneState,
  SceneSystem,
  StarPointer,
  Unsubscribe,
  ViewInset,
} from "./contract";
import type { SkyMeta, Star } from "../../features/sky-data/contracts";

export type SceneEngineLike = SceneController & {
  restore(
    target: Pick<SceneState, "mode" | "focusedTicId" | "focusedPlanetId">,
  ): void;
  dispose(): void;
};

const reducedMotion = () => {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

function call<T>(listener: (value: T) => void, value: T) {
  try {
    listener(value);
  } catch (error) {
    console.error("[scene] listener failed", error);
  }
}

function listeners<T>() {
  const set = new Set<(value: T) => void>();
  return {
    add(listener: (value: T) => void): Unsubscribe {
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    emit(value: T) {
      for (const listener of [...set]) call(listener, value);
    },
    has: (listener: (value: T) => void) => set.has(listener),
  };
}

export function createSceneProxy() {
  let engine: SceneEngineLike | null = null;
  let unhook: Unsubscribe | null = null;
  let failure: string | null = null;
  let state: SceneState = {
    mode: "galaxy",
    ready: false,
    failed: null,
    focusedTicId: null,
    focusedPlanetId: null,
    effects: true,
    reducedMotion: reducedMotion(),
    busy: false,
  };
  const changes = new Set<() => void>();
  const frame = listeners<SceneFrame>();
  const ready = listeners<void>();
  const error = listeners<SceneError>();
  const hover = listeners<StarPointer | null>();
  const click = listeners<StarPointer>();
  const planet = listeners<PlanetPointer>();

  // Latest data, replayed into a newly attached engine.
  let stars: { stars: readonly Star[]; meta: SkyMeta } | null = null;
  let system: SceneSystem | null | undefined;
  let inset: ViewInset | null = null;
  let hint: AnalysisHint | null | undefined;
  // The member's explicit effects choice. Without one the engine's power
  // tier decides, so the proxy's own default is never replayed.
  let effectsChoice: boolean | undefined;
  // Newly unlocked stars kept hidden until their ignition.
  const held = new Set<string>();
  // The login fly-in asked for before the engine chunk arrived (a fresh page
  // load after OAuth usually wins that race). The engine plays it on attach
  // unless another camera move was asked for in between.
  let pendingIntro = false;

  const publish = (next: SceneState) => {
    if (failure && !next.failed) next = { ...next, failed: failure };
    const keys = Object.keys(next) as (keyof SceneState)[];
    if (keys.every((key) => next[key] === state[key])) return;
    state = next;
    for (const listener of [...changes]) call(listener, undefined);
  };
  const local = (patch: Partial<SceneState>) => publish({ ...state, ...patch });
  const done = () => Promise.resolve();

  const controller: SceneController = {
    getState: () => state,
    subscribe(listener) {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    setStars(next, meta) {
      stars = { stars: next, meta };
      engine?.setStars(next, meta);
    },
    setSystem(next) {
      system = next;
      engine?.setSystem(next);
    },
    setMode(mode) {
      if (engine) return engine.setMode(mode);
      if (mode !== state.mode) pendingIntro = false;
      if (mode === "system" || mode === "analysis") {
        if (state.focusedTicId) local({ mode });
      } else local({ mode, focusedTicId: null, focusedPlanetId: null });
    },
    playIntro() {
      if (engine) return engine.playIntro();
      if (state.mode === "intro" || state.mode === "backdrop") {
        pendingIntro = state.mode === "intro";
        local({ mode: "galaxy", focusedTicId: null, focusedPlanetId: null });
      }
      return done();
    },
    showOverview() {
      if (engine) return engine.showOverview();
      pendingIntro = false;
      local({ mode: "galaxy", focusedTicId: null, focusedPlanetId: null });
      return done();
    },
    focusStar(ticId) {
      if (engine) return engine.focusStar(ticId);
      if (ticId) pendingIntro = false;
      if (ticId)
        local({ mode: "system", focusedTicId: ticId, focusedPlanetId: null });
      return done();
    },
    returnToGalaxy() {
      if (engine) return engine.returnToGalaxy();
      pendingIntro = false;
      local({ mode: "galaxy", focusedTicId: null, focusedPlanetId: null });
      return done();
    },
    focusPlanet(candidateId) {
      if (engine) return engine.focusPlanet(candidateId);
      if (state.focusedTicId) local({ focusedPlanetId: candidateId });
    },
    setViewInset(next) {
      inset = next;
      engine?.setViewInset(next);
    },
    setAnalysisHint(next) {
      hint = next;
      engine?.setAnalysisHint(next);
    },
    playMismatch: () => (engine ? engine.playMismatch() : done()),
    playTransit: (request) => (engine ? engine.playTransit(request) : done()),
    revealPlanet: (planetReveal) =>
      engine ? engine.revealPlanet(planetReveal) : done(),
    ignite(target) {
      const ticId = typeof target === "string" ? target : target?.ticId;
      if (ticId) held.delete(ticId);
      return engine ? engine.ignite(target) : done();
    },
    holdStars(ticIds) {
      if (ticIds === null) held.clear();
      else for (const ticId of ticIds) if (ticId) held.add(ticId);
      engine?.holdStars?.(ticIds);
    },
    setEffects(enabled) {
      effectsChoice = !!enabled;
      if (engine) return engine.setEffects(enabled);
      local({ effects: !!enabled });
    },
    projectStar: (ticId) => engine?.projectStar(ticId) ?? null,
    projectPlanet: (candidateId) => engine?.projectPlanet(candidateId) ?? null,
    onFrame: (listener) => frame.add(listener),
    onReady(listener) {
      const off = ready.add(listener);
      if (state.ready)
        queueMicrotask(() => ready.has(listener) && call(listener, undefined));
      return off;
    },
    onError(listener) {
      const off = error.add(listener);
      const failed = state.failed;
      if (failed)
        queueMicrotask(
          () =>
            error.has(listener) &&
            call(listener, { message: failed, recoverable: false }),
        );
      return off;
    },
    onStarHover: (listener) => hover.add(listener),
    onStarClick: (listener) => click.add(listener),
    onPlanetClick: (listener) => planet.add(listener),
  };

  function attach(next: SceneEngineLike) {
    detach();
    engine = next;
    const wanted = state;
    // Each replay is isolated: one bad value must not take the engine down.
    const replay = (label: string, run: () => void) => {
      try {
        run();
      } catch (failure) {
        console.error(`[scene] replay ${label} failed`, failure);
      }
    };
    if (effectsChoice !== undefined)
      replay("effects", () => next.setEffects(effectsChoice!));
    if (held.size) replay("hold", () => next.holdStars?.([...held]));
    if (inset) replay("inset", () => next.setViewInset(inset!));
    if (stars) replay("stars", () => next.setStars(stars!.stars, stars!.meta));
    if (system !== undefined) replay("system", () => next.setSystem(system!));
    if (hint !== undefined) replay("hint", () => next.setAnalysisHint(hint!));
    const intro =
      pendingIntro && wanted.mode === "galaxy" && !wanted.focusedTicId;
    pendingIntro = false;
    replay("restore", () =>
      next.restore(
        intro
          ? { mode: "intro", focusedTicId: null, focusedPlanetId: null }
          : {
              mode: wanted.mode,
              focusedTicId: wanted.focusedTicId,
              focusedPlanetId: wanted.focusedPlanetId,
            },
      ),
    );
    // Start far away and fly in, as if the engine had been there all along.
    if (intro) replay("intro", () => void next.playIntro());
    const offs = [
      next.subscribe(() => publish(next.getState())),
      next.onFrame((value) => frame.emit(value)),
      next.onReady(() => ready.emit()),
      next.onError((value) => {
        if (!value.recoverable) {
          failure = value.message;
          local({ failed: value.message, busy: false });
        }
        error.emit(value);
      }),
      next.onStarHover((value) => hover.emit(value)),
      next.onStarClick((value) => click.emit(value)),
      next.onPlanetClick((value) => planet.emit(value)),
    ];
    unhook = () => offs.forEach((off) => off());
    publish(next.getState());
  }

  function detach() {
    if (!engine) return;
    const last = engine.getState();
    unhook?.();
    unhook = null;
    engine = null;
    hover.emit(null);
    publish({
      ...last,
      mode: last.mode === "transit" ? "system" : last.mode,
      ready: false,
      busy: false,
    });
  }

  /** The engine could not start (no WebGL, chunk failed). Shell shows the list. */
  function fail(message: string) {
    failure = message;
    local({ failed: message, ready: false, busy: false });
    error.emit({ message, recoverable: false });
  }

  return { controller, attach, detach, fail };
}
