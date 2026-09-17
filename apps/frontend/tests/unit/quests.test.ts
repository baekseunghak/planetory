import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readQuests,
  readCurrentChallenge,
  tutorialMarkers,
  needsChallengeNotice,
  recordChallengeShown,
  challengeSeenKey,
} from "../../src/features/quests/contracts";
import {
  publishQuestChange,
  subscribeQuestChange,
} from "../../src/features/quests/events";
import { quests, current } from "../quests/fixtures";
test("quest decoder preserves locked IDs, completion/skip and nullable reopen count", () => {
  const q = quests(2, true);
  q.reopened = [
    { ticId: "900000001", reopenedAt: q.asOf, newDiscoverableCount: null },
  ];
  assert.deepEqual(readQuests(q), q);
  const markers = tutorialMarkers(q, new Set());
  assert.equal(markers.get("900000001")?.visible, false);
  assert.equal(markers.get("900000002")?.visible, false);
  assert.equal(markers.get("900000003")?.visible, true);
});
test("reject locked target leaks, inconsistent completion count, duplicate IDs and malformed rounds", () => {
  const leak = quests();
  leak.tutorial.items[1].ticId = "900000002";
  assert.throws(() => readQuests(leak));
  const badCount = quests();
  badCount.tutorial.completedCount = 1;
  assert.throws(() => readQuests(badCount));
  const dup = quests(2);
  dup.tutorial.items[1].ticId = "900000001";
  assert.throws(() => readQuests(dup));
  const wrongReason = quests();
  wrongReason.tutorial.items[0].completionReason = "skipped";
  assert.throws(() => readQuests(wrongReason));
  const bad = current(false);
  bad.round!.ticId = "900000006";
  assert.throws(() => readCurrentChallenge(bad));
  assert.deepEqual(readCurrentChallenge({ round: null, eligible: false }), {
    round: null,
    eligible: false,
    participantCount: null,
  });
});
test("notice is scoped by member, eligible/active, round; read does not write; failures do not grant access", () => {
  const values = new Map<string, string>(),
    storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
  assert.equal(needsChallengeNotice(storage, "a", current(false)), false);
  assert.equal(needsChallengeNotice(storage, "a", current()), true);
  assert.equal(values.size, 0);
  recordChallengeShown(storage, "a", "cr-208");
  assert.equal(needsChallengeNotice(storage, "a", current()), false);
  assert.equal(needsChallengeNotice(storage, "b", current()), true);
  const next = current();
  next.round!.roundId = "cr-209";
  assert.equal(needsChallengeNotice(storage, "a", next), true);
  next.round!.status = "closed";
  assert.equal(needsChallengeNotice(storage, "a", next), false);
  const blocked = {
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
  };
  assert.equal(needsChallengeNotice(blocked, "a", current()), true);
  assert.doesNotThrow(() => recordChallengeShown(blocked, "a", "cr-208"));
  assert.notEqual(challengeSeenKey("a"), challengeSeenKey("b"));
});
test("quest events are member-scoped, disposed and only invalidate reads", () => {
  const calls: string[] = [];
  const off = subscribeQuestChange("a", (e) => calls.push(e.reason));
  publishQuestChange("b", { reason: "submission" });
  assert.equal(calls.length, 0);
  publishQuestChange("a", { reason: "guide-closed" });
  publishQuestChange("a", { reason: "tutorial-skipped" });
  off();
  publishQuestChange("a", { reason: "submission" });
  assert.deepEqual(calls, ["guide-closed", "tutorial-skipped"]);
});
