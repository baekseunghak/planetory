import { test } from "node:test";
import assert from "node:assert/strict";
import { readHotTopics } from "../../src/features/community/contracts.ts";
import { ApiError } from "../../src/api/client.ts";
const topic = (id: string, n = 10) => ({
  type: "SIGNAL_THREAD",
  id,
  ticId: "9007199254740999",
  title: "신호",
  author: { type: "SYSTEM", displayName: "SYSTEM" },
  createdAt: "2025-01-01T00:00:00Z",
  commentCount: 0,
  judgmentSummary: {
    participantCount: n,
    likelyPlanet: n - 6,
    unlikelyPlanet: 3,
    unsure: 3,
  },
});
const page = (items: unknown[]) => ({
  items,
  nextCursor: null,
  hasNext: false,
});
const invalid = (error: unknown) =>
  error instanceof ApiError && error.code === "INVALID_RESPONSE";
test("hot topics accept 10/11 and all judgments, preserve opaque IDs and server order", () => {
  const input = page([topic("9007199254740999", 10), topic("second", 11)]);
  const result = readHotTopics(input);
  // Do not substitute a browser ranking for the server response.
  assert.deepEqual(
    result.items.map((x) => x.id),
    ["9007199254740999", "second"],
  );
  assert.equal(result.items[0].ticId, "9007199254740999");
  assert.deepEqual(
    result.items[0].judgmentSummary,
    topic("9007199254740999", 10).judgmentSummary,
  );
  assert.deepEqual(readHotTopics(page([])).items, []);
});
test("ineligible/mixed feed, missing summary and inconsistent counts are errors, not silently filtered", () => {
  for (const value of [
    topic("nine", 9),
    {
      ...topic("post"),
      type: "POST",
      author: { memberId: "1", nickname: "회원" },
    },
    { ...topic("missing"), judgmentSummary: undefined },
    {
      ...topic("bad"),
      judgmentSummary: {
        participantCount: 10,
        likelyPlanet: 1,
        unlikelyPlanet: 1,
        unsure: 1,
      },
    },
    { ...topic("personal"), author: { memberId: "1", nickname: "회원" } },
  ])
    assert.throws(() => readHotTopics(page([topic("ok"), value])), invalid);
});
test("hot topic pagination rejects malformed/repeated cursors and duplicate items", () => {
  const first = {
    ...page([topic("one")]),
    nextCursor: "opaque+/=",
    hasNext: true,
  };
  assert.equal(readHotTopics(first).nextCursor, "opaque+/=");
  assert.throws(() => readHotTopics(first, "opaque+/="), invalid);
  for (const value of [
    {},
    { ...first, nextCursor: null },
    page([topic("one"), topic("one")]),
  ])
    assert.throws(() => readHotTopics(value), invalid);
});
