// Scene contract (frozen). The shell, both analysis variants and the scene
// engine meet here. Builders may only ADD optional members and must say so in
// their report. See ../README.md for the state machine and ownership.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SkyMeta, Star } from "../../features/sky-data/contracts";
import type { OwnedSystem } from "../../features/sky-renderer/model";
import { signalSeed } from "../../features/sky-renderer/personal-system";

export type Unsubscribe = () => void;

/**
 * - `intro`     login backdrop and the fly-in. No data needed; the engine may
 *               draw a decorative galaxy until `setStars` arrives.
 * - `galaxy`    my galaxy, free navigation, stars clickable.
 * - `system`    close to one star; its system (setSystem) is visible.
 * - `analysis`  system framed above the analysis panel; ghost orbit from
 *               `setAnalysisHint`.
 * - `transit`   edge-on transit, only while `playTransit` runs.
 * - `backdrop`  dimmed, slow galaxy behind other pages (community, profile).
 */
export type SceneMode =
  "intro" | "galaxy" | "system" | "analysis" | "transit" | "backdrop";

/** Planet as the scene draws it. Build with `scenePlanet`/`sceneSystemFrom`. */
export type ScenePlanet = {
  candidateId: string;
  /** `unconfirmed` is drawn with a DASHED orbit. FP never reaches the scene. */
  kind: "confirmed" | "unconfirmed";
  periodDays: number | null;
  depthPpm: number | null;
  /** `signalSeed(candidateId)`. Palette: ocean/ice, brown > .68, teal < .17. */
  seed: number;
};

/** Only the member's own planets (`planets.items` of the star detail). */
export type SceneSystem = {
  ticId: string;
  /** Sky version the detail was read under (`SkyMeta.version`). */
  version: string;
  /** Stored position. Render z = depthZ * DEPTH_SCALE (256). */
  position: { x: number; y: number; depthZ: number; layoutOrdinal: number };
  planets: readonly ScenePlanet[];
};

/** Panels covering the canvas, in CSS px. The focused star stays in the rest. */
export type ViewInset = {
  top?: number;
  right: number;
  bottom: number;
  left?: number;
};

export type PhaseWindow = {
  /** Phase in [0, 1). `endPhase` may exceed 1 when the window wraps. */
  startPhase: number;
  endPhase: number;
  durationHours: number;
};

/**
 * Ghost orbit while analysing. `strength` 0..1 is the periodogram power at the
 * chosen period over the strongest power (see `periodStrength` in the bridge).
 * `selection` non-null shows the translucent ghost planet.
 */
export type AnalysisHint = {
  periodDays: number;
  strength: number;
  selection: PhaseWindow | null;
};

export type TransitRequest = {
  periodDays: number;
  /** Fractional depth: depthPpm / 1e6 (8000 ppm -> 0.008). */
  depth: number;
  durationHours: number;
  /** Every frame: t 0..1 across the pass, flux relative to 1 = baseline. */
  onFlux?: (t: number, flux: number) => void;
  signal?: AbortSignal;
};

export type PlanetReveal = ScenePlanet & { ticId: string };

export type IgniteTarget =
  string | Pick<Star, "ticId" | "x" | "y" | "depthZ" | "layoutOrdinal">;

export type ScreenPoint = {
  /** CSS px from the canvas' top-left corner. */
  x: number;
  y: number;
  /** Larger is farther. Use for z-ordering labels only. */
  depth: number;
  /** Apparent radius in CSS px (hit area for DOM markers). */
  radius: number;
  /** In front of the camera and inside the canvas. */
  visible: boolean;
};

export type SceneFrame = { time: number; width: number; height: number };

