import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertIdentity,
  endpoint,
  readAnalyses,
  readFeed,
  readPage,
  readSummary,
  readThread,
} from "../../src/features/community/contracts.ts";
const summary = {
  participantCount: 3,
  likelyPlanet: 1,
  unlikelyPlanet: 1,
  unsure: 1,
  percentages: { likelyPlanet: 33.3, unlikelyPlanet: 33.3, unsure: 33.3 },
  asOf: "2026-09-18T01:00:00Z",
};
test("judgment summary uses server participants and rejects impossible distributions", () => {
  assert.equal(readSummary(summary, true).participantCount, 3);
  for (const changed of [
    { participantCount: 1 },
    { likelyPlanet: -1 },
    { percentages: { likelyPlanet: 99, unlikelyPlanet: 1, unsure: 0 } },
    { asOf: "1432.2" },
  ])
    assert.throws(() => readSummary({ ...summary, ...changed }, true));
  assert.equal(
    readSummary(
      {
        ...summary,
        participantCount: 0,
        likelyPlanet: 0,
        unlikelyPlanet: 0,
        unsure: 0,
        percentages: null,
      },
      true,
    ).percentages,
    null,
  );
});
test("opaque cursors, missing lists, duplicates and repeated cursor cannot become endless pages", () => {
  const page = { items: ["a"], nextCursor: "opaque+/=", hasNext: true };
  assert.equal(readPage(page, String, String).nextCursor, "opaque+/=");
  for (const changed of [
    { items: undefined },
    { items: ["a", "a"] },
    { nextCursor: null },
    { items: [] },
  ])
    assert.throws(() => readPage({ ...page, ...changed }, String, String));
  assert.throws(() => readPage(page, String, String, "opaque+/="));
  assert.equal(
    endpoint("/v1/list", { cursor: "opaque+/=", judgment: null }),
    "/v1/list?cursor=opaque%2B%2F%3D",
  );
});
test("thread SYSTEM author cannot be replaced with a personal author; IDs are not coerced", () => {
  const thread = {
    threadId: "st-301",
    ticId: "9007199254740999",
    candidateId: "c-1",
    title: "신호",
    author: { type: "SYSTEM", displayName: "SYSTEM" },
    judgmentSummary: summary,
  };
  assert.equal(readThread(thread).ticId, "9007199254740999");
  assert.throws(() => readThread({ ...thread, ticId: 123 }));
  assert.throws(() =>
    readThread({ ...thread, author: { memberId: "u-1", nickname: "회원" } }),
  );
  assert.throws(() => assertIdentity("st-other", "st-301"));
});
test("public list may include multiple records per participant, never used as N", () => {
  const item = {
    author: { memberId: "u-1", nickname: "회원" },
    submittedAt: "2026-09-18T01:00:00Z",
    judgment: "UNSURE",
  };
  const page = readAnalyses({
    items: [
      { ...item, analysisId: "pa-1", contributesToSummary: true },
      { ...item, analysisId: "pa-2", contributesToSummary: false },
    ],
    nextCursor: null,
    hasNext: false,
  });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[1].author.memberId, page.items[0].author.memberId);
  assert.throws(() =>
    readAnalyses({
      items: [{ ...item, analysisId: "pa-1", judgment: "UNKNOWN" }],
      nextCursor: null,
      hasNext: false,
    }),
  );
});
test("feed accepts same string ID across different content types but rejects unknown content", () => {
  const base = {
    id: "123",
    ticId: "1",
    title: "제목",
    createdAt: "2026-09-18T01:00:00Z",
    commentCount: 0,
  };
  const items = [
    { ...base, type: "POST", author: { memberId: "u-1", nickname: "회원" } },
    {
      ...base,
      type: "SIGNAL_THREAD",
      author: { type: "SYSTEM", displayName: "SYSTEM" },
      judgmentSummary: summary,
    },
  ];
  assert.equal(
    readFeed({ items, nextCursor: null, hasNext: false }).items.length,
    2,
  );
  const withdrawn = readFeed({
    items: [{ ...items[0], author: { memberId: null, nickname: "탈퇴한 회원" } }],
    nextCursor: null,
    hasNext: false,
  });
  assert.deepEqual(withdrawn.items[0].author, { memberId: null, nickname: "탈퇴한 회원" });
  assert.throws(() => readFeed({ items: [{ ...items[0], author: { memberId: null, nickname: "회원" } }],
    nextCursor: null, hasNext: false }));
  assert.throws(() =>
    readFeed({
      items: [{ ...items[0], type: "MYSTERY" }],
      nextCursor: null,
      hasNext: false,
    }),
  );
});
