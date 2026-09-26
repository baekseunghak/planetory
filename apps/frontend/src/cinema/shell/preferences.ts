// Per-browser display choice. Storage can be blocked; the default then holds.
export const SCENE_EFFECTS_KEY = "planetory:scene-effects";

export function readSceneEffects(): boolean {
  try {
    return localStorage.getItem(SCENE_EFFECTS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSceneEffects(enabled: boolean): void {
  try {
    localStorage.setItem(SCENE_EFFECTS_KEY, enabled ? "on" : "off");
  } catch {
    /* The choice lasts for this page only. */
  }
}
