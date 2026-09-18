import { test } from "node:test";
import assert from "node:assert/strict";
import { ReactionStore } from "../../src/features/community/reactionStore";
import { ApiError } from "../../src/api/client";
import {
  readReactionSummary,
  readReactors,
} from "../../src/features/community/reactionContracts";
const post = (myReaction = "NONE", agree = 0, disagree = 0) => ({
  postId: "p-1",
  title: "글",
  body: "본문",
  purposeTag: "GENERAL",
  ticId: null,
  author: { memberId: "u-1", nickname: "회원" },
  createdAt: "2026-09-18T01:00:00Z",
  updatedAt: "2026-09-18T01:00:00Z",
  commentCount: 0,
  reactionSummary: { myReaction, agree, disagree },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { resolve, promise };
};
test("queued final choice is sent only after acknowledgement and stale reads cannot overwrite it", async () => {
  const old = deferred<unknown>(),
    first = deferred<unknown>();
  let reads = 0;
  const writes: string[] = [];
  const store = new ReactionStore("p-1", async (_path, options) => {
    if (options?.method === "PUT") {
      const r = (options.json as { reaction: string }).reaction;
      writes.push(r);
      return writes.length === 1
        ? first.promise
        : { postId: "p-1", myReaction: r, agree: 0, disagree: 1 };
    }
    return ++reads === 1 ? post() : old.promise;
  });
  await store.refresh();
  const background = store.refresh();
  old.resolve(post());
  await background;
  const pending = store.choose("AGREE");
  void store.choose("DISAGREE");
  assert.deepEqual(writes, ["AGREE"]);
  assert.equal(store.getSnapshot().wanted, "DISAGREE");
  first.resolve({ postId: "p-1", myReaction: "AGREE", agree: 1, disagree: 0 });
  await pending;
  assert.deepEqual(writes, ["AGREE", "DISAGREE"]);
  assert.equal(store.getSnapshot().summary?.myReaction, "DISAGREE");
  store.dispose();
});
test("response loss stops queue and does not retry until explicit fresh read and user action", async () => {
  let count = 0;
  const store = new ReactionStore("p-1", async (_path, options) => {
    if (options?.method) {
      count++;
      throw new ApiError(0, "NETWORK_ERROR", "lost", [], null, null, true);
    }
    return post();
  });
  await store.refresh();
  await store.choose("AGREE");
  await store.choose("DISAGREE");
  assert.equal(count, 1);
  assert.equal(store.getSnapshot().uncertain, true);
  await store.refresh();
  assert.equal(store.getSnapshot().uncertain, false);
  assert.equal(count, 1);
  store.dispose();
});
test("disposed and superseded GETs cannot restore a previous member or old summary", async () => {
  const a = deferred<unknown>(),
    b = deferred<unknown>();
  let reads = 0;
  const store = new ReactionStore("p-1", () =>
    ++reads === 1 ? a.promise : b.promise,
  );
  const one = store.refresh(),
    two = store.refresh();
  b.resolve(post("AGREE", 1));
  await two;
  a.resolve(post());
  await one;
  assert.equal(store.getSnapshot().wanted, "AGREE");
  store.dispose();
});
test("invalid counts, missing choice, duplicate reactors and looping cursors fail closed", () => {
  assert.throws(() =>
    readReactionSummary({ myReaction: "AGREE", agree: 0, disagree: 0 }),
  );
  assert.throws(() =>
    readReactionSummary({ myReaction: null, agree: 1, disagree: 0 }),
  );
  assert.throws(() =>
    readReactors(
      {
        items: [
          { memberId: "u-1", nickname: "a" },
          { memberId: "u-1", nickname: "b" },
        ],
        hasNext: false,
        nextCursor: null,
      },
      null,
    ),
  );
  assert.throws(() =>
    readReactors(
      {
        items: [{ memberId: "u-1", nickname: "a" }],
        hasNext: true,
        nextCursor: "same",
      },
      "same",
    ),
  );
});
