import { test } from "node:test";
import assert from "node:assert/strict";
import { createScrollPositions } from "../../src/features/community/scrollPositions";
test("scroll cache evicts the least recently used page, refreshing reads and writes", () => {
  const cache = createScrollPositions(2);
  cache.set("a", 0);
  cache.set("b", 20);
  assert.equal(cache.get("a"), 0);
  cache.set("c", 30);
  assert.equal(cache.get("b"), undefined);
  cache.set("a", 40);
  cache.set("d", 50);
  assert.equal(cache.get("c"), undefined);
  assert.equal(cache.get("a"), 40);
  assert.equal(cache.get("d"), 50);
});
