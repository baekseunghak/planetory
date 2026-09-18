import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedSearchHref,
  feedSearchParams,
  readFeedSearch,
  validateFeedSearch,
} from "../../src/features/community/feedSearch";
const base = readFeedSearch(new URLSearchParams()).values;
test("q trims edges, preserves internal spaces and encodes literals exactly once", () => {
  const params = feedSearchParams({ ...base, q: "  10%_ + A&B  두  공백  " });
  assert.equal(
    new URLSearchParams(params.toString()).get("q"),
    "10%_ + A&B  두  공백",
  );
  assert.equal(params.get("searchIn"), "TITLE_BODY");
  assert.equal(validateFeedSearch({ ...base, q: "⭐".repeat(100) }), null);
  assert.ok(validateFeedSearch({ ...base, q: "⭐".repeat(101) }));
  assert.ok(validateFeedSearch({ ...base, q: "   " }));
});
test("all six conditions survive URL round trip while cursor is never copied", () => {
  const values = {
    q: "TOI",
    searchIn: "BODY",
    author: "Orbit",
    ticId: "9007199254740993",
    board: "STAR",
    tag: "QUESTION",
  };
  const link = feedSearchHref("/community", values);
  assert.deepEqual(readFeedSearch(new URL(link, "http://local").searchParams), {
    values,
    error: null,
  });
  assert.equal(new URL(link, "http://local").searchParams.has("cursor"), false);
  assert.equal(feedSearchParams(base).has("searchIn"), false);
});
test("malformed direct addresses cannot silently broaden the search", () => {
  for (const query of [
    "q=",
    "q=%20",
    "searchIn=TITLE",
    "board=PRIVATE",
    "tag=UNKNOWN",
    "q=a&searchIn=COMMENTS",
    "q=a&q=b",
    "cursor=a&cursor=b",
    "ticId=-1",
  ])
    assert.ok(readFeedSearch(new URLSearchParams(query)).error, query);
});
test("TIC filters share the positive signed-64-bit range across form, URL and star board", () => {
  for (const ticId of ["1", "9007199254740993", "9223372036854775807"]) {
    assert.equal(validateFeedSearch({ ...base, ticId }), null);
    assert.equal(feedSearchParams({ ...base, ticId }).get("ticId"), ticId);
    assert.equal(readFeedSearch(new URLSearchParams({ ticId })).error, null);
    assert.equal(readFeedSearch(new URLSearchParams(), ticId).error, null);
  }
  assert.equal(validateFeedSearch({ ...base, ticId: "" }), null);
  assert.equal(
    validateFeedSearch({ ...base, ticId: " 9223372036854775807 " }),
    null,
  );
  for (const ticId of [
    "0",
    "-1",
    "01",
    "1.5",
    "1e3",
    "abc",
    "9223372036854775808",
    "9999999999999999999",
    "1".repeat(20),
  ]) {
    assert.ok(validateFeedSearch({ ...base, ticId }), ticId);
    assert.ok(readFeedSearch(new URLSearchParams({ ticId })).error, ticId);
    assert.ok(readFeedSearch(new URLSearchParams(), ticId).error, ticId);
  }
});
test("star board anchors TIC and board while preserving text filters", () => {
  const result = readFeedSearch(new URLSearchParams("q=빛"), "259377017");
  assert.equal(result.values.ticId, "259377017");
  assert.equal(result.values.board, "STAR");
  assert.ok(
    readFeedSearch(new URLSearchParams("board=FREE"), "259377017").error,
  );
  const url = feedSearchHref(
    "/stars/259377017/community",
    result.values,
    "259377017",
  );
  assert.ok(!url.includes("ticId="));
  assert.ok(!url.includes("board="));
});
