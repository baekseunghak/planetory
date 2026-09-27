// Tutorial guide lines (TutorialGuide.tsx): which line a star gets and
// where the member closed it. No React here, so unit tests can import it.
//
// Copy rules (tests/unit/cinema-tutorial-guide.test.ts checks them): plain
// Korean for someone who knows no astronomy, in the names the screen shows
// (추천 봉우리 1위, 접힌 곡선, 구간, '행성 같음'/'아닌 것 같음', '다음 곡선
// 단계로', 행성 1/2/3), no jargon, and never the diagnostic tools (홀짝·2차
// 식·V/U), which are not connected yet. Two lines at most at 1024px: the
// star panel line is short, the analysis line says what to look for.
import type { Star } from "../../features/sky-data/contracts";
import type { TutorialMarkers } from "../../features/sky-renderer/interaction";

export type GuidePlace = "star" | "analysis";

export const TUTORIAL_GUIDES: Readonly<
  Record<number, Readonly<Record<GuidePlace, string>>>
> = {
  1: {
    star: "행성 1개가 숨어 있습니다. '분석 시작'을 누르고 추천 봉우리 1위부터 보세요.",
    analysis:
      "추천 봉우리 1위(약 4.41일)를 누르면 접힌 곡선에 밝기가 움푹 꺼진 곳이 보입니다. 그곳을 구간으로 잡고 '행성 같음'을 고르세요.",
  },
  2: {
    star: "행성 3개가 숨어 있습니다. 하나를 찾을 때마다 '다음 곡선 단계로'를 누르세요.",
    analysis:
      "추천 봉우리 1위(약 3.69일)로 행성 1을 찾아 제출하고 '다음 곡선 단계로'를 누르면 행성 2(약 7.45일), 행성 3(약 2.25일)이 차례로 1위에 올라옵니다.",
  },
  3: {
    star: "행성처럼 보이지만 두 별이 서로 가리는 별입니다. 접힌 곡선에서 그 흔적을 찾아보세요.",
    analysis:
      "추천 봉우리 1위로 접으면 깊게 꺼진 두 곳 사이 한가운데에 얕은 감소가 하나 더 보입니다. 두 별이 서로 가리는 신호이니 깊은 곳을 구간으로 잡고 '아닌 것 같음'을 고르세요.",
  },
  4: {
    star: "두 별이 서로 가리는 별입니다. 접힌 곡선에서 아주 얕은 감소 하나를 더 찾아보세요.",
    analysis:
      "깊게 꺼진 두 곳 사이 한가운데를 확대하면 아주 얕은 감소가 숨어 있습니다. 두 별이 서로 가리는 신호이니 깊은 곳을 구간으로 잡고 '아닌 것 같음'을 고르세요.",
  },
  5: {
    star: "두 쌍의 별이 겹쳐 보이는 별입니다. 신호 1을 가려낸 뒤 신호 2도 찾아보세요.",
    analysis:
      "추천 봉우리 1위인 신호 1(약 5.49일)은 두 별이 가리는 신호입니다. '아닌 것 같음'으로 제출하고 '다음 곡선 단계로'를 누른 뒤 신호 2(약 5.67일)도 같은 방법으로 가려내세요.",
  },
};

export const TUTORIAL_GUIDE_KEY = "planetory:tutorial-guide-closed";

/** Tutorial sequence of a star, from the backend's own fields only. */
export function tutorialSeqOf(
  ticId: string,
  stars: readonly Star[],
  markers: TutorialMarkers | null | undefined,
): number | null {
  const marker = stars.find((star) => star.ticId === ticId)?.marker;
  if (marker?.type === "tutorial") return marker.seq;
  return markers?.get(ticId)?.seq ?? null;
}

export function tutorialGuide(
  seq: number | null,
  place: GuidePlace = "analysis",
): string | null {
  return seq !== null && Object.hasOwn(TUTORIAL_GUIDES, seq)
    ? TUTORIAL_GUIDES[seq][place]
    : null;
}

/**
 * The line a star shows in a place, or null: not a tutorial star, already
 * 탐사 완료 (nothing left to learn there), or closed by the member.
 */
export function guideLineFor(
  ticId: string,
  place: GuidePlace,
  stars: readonly Star[],
  markers: TutorialMarkers | null | undefined,
  storage: GuideStorage | null,
): { seq: number; line: string } | null {
  const seq = tutorialSeqOf(ticId, stars, markers);
  const line = tutorialGuide(seq, place);
  if (seq === null || !line) return null;
  if (stars.find((star) => star.ticId === ticId)?.progressStage === "completed")
    return null;
  if (isGuideClosed(storage, place, seq)) return null;
  return { seq, line };
}

type GuideStorage = Pick<Storage, "getItem" | "setItem">;
const guideId = (place: GuidePlace, seq: number) => `${place}:${seq}`;

// Closed in this page even when the store is blocked; listeners hear every
// close so the other guides (onboarding line, first-visit caption) can step
// in without waiting for a render of their own.
const closedHere = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
export const guidesVersion = () => version;
export function subscribeGuides(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readClosed(storage: GuideStorage | null): string[] {
  try {
    const value: unknown = JSON.parse(
      storage?.getItem(TUTORIAL_GUIDE_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function isGuideClosed(
  storage: GuideStorage | null,
  place: GuidePlace,
  seq: number,
): boolean {
  const id = guideId(place, seq);
  return closedHere.has(id) || readClosed(storage).includes(id);
}

export function closeGuide(
  storage: GuideStorage | null,
  place: GuidePlace,
  seq: number,
): void {
  const closed = new Set(readClosed(storage));
  closed.add(guideId(place, seq));
  closedHere.add(guideId(place, seq));
  try {
    storage?.setItem(TUTORIAL_GUIDE_KEY, JSON.stringify([...closed]));
  } catch {
    // Closed for this page only.
  }
  version++;
  for (const listener of [...listeners]) listener();
}

/** Forget guides closed in this page (tests). */
export function resetGuidesHere(): void {
  closedHere.clear();
}

export function browserStorage(): GuideStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- first visit

/**
 * The automatic first-visit flight to tutorial 1 happens once per member,
 * not once per page load: "← 나의 은하" must leave the star, and a reload
 * must not fly back. Kept in the browser (the server has no such flag).
 */
export const FIRST_VISIT_KEY = "planetory:first-visit-flown";

function readFlown(storage: GuideStorage | null): string[] {
  try {
    const value: unknown = JSON.parse(
      storage?.getItem(FIRST_VISIT_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

const flownHere = new Set<string>();

export function firstVisitFlown(
  storage: GuideStorage | null,
  memberId: string,
): boolean {
  return flownHere.has(memberId) || readFlown(storage).includes(memberId);
}

/** Marks the flight as taken. True only the first time for this member. */
export function takeFirstVisitFlight(
  storage: GuideStorage | null,
  memberId: string,
): boolean {
  if (!memberId || firstVisitFlown(storage, memberId)) return false;
  flownHere.add(memberId);
  try {
    storage?.setItem(
      FIRST_VISIT_KEY,
      JSON.stringify([...new Set([...readFlown(storage), memberId])]),
    );
  } catch {
    // This page still remembers it.
  }
  return true;
}

/** Forget first-visit flights taken in this page (tests). */
export function resetFirstVisitHere(): void {
  flownHere.clear();
}
