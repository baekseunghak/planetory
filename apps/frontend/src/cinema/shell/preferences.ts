// Per-browser display choice. Storage can be blocked; the default then holds.
export const SCENE_EFFECTS_KEY = "planetory:scene-effects";

/**
 * The member's '빛 효과' choice on this browser, or null when they never
 * chose: then the scene's power tier decides (on at `full`, off on weak
 * graphics). An explicit choice holds on every tier.
 */
export function readSceneEffects(): boolean | null {
  try {
    const value = localStorage.getItem(SCENE_EFFECTS_KEY);
    return value === "on" ? true : value === "off" ? false : null;
  } catch {
    return null;
  }
}

export function writeSceneEffects(enabled: boolean): void {
  try {
    localStorage.setItem(SCENE_EFFECTS_KEY, enabled ? "on" : "off");
  } catch {
    /* The choice lasts for this page only. */
  }
}
