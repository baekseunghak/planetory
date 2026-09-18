import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commentError,
  readCreatedComment,
} from "../../src/features/community/commentContracts";
test("comments count Unicode code points and use server whitespace rules", () => {
  assert.ok(commentError(" \n\t"));
  assert.equal(commentError("🪐"), "");
  assert.equal(commentError("🪐".repeat(2000)), "");
  assert.ok(commentError("🪐".repeat(2001)));
  assert.equal(commentError("\u00a0"), "");
});
test("create identity and UTC timestamp must be usable before clearing draft", () => {
  assert.throws(() => readCreatedComment({ commentId: 2, createdAt: "today" }));
  assert.deepEqual(
    readCreatedComment({ commentId: "c-8", createdAt: "2026-09-18T01:00:00Z" }),
    { commentId: "c-8", createdAt: "2026-09-18T01:00:00Z" },
  );
});
