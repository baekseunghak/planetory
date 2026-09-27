// "새로 열린 별": stars this member unlocked and has not opened yet. Each
// gets a ring in the galaxy (ScreenLabels NewStarMarks) and the "새 별 N개"
// chip walks through them. Kept per member on this browser, most recently
// unlocked last. The shell adds stars when a result unlocks them, drops one
// when the member opens it, and drops the ones the loaded sky says are no
// longer new. No React here, so unit tests can import it.
import type { Star } from "../../features/sky-data/contracts";

/** { [memberId]: ticIds }, most recently unlocked last. */
export const NEW_STARS_KEY = "planetory:new-stars";
/** Rings on the most recent ones only; the chip still counts them all. */
export const NEW_STAR_MARK_LIMIT = 10;
/** Kept per member at most, the oldest dropped first (a bound on storage). */
export const NEW_STARS_KEPT = 200;

export type NewStarList = readonly string[];
type NewStarStorage = Pick<Storage, "getItem" | "setItem">;

const NONE: NewStarList = Object.freeze([]);
const isTic = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,19}$/.test(value);

function readAll(storage: NewStarStorage | null): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(NEW_STARS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const lists: Record<string, string[]> = {};
    for (const [memberId, list] of Object.entries(value))
      if (Array.isArray(list))
        lists[memberId] = [...new Set(list.filter(isTic))];
    return lists;
  } catch {
    return {};
  }
}

// This page's copy of each member's list: read once, then kept here, so the
// shell gets the same list back until it changes, and a blocked store still
// works for the visit.
const here = new Map<string, NewStarList>();

export function newStarsOf(
  storage: NewStarStorage | null,
  memberId: string,
): NewStarList {
  if (!memberId) return NONE;
  let list = here.get(memberId);
  if (!list) {
    const stored = readAll(storage)[memberId];
    list = stored?.length ? stored : NONE;
    here.set(memberId, list);
  }
  return list;
}

function write(
  storage: NewStarStorage | null,
  memberId: string,
  list: NewStarList,
): NewStarList {
  const next = list.length ? list : NONE;
  here.set(memberId, next);
  try {
    const all = readAll(storage);
    if (next.length) all[memberId] = [...next];
    else delete all[memberId];
    storage?.setItem(NEW_STARS_KEY, JSON.stringify(all));
  } catch {
    // This page still remembers them.
  }
  return next;
}

// Unlocked in this page and not yet in the loaded sky: the sky refresh that
// brings them lands after the result, so a sky without them proves nothing.
const awaitingHere = new Set<string>();
const awaiting = (memberId: string, ticId: string) => `${memberId} ${ticId}`;

/** A result unlocked these stars. Unlocked again: they become the latest. */
export function addNewStars(
  storage: NewStarStorage | null,
  memberId: string,
  ticIds: readonly string[],
): NewStarList {
  const current = newStarsOf(storage, memberId);
  const added = [...new Set(ticIds.filter(isTic))];
  if (!memberId || !added.length) return current;
  for (const ticId of added) awaitingHere.add(awaiting(memberId, ticId));
  return write(
    storage,
    memberId,
    [...current.filter((id) => !added.includes(id)), ...added].slice(
      -NEW_STARS_KEPT,
    ),
  );
}

/** The member opened this star (its panel or its analysis): not new now. */
export function openNewStar(
  storage: NewStarStorage | null,
  memberId: string,
  ticId: string,
): NewStarList {
  const current = newStarsOf(storage, memberId);
  awaitingHere.delete(awaiting(memberId, ticId));
  if (!current.includes(ticId)) return current;
  return write(
    storage,
    memberId,
    current.filter((id) => id !== ticId),
  );
}

/**
 * Drops what the fully loaded sky says is no longer new: explored (in
 * progress or completed), or not in this member's sky at all. A sky still
 * loading proves nothing (`complete` false keeps everything), nor does one
 * that has not caught up with a star unlocked in this page yet.
 */
export function pruneNewStars(
  storage: NewStarStorage | null,
  memberId: string,
  sky: { stars: readonly Star[]; complete: boolean },
): NewStarList {
  const current = newStarsOf(storage, memberId);
  if (!sky.complete || !current.length) return current;
  const wanted = new Set(current);
  const stage = new Map<string, Star["progressStage"]>();
  for (const star of sky.stars)
    if (wanted.has(star.ticId)) stage.set(star.ticId, star.progressStage);
  const list = current.filter((id) => {
    const progress = stage.get(id);
    if (progress) awaitingHere.delete(awaiting(memberId, id));
    return progress
      ? progress === "unexplored"
      : awaitingHere.has(awaiting(memberId, id));
  });
  return list.length === current.length
    ? current
    : write(storage, memberId, list);
}

/** The stars that get a ring: the most recent first, `limit` at most. */
export function markedNewStars(
  list: NewStarList,
  limit = NEW_STAR_MARK_LIMIT,
): string[] {
  return limit > 0 ? list.slice(-limit).reverse() : [];
}

/** Where the chip goes next: the most recently unlocked star. */
export function nextNewStar(list: NewStarList): string | null {
  return list.at(-1) ?? null;
}

/** Forget this page's lists and pending unlocks (tests). */
export function resetNewStarsHere(): void {
  here.clear();
  awaitingHere.clear();
}