export type SceneState = {
  mode: SceneMode;
  /** Renderer created and a first frame drawn. Never gate UI on this. */
  ready: boolean;
  /** WebGL unavailable or lost for good. Shell shows DiscoveredStars. */
  failed: string | null;
  focusedTicId: string | null;
  focusedPlanetId: string | null;
  effects: boolean;
  reducedMotion: boolean;
  /** A flight or an effect is running. */
  busy: boolean;
  /**
   * Render cost tier (optional; absent = `full`). `full`: effects as the
   * member chose, DPR <= 1.75. `reduced`: effects off unless the member
   * turns them on, DPR <= 1. `low`: software WebGL or sustained low fps,
   * DPR 0.5, no post-processing unless the member turns the effects on. Too
   * slow even at `low`: `failed` is set and the shell shows the list. Policy
   * and thresholds: ./power.ts.
   */
  power?: "full" | "reduced" | "low";
};

export type SceneError = { message: string; recoverable: boolean };
export type StarPointer = { ticId: string; screen: ScreenPoint };
export type PlanetPointer = { candidateId: string | null };

/**
 * Promises resolve when the move or effect has finished, was skipped
 * (reduced motion, effects off, unknown star) or was superseded. They never
 * reject. With prefers-reduced-motion every move is instant and orbits hold
 * still.
 */
export interface SceneController {
  /** Same object until something changes (useSyncExternalStore). */
  getState(): SceneState;
  subscribe(listener: () => void): Unsubscribe;

  /** Stars currently loaded by the sky store, and its metadata. */
  setStars(stars: readonly Star[], meta: SkyMeta): void;
  setSystem(system: SceneSystem | null): void;

  /** Mode change without a new camera target (analysis, backdrop, ...). */
  setMode(mode: Exclude<SceneMode, "transit">): void;
  /** intro -> galaxy fly-in. */
  playIntro(): Promise<void>;
  /** Frame the whole galaxy. */
  showOverview(): Promise<void>;
  /** Curved flight to a star; ends in `system`. */
  focusStar(ticId: string): Promise<void>;
  /** Back to the camera pose from before `focusStar`; ends in `galaxy`. */
  returnToGalaxy(): Promise<void>;
  /** `null` frames the whole system again. */
  focusPlanet(candidateId: string | null): void;
  setViewInset(inset: ViewInset): void;

  setAnalysisHint(hint: AnalysisHint | null): void;
  /** Numeric mismatch: the ghost orbit pulses in --pc-bad once, no transit. */
  playMismatch(): Promise<void>;
  /** Edge-on pass of the planet in front of the star; mode `transit`. */
  playTransit(request: TransitRequest): Promise<void>;
  /** The discovered planet takes its orbit in the current system. */
  revealPlanet(planet: PlanetReveal): Promise<void>;
  /**
   * Flash and shockwave on a newly unlocked star. Waits up to 10 s for the
   * star to arrive through `setStars` when only the TIC is given.
   */
  ignite(target: IgniteTarget): Promise<void>;
  /**
   * Optional (added): newly unlocked stars that must not show before
   * `ignite` reveals them. The refreshed sky usually brings them through
   * `setStars` while the member is still on the analysis. An array adds to
   * the held stars; `ignite(tic)` takes its star off; `null` releases all.
   */
  holdStars?(ticIds: readonly string[] | null): void;
  /**
   * Bloom, nebula and dust: the member's explicit choice, which holds on
   * every power tier. Without a call the tier decides (on at `full` only).
   */
  setEffects(enabled: boolean): void;

  /** Screen position for DOM markers/labels. null when unknown. */
  projectStar(ticId: string): ScreenPoint | null;
  projectPlanet(candidateId: string): ScreenPoint | null;
  /** After each drawn frame. Move DOM with transforms here, not React state. */
  onFrame(listener: (frame: SceneFrame) => void): Unsubscribe;

  onReady(listener: () => void): Unsubscribe;
  /** `recoverable: false` means switch to the list fallback. */
  onError(listener: (error: SceneError) => void): Unsubscribe;
  onStarHover(listener: (star: StarPointer | null) => void): Unsubscribe;
  onStarClick(listener: (star: StarPointer) => void): Unsubscribe;
  /** `null` = the star body or empty space inside the system. */
  onPlanetClick(listener: (planet: PlanetPointer) => void): Unsubscribe;
}

