// Render cost policy of the scene (`SceneState.power`). Pure apart from the
// session storage helpers, so tests drive it without WebGL; the engine feeds
// it the renderer name at start and every animation frame after that.
//
//   full     effects as the member chose (on by default), DPR <= 1.75
//   reduced  effects off by default, DPR <= 1, intro/backdrop at ~30/20 fps
//   low      effects off by default, DPR 0.5, no post-processing unless the
//            member turns the effects on
//   list     too slow even at `low`: the shell shows the star list
//
// Start: software WebGL (SwiftShader, llvmpipe, Microsoft Basic Render) is
// `low`; anything else `full`. While running, a 3 s window of the galaxy or a
// system at rest whose median frame rate is under 24 fps steps down once
// (full -> reduced -> low). At `low` with effects off, a 5 s window under
// 10 fps switches to the list. The member's own '빛 효과' choice is never
// overridden: a step lowers the resolution and the default, and with effects
// the member turned on the scene is not swapped for the list. Nothing steps
// back up; the level is kept for the tab (session storage).
// `?power=full|reduced|low|list` pins a level for a demo (no monitor),
// `?power=auto` forgets the pin and the kept level.
import type { SceneMode } from "./contract";
import { LOW_POWER_DPR, isSoftwareRenderer } from "./math";

export type PowerTier = "full" | "reduced" | "low";
export type PowerLevel = PowerTier | "list";
export type PowerAction = "reduced" | "low" | "list";

const LEVELS: readonly PowerLevel[] = ["full", "reduced", "low", "list"];
export const POWER_STORAGE_KEY = "planetory:scene-power";
export const POWER_PARAM = "power";
/** The list fallback's notice (`SceneState.failed`). */
export const POWER_SLOW_MESSAGE =
  "화면이 느려 3D 은하 대신 별 목록으로 보여 드립니다.";

export const POWER_DPR: Record<PowerTier, number> = {
  full: 1.75,
  reduced: 1,
  low: LOW_POWER_DPR,
};
/** Median frame rate a moving-free galaxy must keep before stepping down. */
export const POWER_MIN_FPS = 24;
/** At `low` with effects off: below this the list is more usable. */
export const POWER_LIST_FPS = 10;
export const POWER_WINDOW_MS = 3000;
export const POWER_LIST_WINDOW_MS = 5000;
/** Not measured right after a start, a mode change, a flight or a step. */
export const POWER_GRACE_MS = 2000;
/** A gap this long is a stall (debugger, sleep, tab switch), not a rate. */
const STALL_MS = 4000;

const isLevel = (value: unknown): value is PowerLevel =>
  typeof value === "string" && (LEVELS as readonly string[]).includes(value);

/** The lower (cheaper) of two levels. */
export function lowerLevel(a: PowerLevel, b: PowerLevel): PowerLevel {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

/** `?power=` of the page URL: a pinned level, `auto`, or nothing. */
export function readForcedPower(search: string): PowerLevel | "auto" | null {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get(POWER_PARAM);
  } catch {
    return null;
  }
  if (value === "auto") return "auto";
  return isLevel(value) ? value : null;
}

export type RememberedPower = { level: PowerLevel; pinned: boolean };

/** `pin:<level>` (a demo pin) or `<level>` (stepped down in this tab). */
export function parseRememberedPower(
  raw: string | null | undefined,
): RememberedPower | null {
  if (!raw) return null;
  const pinned = raw.startsWith("pin:");
  const level = pinned ? raw.slice(4) : raw;
  return isLevel(level) ? { level, pinned } : null;
}

export type PowerStart = {
  level: PowerLevel;
  /** Software WebGL: the shader warm-up and MSAA are skipped too. */
  software: boolean;
  /** Pinned for a demo: no monitor, nothing is stepped down. */
  pinned: boolean;
};

export function initialPower(input: {
  renderer: string | null | undefined;
  forced?: PowerLevel | "auto" | null;
  remembered?: RememberedPower | null;
}): PowerStart {
  const software = isSoftwareRenderer(input.renderer);
  const forced = input.forced ?? null;
  if (forced && forced !== "auto")
    return { level: forced, software, pinned: true };
  const remembered = forced === "auto" ? null : (input.remembered ?? null);
  if (remembered?.pinned)
    return { level: remembered.level, software, pinned: true };
  const detected: PowerLevel = software ? "low" : "full";
  return {
    level: remembered ? lowerLevel(detected, remembered.level) : detected,
    software,
    pinned: false,
  };
}

