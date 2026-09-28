import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  emitAnalysis,
  resetAnalysisBridge,
  type AnalysisOutcome,
} from "../../src/cinema/analysis/bridge";
import { createNoopSceneController } from "../../src/cinema/scene/contract";
import type { Star } from "../../src/features/sky-data/contracts";
import {
  NEW_STARS_KEPT,
  NEW_STARS_KEY,
  NEW_STAR_MARK_LIMIT,
  addNewStars,
  markedNewStars,
  newStarsOf,
  nextNewStar,
  openNewStar,
  pruneNewStars,
  resetNewStarsHere,
} from "../../src/cinema/shell/new-stars";
import { SequenceDirector } from "../../src/cinema/shell/sequences";

// "새로 열린 별": stars a member unlocked and has not opened yet, kept per
// member on this browser, most recently unlocked last.

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}
const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};
const stored = (storage: ReturnType<typeof memoryStorage>) =>
  JSON.parse(storage.data.get(NEW_STARS_KEY) ?? "null");

const star = (
  ticId: string,
  progressStage: Star["progressStage"] = "unexplored",
): Star => ({
  ticId,
  x: 0,
  y: 0,
  depthZ: 0,
  layoutOrdinal: 0,
  planetCount: 0,
  progressStage,
  completedWithoutPlanets: false,
  marker: null,
  reopened: false,
});

test("unlocked stars are added once, the latest last", () => {
  resetNewStarsHere();
  const storage = memoryStorage();
  assert.deepEqual(newStarsOf(storage, "u-209"), []);
  addNewStars(storage, "u-209", ["900001001"]);
  addNewStars(storage, "u-209", ["900001002", "900001003", "900001002"]);
  assert.deepEqual(newStarsOf(storage, "u-209"), [
    "900001001",
    "900001002",
    "900001003",
  ]);
  // Unlocked again: it becomes the latest, not a second entry.
  const list = addNewStars(storage, "u-209", ["900001001"]);
  assert.deepEqual(list, ["900001002", "900001003", "900001001"]);
  assert.deepEqual(stored(storage), {
    "u-209": ["900001002", "900001003", "900001001"],
  });
  // Nothing new: the same list back (the shell does not re-render).
  assert.equal(addNewStars(storage, "u-209", []), list);
  assert.equal(addNewStars(storage, "u-209", ["not-a-tic"]), list);
  assert.equal(newStarsOf(storage, "u-209"), list);
  // No member, no list.
  assert.deepEqual(addNewStars(storage, "", ["900001004"]), []);
  // A reload reads what was kept.
  resetNewStarsHere();
  assert.deepEqual(newStarsOf(storage, "u-209"), list);
});

test("rings go on the ten most recent; the chip goes to the latest first", () => {
  resetNewStarsHere();
  const storage = memoryStorage();
  const ids = Array.from({ length: 14 }, (_, i) => String(900001001 + i));
  let list = addNewStars(storage, "u-209", ids);
  assert.equal(NEW_STAR_MARK_LIMIT, 10);
  const marked = markedNewStars(list);
  assert.equal(marked.length, 10);
  assert.deepEqual(marked.slice(0, 2), ["900001014", "900001013"]);
  assert.equal(marked.at(-1), "900001005");
  assert.deepEqual(markedNewStars(list.slice(0, 3)), [
    "900001003",
    "900001002",
    "900001001",
  ]);
  assert.deepEqual(markedNewStars(list, 0), []);
  // Each press opens the latest, which then is not new: the count goes down.
  const visited: string[] = [];
  while (list.length > 11) {
    const next = nextNewStar(list)!;
    visited.push(next);
    list = openNewStar(storage, "u-209", next);
  }
  assert.deepEqual(visited, ["900001014", "900001013", "900001012"]);
  assert.equal(list.length, 11);
  // The eleventh-newest now gets a ring.
  assert.equal(markedNewStars(list).at(-1), "900001002");
  assert.equal(nextNewStar([]), null);
});

test("opening a star (panel or analysis) ends its mark", () => {
  resetNewStarsHere();
  const storage = memoryStorage();
  addNewStars(storage, "u-209", ["900001001", "900001002"]);
  const list = openNewStar(storage, "u-209", "900001001");
  assert.deepEqual(list, ["900001002"]);
  assert.deepEqual(stored(storage), { "u-209": ["900001002"] });
  // A star that was not new: nothing changes.
  assert.equal(openNewStar(storage, "u-209", "149603524"), list);
  // The last one opened: the member's entry goes away.
  assert.deepEqual(openNewStar(storage, "u-209", "900001002"), []);
  assert.deepEqual(stored(storage), {});
});