/** Durations from the reference prototype, in ms. Reduced motion uses 0. */
export const SCENE_TIMING = {
  introMs: 3600,
  toStarMs: 3400,
  toGalaxyMs: 3200,
  overviewMs: 1800,
  transitFlightMs: 2600,
  transitMs: 5200,
  revealMs: 1500,
  igniteMs: 2200,
} as const;

export function scenePlanet(
  planet: Pick<ScenePlanet, "candidateId" | "kind" | "periodDays" | "depthPpm">,
): ScenePlanet {
  return { ...planet, seed: signalSeed(planet.candidateId) };
}

/** Star detail (`readStarDetail(...).system`) to the scene's system. */
export function sceneSystemFrom(system: OwnedSystem): SceneSystem {
  return {
    ticId: system.ticId,
    version: system.version,
    position: {
      x: system.position.x,
      y: system.position.y,
      depthZ: system.position.depthZ,
      layoutOrdinal: system.position.layoutOrdinal,
    },
    planets: system.items.map(scenePlanet),
  };
}

const reducedMotion = () => {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/**
 * Stand-in until the engine registers. Keeps the mode/focus state machine so
 * the shell can be built and tested without WebGL; draws nothing, fires no
 * pointer events, projects nothing and resolves every effect at once.
 */
export function createNoopSceneController(): SceneController {
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
  const listeners = new Set<() => void>();
  const update = (patch: Partial<SceneState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const none: Unsubscribe = () => undefined;
  const done = () => Promise.resolve();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setStars: () => undefined,
    setSystem: () => undefined,
    setMode: (mode) => update({ mode }),
    playIntro: () => (update({ mode: "galaxy" }), done()),
    showOverview: () => (update({ mode: "galaxy" }), done()),
    focusStar: (ticId) => (
      update({ mode: "system", focusedTicId: ticId, focusedPlanetId: null }),
      done()
    ),
    returnToGalaxy: () => (
      update({ mode: "galaxy", focusedTicId: null, focusedPlanetId: null }),
      done()
    ),
    focusPlanet: (candidateId) => update({ focusedPlanetId: candidateId }),
    setViewInset: () => undefined,
    setAnalysisHint: () => undefined,
    playMismatch: done,
    playTransit: done,
    revealPlanet: done,
    ignite: done,
    holdStars: () => undefined,
    setEffects: (effects) => update({ effects }),
    projectStar: () => null,
    projectPlanet: () => null,
    onFrame: () => none,
    onReady: () => none,
    onError: () => none,
    onStarHover: () => none,
    onStarClick: () => none,
    onPlanetClick: () => none,
  };
}

type Registry = {
  controller: SceneController;
  register(controller: SceneController): Unsubscribe;
};
const outside = createNoopSceneController();
const SceneContext = createContext<Registry | null>(null);

/**
 * One per app, above every route (the galaxy persists across screens). The
 * engine's `SceneCanvas` registers its controller here; until then and after
 * it unmounts, `useScene()` returns the no-op controller.
 */
export function SceneProvider({ children }: { children?: ReactNode }) {
  const fallback = useRef<SceneController>(null);
  fallback.current ??= createNoopSceneController();
  const [controller, setController] = useState<SceneController>(
    () => fallback.current!,
  );
  const register = useCallback((next: SceneController) => {
    setController(() => next);
    return () =>
      setController((current) =>
        current === next ? fallback.current! : current,
      );
  }, []);
  const value = useMemo(
    () => ({ controller, register }),
    [controller, register],
  );
  return createElement(SceneContext.Provider, { value }, children);
}

/** The current controller. Outside a provider: a detached no-op. */
export function useScene(): SceneController {
  return useContext(SceneContext)?.controller ?? outside;
}

/** For the engine: register a controller for as long as it is mounted. */
export function useRegisterScene(controller: SceneController | null) {
  const registry = useContext(SceneContext);
  useEffect(
    () => (controller && registry ? registry.register(controller) : undefined),
    [controller, registry?.register],
  );
}

/** Mode, focus and failure as React state. */
export function useSceneState(): SceneState {
  const controller = useScene();
  return useSyncExternalStore(controller.subscribe, controller.getState);
}
