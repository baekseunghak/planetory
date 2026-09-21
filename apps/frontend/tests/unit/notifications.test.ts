import test from "node:test";
import assert from "node:assert/strict";
import {
  noticeDestination,
  readNotice,
  readNotices,
  readUnread,
} from "../../src/features/notifications/contracts.ts";
const row = {
  notificationId: "n",
  kind: "FOLLOW",
  createdAt: "2026-09-21T00:00:00Z",
  read: false,
  available: true,
  title: "hello",
  body: "private",
};
test("unavailable notifications discard stale private text", () => {
  const parsed = readNotice({ ...row, available: false });
  assert.ok(!JSON.stringify(parsed).includes("private"));
  assert.notEqual(parsed.title, "hello");
});
test("notification targets only allow owned structured destinations", () => {
  assert.equal(
    noticeDestination(
      {
        notificationId: "n",
        available: true,
        target: {
          kind: "POST",
          postId: "a/b",
          commentId: "c",
          discussionCursor: "opaque",
        },
      },
      "n",
    ),
    "/posts/a%2Fb?discussionCursor=opaque#discussion",
  );
  assert.equal(
    noticeDestination({ notificationId: "n", available: false }, "n"),
    null,
  );
  assert.throws(() =>
    noticeDestination(
      {
        notificationId: "n",
        available: true,
        target: { kind: "URL", url: "https://evil.invalid" },
      },
      "n",
    ),
  );
  assert.throws(() =>
    noticeDestination({ notificationId: "other", available: false }, "n"),
  );
});
test("read-all requires a server snapshot boundary and finite counts", () => {
  assert.throws(() =>
    readNotices({ items: [row], hasNext: false, nextCursor: null }),
  );
  assert.throws(() => readUnread({ unreadCount: -1 }));
  assert.equal(
    readNotices({
      items: [row],
      hasNext: false,
      nextCursor: null,
      readBoundary: "opaque",
    }).readBoundary,
    "opaque",
  );
});