test("the loaded sky drops what is explored or gone, never while loading", () => {
  resetNewStarsHere();
  const storage = memoryStorage();
  storage.setItem(
    NEW_STARS_KEY,
    JSON.stringify({ "u-209": ["900001001", "900001002", "900001003", "9"] }),
  );
  const loading = [star("900001001", "completed")];
  const before = newStarsOf(storage, "u-209");
  // Still loading (or only part of the sky): proves nothing.
  assert.equal(
    pruneNewStars(storage, "u-209", { stars: loading, complete: false }),
    before,
  );
  const sky = {
    stars: [
      star("900001001", "completed"),
      star("900001002", "in_progress"),
      star("900001003"),
      star("149603524"),
    ],
    complete: true,
  };
  assert.deepEqual(pruneNewStars(storage, "u-209", sky), ["900001003"]);
  assert.deepEqual(stored(storage), { "u-209": ["900001003"] });
  // Unchanged: the same list back.
  const kept = newStarsOf(storage, "u-209");
  assert.equal(pruneNewStars(storage, "u-209", sky), kept);
});

test("a star unlocked in this page waits for the sky that brings it", () => {
  resetNewStarsHere();
  const storage = memoryStorage();
  // The result comes first; the refreshed sky lands a moment later.
  addNewStars(storage, "u-209", ["900001001"]);
  const old = { stars: [star("149603524")], complete: true };
  assert.deepEqual(pruneNewStars(storage, "u-209", old), ["900001001"]);
  const refreshed = {
    stars: [star("149603524"), star("900001001")],
    complete: true,
  };
  assert.deepEqual(pruneNewStars(storage, "u-209", refreshed), ["900001001"]);
  // Once the sky has shown it, a sky without it means it is gone.
  assert.deepEqual(pruneNewStars(storage, "u-209", old), []);
  // After a reload nothing is waiting: a star the sky does not have goes.
  addNewStars(storage, "u-209", ["900001002"]);
  resetNewStarsHere();
  assert.deepEqual(pruneNewStars(storage, "u-209", old), []);
});

test("each member has their own list", () => {
  resetNewStarsHere();
  const storage = memoryStorage();
  addNewStars(storage, "u-209", ["900001001"]);
  addNewStars(storage, "u-300", ["900002001", "900002002", "900001001"]);
  openNewStar(storage, "u-300", "900001001");
  assert.deepEqual(newStarsOf(storage, "u-209"), ["900001001"]);
  assert.deepEqual(newStarsOf(storage, "u-300"), ["900002001", "900002002"]);
  // One member's sky says nothing about the other's stars.
  resetNewStarsHere();
  pruneNewStars(storage, "u-300", { stars: [], complete: true });
  assert.deepEqual(stored(storage), { "u-209": ["900001001"] });
  assert.deepEqual(newStarsOf(storage, "u-209"), ["900001001"]);
  assert.deepEqual(newStarsOf(storage, "u-300"), []);
});

test("a blocked or broken store still works for the visit", () => {
  resetNewStarsHere();
  assert.deepEqual(addNewStars(throwing, "u-209", ["900001001"]), [
    "900001001",
  ]);
  assert.deepEqual(newStarsOf(throwing, "u-209"), ["900001001"]);
  assert.deepEqual(openNewStar(throwing, "u-209", "900001001"), []);
  assert.deepEqual(addNewStars(null, "u-300", ["900001002"]), ["900001002"]);
  resetNewStarsHere();
  assert.deepEqual(newStarsOf(throwing, "u-209"), []);
  assert.deepEqual(newStarsOf(null, "u-209"), []);
  // Unreadable or odd values read as nothing (or only the valid TICs).
  const storage = memoryStorage();
  for (const value of ["{", "[]", '"x"', "null", '{"u-209":"900001001"}']) {
    resetNewStarsHere();
    storage.data.set(NEW_STARS_KEY, value);
    assert.deepEqual(newStarsOf(storage, "u-209"), [], value);
  }
  resetNewStarsHere();
  storage.data.set(
    NEW_STARS_KEY,
    JSON.stringify({ "u-209": ["900001001", 7, "x", "900001001"] }),
  );
  assert.deepEqual(newStarsOf(storage, "u-209"), ["900001001"]);
  // A broken value is replaced on the next write, other members kept.
  resetNewStarsHere();
  storage.data.set(NEW_STARS_KEY, "{");
  addNewStars(storage, "u-209", ["900001002"]);
  assert.deepEqual(stored(storage), { "u-209": ["900001002"] });
});

