// First-login story (FirstStory.tsx): four lines over the far-away galaxy
// before a newcomer's fly-in, once per member on this browser. No React
// here, so unit tests can import it.
import type { ViewInset } from "../scene";
import { firstVisitFlown } from "./tutorial-guide";

export const STORY_LINES = [
  "NASA의 TESS 망원경은 지금도 수십만 개 별의 밝기를 기록하고 있습니다.",
  "행성이 별 앞을 지나가면, 별빛이 아주 잠깐 어두워집니다.",
  "그 작은 흔들림을 찾아내는 것이 이곳에서 할 일입니다.",
  "먼저 튜토리얼 별 다섯 개로 시작해 볼까요?",
] as const;
export const STORY_START = "시작하기";
export const STORY_SKIP = "건너뛰기";

/** Members (ids) who have seen the story on this browser. */
export const STORY_KEY = "planetory:first-visit-story";

/** Before the first line: the page settles, the galaxy stays far away. */
export const STORY_LEAD_MS = 500;
/** Each line's turn on screen, its fade in and fade out included. */
export const STORY_LINE_MS = 2500;
/** Fade in, and fade out at the end of a line's turn (CSS uses the same). */
export const STORY_FADE_MS = 700;
/** The button comes this long after the last line starts. */
export const STORY_BUTTON_MS = 900;
/** The layer fades out this long once the member starts (or skips). */
export const STORY_LEAVE_MS = 600;

type StoryStorage = Pick<Storage, "getItem" | "setItem">;

function readSeen(storage: StoryStorage | null): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(STORY_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

// Seen in this page even when the store is blocked.
const seenHere = new Set<string>();

export function storySeen(
  storage: StoryStorage | null,
  memberId: string,
): boolean {
  return seenHere.has(memberId) || readSeen(storage).includes(memberId);
}

/** The member started (or skipped): never again for them on this browser. */
export function markStorySeen(
  storage: StoryStorage | null,
  memberId: string,
): void {
  if (!memberId) return;
  seenHere.add(memberId);
  try {
    storage?.setItem(
      STORY_KEY,
      JSON.stringify([...new Set([...readSeen(storage), memberId])]),
    );
  } catch {
    // This page still remembers it.
  }
}

/** Forget stories seen in this page (tests). */
export function resetStoryHere(): void {
  seenHere.clear();
}

/**
 * Newcomers only: onboarding not done (`firstVisit`), on the galaxy, not
 * seen yet, and not already flown to tutorial 1 (someone who has been here
 * before, from before the story existed, is not a newcomer to it).
 */
export function storyWanted(
  storage: StoryStorage | null,
  options: { firstVisit: boolean; memberId: string; onGalaxy: boolean },
): boolean {
  const { firstVisit, memberId, onGalaxy } = options;
  return (
    firstVisit &&
    onGalaxy &&
    !!memberId &&
    !storySeen(storage, memberId) &&
    !firstVisitFlown(storage, memberId)
  );
}

export type StoryFrame = {
  /** Line on screen (index), or -1 before the first one. */
  line: number;
  /** false while the line fades out at the end of its turn. */
  shown: boolean;
  /** The start button is up. */
  button: boolean;
};

/**
 * What the story shows `elapsed` ms after it began. Lines take turns
 * (fade in, stay, fade out); the last one stays and the button follows.
 * Reduced motion: every line and the button at once (`line` is the last).
 */
export function storyFrame(elapsed: number, reduced: boolean): StoryFrame {
  const last = STORY_LINES.length - 1;
  if (reduced) return { line: last, shown: true, button: true };
  const t = elapsed - STORY_LEAD_MS;
  if (t < 0) return { line: -1, shown: false, button: false };
  const line = Math.min(last, Math.floor(t / STORY_LINE_MS));
  const into = t - line * STORY_LINE_MS;
  return {
    line,
    shown: line === last || into < STORY_LINE_MS - STORY_FADE_MS,
    button: line === last && into >= STORY_BUTTON_MS,
  };
}

/** Times (ms from the start) at which `storyFrame` changes, in order. */
export function storyChanges(reduced: boolean): number[] {
  if (reduced) return [];
  const times: number[] = [];
  STORY_LINES.forEach((_, index) => {
    const start = STORY_LEAD_MS + index * STORY_LINE_MS;
    times.push(start);
    if (index < STORY_LINES.length - 1)
      times.push(start + STORY_LINE_MS - STORY_FADE_MS);
    else times.push(start + STORY_BUTTON_MS);
  });
  return times;
}

/**
 * Where the tutorial markers must stay when the galaxy comes to rest
 * (scene `setHomeFrame`): clear of the top bar, with room for the marker
 * drawn above its star, and above the bottom HUD and the first-visit line.
 * CSS px from the canvas edges.
 */
export const MARKER_FRAME_MARGIN: Required<ViewInset> = {
  // top bar 56 + marker above its star (30px box lifted 135%) 41 + air
  top: 56 + 41 + 24,
  // HUD pills (22 + 40) and the first-visit line above them (70 + 30) + air
  bottom: 100 + 24,
  // HUD inset 24 + half a marker 15 + air
  left: 24 + 15 + 24,
  right: 24 + 15 + 24,
};
