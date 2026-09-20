import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  hasCelebrated,
  markCelebrated,
} from "../../src/features/analysis/celebration";

// 2.2절: 연출은 HTTP 상태가 아니라 회원·submissionId별 표시 이력으로 가른다.

const store = new Map<string, string>();
beforeEach(() => store.clear());
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

test("a submission celebrates once per member", () => {
  assert.equal(hasCelebrated("u-209", "sub-7000"), false);
  markCelebrated("u-209", "sub-7000");
  assert.equal(hasCelebrated("u-209", "sub-7000"), true);
  // 다른 제출은 별개다.
  assert.equal(hasCelebrated("u-209", "sub-7001"), false);
  // 다른 회원도 별개다. 같은 기기를 나눠 써도 남의 이력을 물려받지 않는다.
  assert.equal(hasCelebrated("u-777", "sub-7000"), false);
});

test("marking twice does not grow the history", () => {
  markCelebrated("u-209", "sub-7000");
  markCelebrated("u-209", "sub-7000");
  const saved = JSON.parse(store.get("planetory:analysis-celebrated")!);
  assert.deepEqual(saved["u-209"], ["sub-7000"]);
});

test("the history is capped so storage cannot fill up", () => {
  for (let i = 0; i < 260; i++) markCelebrated("u-209", `sub-${i}`);
  const saved = JSON.parse(store.get("planetory:analysis-celebrated")!);
  assert.equal(saved["u-209"].length, 200);
  // 최근 것을 남긴다. 오래된 제출의 연출이 다시 나오는 쪽이 덜 나쁘다.
  assert.equal(saved["u-209"].at(-1), "sub-259");
  assert.equal(hasCelebrated("u-209", "sub-0"), false);
});

test("a broken store is read as no history, not as an error", () => {
  store.set("planetory:analysis-celebrated", "not json");
  assert.doesNotThrow(() => hasCelebrated("u-209", "sub-7000"));
  assert.equal(hasCelebrated("u-209", "sub-7000"), false);
  // 배열이 아닌 값도 마찬가지다.
  store.set("planetory:analysis-celebrated", JSON.stringify({ "u-209": 7 }));
  assert.equal(hasCelebrated("u-209", "sub-7000"), false);
});
