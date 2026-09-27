import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedSearchHref,
  feedSearchParams,
  readFeedSearch,
  validateFeedSearch,
} from "../../src/features/community/feedSearch";
const base = readFeedSearch(new URLSearchParams()).values;
test("default star route sends the supported TIC and STAR combination", () => {
  const result = readFeedSearch(new URLSearchParams(), "259377017");
  assert.equal(result.error, null);
  const params = feedSearchParams(result.values);
  params.set("size", "20");
  assert.equal(params.toString(), "ticId=259377017&board=STAR&size=20");
});
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
    "ticId=1&board=FREE",
    "ticId=",
    "board=",
    "tag=",
    "author=%20",
    "cursor=",
    "size=0",
    "size=20&size=20",
    "unknown=value",
    "q=a%00b",
  ])
    assert.ok(readFeedSearch(new URLSearchParams(query)).error, query);
});
test("JS whitespace and author text survive normalized request generation", () => {
  const values = readFeedSearch(new URLSearchParams({ q: "\u00a0a|b\ufeff", author: " Orbit " })).values;
  const params = feedSearchParams(values);
  assert.equal(params.get("q"), "a|b");
  assert.equal(params.get("author"), "Orbit");
  assert.equal(readFeedSearch(new URLSearchParams({ author: "SYSTEM" })).error, null);
  assert.equal(readFeedSearch(new URLSearchParams({ author: "a".repeat(1000) })).error, null);
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
test("star board links that carry returnTo open the board instead of a search error", () => {
  // The star panel, results page and profiles link to the board with returnTo.
  const fromPanel = readFeedSearch(new URLSearchParams("returnTo=%2Fsky%3Fstar%3D259377017"), "259377017");
  assert.equal(fromPanel.error, null);
  assert.equal(fromPanel.values.ticId, "259377017");
  assert.equal(fromPanel.values.board, "STAR");
  // The results page also repeats the route TIC.
  const fromResults = readFeedSearch(new URLSearchParams("ticId=259377017&returnTo=%2Fresults%2F259377017"), "259377017");
  assert.equal(fromResults.error, null);
  // returnTo is never sent to the feed API.
  assert.equal(feedSearchParams(fromPanel.values).has("returnTo"), false);
  // Real search conditions are still checked.
  assert.ok(readFeedSearch(new URLSearchParams("returnTo=%2Fsky&unknown=1"), "259377017").error);
  assert.ok(readFeedSearch(new URLSearchParams("returnTo=%2Fsky&ticId=1"), "259377017").error);
});
