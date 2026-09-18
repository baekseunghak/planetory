import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../../src/api/client.ts";
import {
  changedPostFields,
  codePoints,
  patchIsVisible,
  postValues,
  readCreatedPost,
  stripTitle,
  validatePost,
  type PostDraft,
} from "../../src/features/community/postContracts.ts";
import { decodeWritten } from "../../src/features/community/usePostWrite.ts";
const draft: PostDraft = {
  title: "관측",
  body: "기록",
  purposeTag: "GENERAL",
  ticId: "",
  board: "FREE",
};
test("post limits count Unicode code points, including astral emoji", () => {
  assert.equal(codePoints("🪐"), 1);
  assert.deepEqual(
    validatePost({
      ...draft,
      title: "🪐".repeat(100),
      body: "🪐".repeat(10000),
    }),
    {},
  );
  assert.ok(validatePost({ ...draft, title: "🪐".repeat(101) }).title);
  assert.ok(validatePost({ ...draft, body: "🪐".repeat(10001) }).body);
});
test("Java title strip, blank and line separators agree with backend", () => {
  assert.equal(stripTitle("\u3000 title \t"), "title");
  for (const body of ["", " \t\r\n", "\u2000\u3000"])
    assert.ok(validatePost({ ...draft, body }).body);
  for (const title of ["a\nb", "a\rB", "a\u0085b", "a\u2028b", "a\u2029b"])
    assert.ok(validatePost({ ...draft, title }).title);
  assert.deepEqual(
    validatePost({ ...draft, title: "\u00a0", body: "\u00a0" }),
    {},
  );
  assert.equal(postValues({ ...draft, body: "  본문\n" }).body, "  본문\n");
});
test("TIC IDs stay strings and cannot overflow signed 64-bit storage", () => {
  for (const ticId of ["", "0", "-1", "1e5", "9223372036854775808", "x"])
    assert.ok(validatePost({ ...draft, board: "STAR", ticId }).ticId);
  assert.deepEqual(
    validatePost({ ...draft, board: "STAR", ticId: "9223372036854775807" }),
    {},
  );
  assert.ok(validatePost({ ...draft, purposeTag: "toString" }).purposeTag);
});
test("PATCH preserves unrelated concurrent fields and expresses explicit TIC removal", () => {
  const baseline = { ...postValues(draft), ticId: "259377017" };
  assert.deepEqual(
    changedPostFields(baseline, { ...draft, title: " 새 제목 " }),
    { title: "새 제목", ticId: null },
  );
  assert.equal(
    patchIsVisible(
      { ...baseline, body: "동시 수정", title: "새 제목" },
      { title: "새 제목" },
    ),
    true,
  );
  assert.deepEqual(changedPostFields(postValues(draft), draft), {});
});
test("invalid successful write DTO is uncertain, never a safe retry", () => {
  assert.throws(
    () => decodeWritten({}, readCreatedPost),
    (error: unknown) => error instanceof ApiError && error.outcomeUnknown,
  );
  assert.deepEqual(
    readCreatedPost({ postId: "p-1", createdAt: "2026-09-18T00:00:00Z" }),
    { postId: "p-1", createdAt: "2026-09-18T00:00:00Z" },
  );
});