/** Effects on unless the member chose otherwise; off below `full`. */
export function effectsFor(tier: PowerTier, choice: boolean | null): boolean {
  return choice ?? tier === "full";
}

/**
 * Least time between drawn frames (ms) while the scene only drifts (login,
 * behind a page). 0 = every frame. Flights and effects always draw.
 */
export function driftInterval(tier: PowerTier, mode: SceneMode): number {
  if (mode === "backdrop") return tier === "full" ? 30 : 45;
  if (mode === "intro") return tier === "full" ? 0 : 30;
  return 0;
}

/**
 * One step down for a measured frame rate, or null to stay. `effects` is
 * what is drawn: at `low` it is on only because the member turned it on,
 * and then the 3D scene stays (their choice; the button turns it off).
 */
export function decidePower(
  fps: number,
  context: { tier: PowerTier; effects: boolean },
): PowerAction | null {
  if (context.tier === "low")
    return !context.effects && fps < POWER_LIST_FPS ? "list" : null;
  if (fps >= POWER_MIN_FPS) return null;
  return context.tier === "full" ? "reduced" : "low";
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Frame-rate watch. Feed every animation frame; `measurable` is false while
 * anything but the galaxy or a system at rest is on screen (flights,
 * transits, ignitions, analysis, backdrop, login, a hidden tab). Each window
 * is decided once and then starts over.
 */
export class PowerMonitor {
  private intervals: number[] = [];
  private span = 0;
  private previous: number | null = null;
  private graceUntil = 0;
  /** Median frame rate of the last decided window (for logs). */
  lastFps: number | null = null;

  /** Start over and wait `ms` before measuring again. */
  hold(now: number, ms = POWER_GRACE_MS): void {
    this.intervals = [];
    this.span = 0;
    this.previous = null;
    this.graceUntil = Math.max(this.graceUntil, now + ms);
  }

  frame(
    now: number,
    measurable: boolean,
    context: { tier: PowerTier; effects: boolean },
  ): PowerAction | null {
    if (!measurable) {
      this.hold(now);
      return null;
    }
    if (now < this.graceUntil || this.previous === null) {
      this.previous = now;
      return null;
    }
    const gap = now - this.previous;
    this.previous = now;
    if (gap <= 0) return null;
    if (gap > STALL_MS) {
      this.hold(now);
      return null;
    }
    this.intervals.push(gap);
    this.span += gap;
    const window =
      context.tier === "low" && !context.effects
        ? POWER_LIST_WINDOW_MS
        : POWER_WINDOW_MS;
    if (this.span < window) return null;
    const fps = 1000 / median(this.intervals);
    this.lastFps = fps;
    this.intervals = [];
    this.span = 0;
    const action = decidePower(fps, context);
    if (action) this.hold(now);
    return action;
  }
}

// ---------------------------------------------------------------- storage

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readRememberedPower(): RememberedPower | null {
  try {
    return parseRememberedPower(storage()?.getItem(POWER_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function rememberPower(level: PowerLevel, pinned = false): void {
  try {
    storage()?.setItem(POWER_STORAGE_KEY, pinned ? `pin:${level}` : level);
  } catch {
    /* The level holds for this page only. */
  }
}

export function forgetPower(): void {
  try {
    storage()?.removeItem(POWER_STORAGE_KEY);
  } catch {
    /* Nothing kept. */
  }
}

/**
 * The level this page starts at, from `?power=` and what the tab kept.
 * Applies the URL's pin or `auto` to the storage as a side effect, so a
 * later reload on another route keeps it.
 */
export function startingPower(
  search: string,
  renderer: string | null = null,
): PowerStart {
  const forced = readForcedPower(search);
  if (forced === "auto") forgetPower();
  else if (forced) rememberPower(forced, true);
  return initialPower({
    renderer,
    forced,
    remembered: forced === "auto" ? null : readRememberedPower(),
  });
}