test("the kept list is bounded, the oldest dropped first", () => {
  resetNewStarsHere();
  const storage = memoryStorage();
  const ids = Array.from({ length: NEW_STARS_KEPT + 5 }, (_, i) =>
    String(910000000 + i),
  );
  const list = addNewStars(storage, "u-209", ids);
  assert.equal(list.length, NEW_STARS_KEPT);
  assert.equal(list[0], "910000005");
  assert.equal(nextNewStar(list), ids.at(-1));
});

function outcome(patch: Partial<AnalysisOutcome> = {}): AnalysisOutcome {
  return {
    kind: "matched",
    ticId: "307210830",
    submissionId: "s-1",
    historyId: "h-1",
    submissionKind: "candidate",
    matchStatus: "matched",
    evaluation: "AGREES",
    userJudgment: "LIKELY_PLANET",
    firstView: true,
    created: true,
    planet: null,
    revealsPlanet: false,
    submitted: {
      periodDays: 3.69,
      phaseStart: 0.99,
      phaseEnd: 1.01,
      durationHours: 1,
    },
    achievement: {
      result: "recognized",
      newlyRecognized: true,
      unlockedTicIds: ["900001001"],
      starCount: 1,
      grade: null,
    },
    skyVersion: "u-test:2",
    progress: {
      stage: "in_progress",
      remainingDiscoverableCount: 2,
      matchedCandidateIds: [],
    },
    nextActions: [],
    ...patch,
  };
}

test("the director reports unlocks as they arrive: first view only, no mismatch", () => {
  resetAnalysisBridge();
  const unlocks: [readonly string[], boolean][] = [];
  const tic = { current: "307210830" as string | null };
  const director = new SequenceDirector({
    scene: () => createNoopSceneController(),
    memberId: "u-test",
    analysisTic: () => tic.current,
    planetLabel: () => null,
    onUnlock: (ticIds, ignites) => unlocks.push([ticIds, ignites]),
  });
  const stop = director.start();
  // On stage: it will ignite once the galaxy is back.
  emitAnalysis("outcome", outcome());
  // Several analyses before going back: each one's stars, in order.
  emitAnalysis(
    "outcome",
    outcome({
      submissionId: "s-2",
      achievement: {
        ...outcome().achievement,
        unlockedTicIds: ["900001002"],
      },
    }),
  );
  assert.deepEqual(director.takeIgnitions(), ["900001001", "900001002"]);
  // A replay, a judgment mismatch or nothing unlocked: not new stars.
  emitAnalysis("outcome", outcome({ submissionId: "s-3", firstView: false }));
  emitAnalysis(
    "outcome",
    outcome({
      submissionId: "s-4",
      kind: "judgmentMismatch",
      achievement: {
        ...outcome().achievement,
        result: "judgment_mismatch",
        unlockedTicIds: ["900001009"],
      },
    }),
  );
  emitAnalysis(
    "outcome",
    outcome({
      submissionId: "s-5",
      achievement: { ...outcome().achievement, unlockedTicIds: [] },
    }),
  );
  // Settled after the member left the analysis: no ignition, still new.
  tic.current = null;
  emitAnalysis(
    "outcome",
    outcome({
      submissionId: "s-6",
      achievement: {
        ...outcome().achievement,
        unlockedTicIds: ["900001003"],
      },
    }),
  );
  assert.deepEqual(unlocks, [
    [["900001001"], true],
    [["900001002"], true],
    [["900001003"], false],
  ]);
  assert.equal(director.hasIgnitions(), false);
  stop();
});

test("the dev session switch forgets the new stars of the old world", () => {
  const plugin = readFileSync(
    new URL("../../dev/cinema-fixture-plugin.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    plugin.includes(`localStorage.removeItem("${NEW_STARS_KEY}")`),
    "switchPage removes the new-star key",
  );
});
