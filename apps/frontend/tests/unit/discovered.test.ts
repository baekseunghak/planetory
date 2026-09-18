import test from "node:test";
import assert from "node:assert/strict";
import {
  discoveredPath,
  readDiscoveredPage,
  readQuestLinks,
} from "../../src/features/sky-renderer/discovered.ts";
const item = {
  ticId: "9007199254740993123",
  progressStage: "unexplored",
  planetCount: 0,
  completedWithoutPlanets: false,
  achievementCount: 0,
  grade: null,
  currentCurveStep: null,
  reopenPending: false,
  reopened: false,
  unpublishedSignalCount: 0,
  lastActivityAt: "2026-09-17T00:00:00Z",
};
test("discovered cursor is opaque/encoded and IDs/null unsubmitted stage never become numbers/zero", () => {
  const cursor = "x+/=& ?";
  const url = new URL(discoveredPath(cursor), "https://example.test");
  assert.equal(url.searchParams.get("scope"), "discovered");
  assert.equal(url.searchParams.get("cursor"), cursor);
  assert.equal(url.searchParams.get("size"), "20");
  assert.equal(url.searchParams.has("page"), false);
  assert.deepEqual(
    readDiscoveredPage({ items: [item], nextCursor: null, hasNext: false })
      .items[0],
    item,
  );
});
test("list rejects malformed/duplicate/private/contradictory response instead of empty success", () => {
  const page = { items: [item], nextCursor: null, hasNext: false };
  for (const bad of [
    null,
    {},
    { ...page, items: undefined },
    { ...page, items: [item, item] },
    { ...page, hasNext: true },
    { ...page, nextCursor: "" },
    { ...page, items: [], nextCursor: "a", hasNext: true },
    ...[
      { ticId: 1 },
      { planetCount: -1 },
      { grade: "unknown" },
      { currentCurveStep: undefined },
      { unpublishedSignalCount: undefined },
      { lastActivityAt: "broken" },
      { progressStage: "locked" },
      { completedWithoutPlanets: true },
    ].map((patch) => ({ ...page, items: [{ ...item, ...patch }] })),
  ])
    assert.throws(() => readDiscoveredPage(bad));
});
const quests = () => ({
  tutorial: {
    items: Array.from({ length: 5 }, (_, i) => ({
      seq: i + 1,
      status: i ? "locked" : "unlocked",
      ticId: i ? null : "1",
      completionReason: null,
    })),
  },
  challenge: { ticId: null, unlocked: false },
  reopened: [],
});
test("locked quests remain generic text and must never expose a TIC", () => {
  assert.equal(
    readQuestLinks(quests()).filter((q) => q.ticId !== null).length,
    1,
  );
  const bad = quests();
  bad.tutorial.items[1].ticId = "2";
  assert.throws(() => readQuestLinks(bad));
  assert.throws(() =>
    readQuestLinks({ ...quests(), challenge: { unlocked: false, ticId: "3" } }),
  );
});
