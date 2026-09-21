import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readRelation,
  readFollowSummary,
  readFollowing,
  readFollowingFeed,
} from "../../src/features/follow/contracts.ts";
test("follow response must identify the requested target and use actual boolean", () => {
  const t = { kind: "STAR" as const, id: "259377017" };
  assert.equal(readRelation({ ...t, following: true }, t).following, true);
  assert.throws(() =>
    readRelation({ ...t, id: "307210830", following: true }, t),
  );
  assert.throws(() => readRelation({ ...t, following: "false" }, t));
});
test("missing or invalid profile counts never become invented zeroes", () => {
  assert.throws(() =>
    readFollowSummary({ memberId: "u-1", followers: 0 }, "u-1"),
  );
  assert.throws(() =>
    readFollowSummary(
      {
        memberId: "u-1",
        followers: -1,
        followingMembers: 0,
        followingStars: 0,
      },
      "u-1",
    ),
  );
});
test("follow lists reject repeated targets and non-advancing cursor", () => {
  const t = { kind: "MEMBER", id: "u-1", label: "관측자" };
  assert.throws(() =>
    readFollowing({ items: [t, t], nextCursor: null, hasNext: false }),
  );
  assert.throws(() =>
    readFollowing({ items: [t], nextCursor: "same", hasNext: true }, "same"),
  );
});
test("overlapping feed rejects duplicate items but retains both reasons", () => {
  const i = {
    type: "POST",
    id: "p-1",
    ticId: null,
    title: "관측",
    author: { memberId: "u-1", nickname: "관측자" },
    createdAt: "2026-09-21T00:00:00Z",
    commentCount: 0,
    matchedBy: ["MEMBER", "STAR"],
  };
  assert.deepEqual(
    readFollowingFeed({ items: [i], nextCursor: null, hasNext: false }).items[0]
      .matchedBy,
    ["MEMBER", "STAR"],
  );
  assert.throws(() =>
    readFollowingFeed({ items: [i, i], nextCursor: null, hasNext: false }),
  );
});
