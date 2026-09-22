import { ApiError } from "../../api/client";
import { readPage } from "../community/contracts";
export const noticeKinds = [
  "ACHIEVEMENT",
  "REOPEN",
  "CHALLENGE",
  "FOLLOW",
  "COMMENT",
] as const;
export type NoticeKind = (typeof noticeKinds)[number];
export function readNotificationPreferences(
  value: unknown,
): Record<NoticeKind, boolean> {
  const settings = object(object(value).preferences);
  for (const kind of noticeKinds)
    if (typeof settings[kind] !== "boolean")
      throw new ApiError(
        0,
        "INVALID_RESPONSE",
        "알림 수신 설정을 확인할 수 없습니다.",
      );
  return Object.fromEntries(
    noticeKinds.map((kind) => [kind, settings[kind]]),
  ) as Record<NoticeKind, boolean>;
}
export const noticeLabels: Record<NoticeKind, string> = {
  ACHIEVEMENT: "성과·등급",
  REOPEN: "다시 열린 탐사",
  CHALLENGE: "챌린지",
  FOLLOW: "팔로우 소식",
  COMMENT: "내 글의 댓글",
};
const fail = (): never => {
  throw new ApiError(0, "INVALID_RESPONSE", "알림 정보를 확인할 수 없습니다.");
};
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : fail());
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail();
export type Notice = {
  notificationId: string;
  kind: NoticeKind;
  createdAt: string;
  read: boolean;
  available: boolean;
  title: string;
  body: string;
};
export function readNotice(v: unknown): Notice {
  const r = object(v);
  if (
    !noticeKinds.includes(r.kind as NoticeKind) ||
    typeof r.read !== "boolean" ||
    typeof r.available !== "boolean"
  )
    return fail();
  const createdAt = text(r.createdAt);
  if (!/T.*Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt)))
    return fail();
  return {
    notificationId: text(r.notificationId),
    kind: r.kind as NoticeKind,
    createdAt,
    read: r.read,
    available: r.available,
    title: r.available ? text(r.title) : "지금은 확인할 수 없는 소식입니다",
    body: r.available
      ? typeof r.body === "string"
        ? r.body
        : fail()
      : "연결된 자료가 삭제되었거나 공개 범위가 바뀌었습니다.",
  };
}
export function readNotices(v: unknown, cursor?: string | null) {
  const r = object(v);
  return {
    ...readPage(v, readNotice, (n) => n.notificationId, cursor),
    readBoundary: text(r.readBoundary),
  };
}
export function readUnread(v: unknown) {
  return { unreadCount: count(object(v).unreadCount) };
}
export function readRead(v: unknown, id: string) {
  const r = object(v);
  if (r.notificationId !== id || r.read !== true) return fail();
  return { notificationId: id, read: true as const };
}
export function noticeDestination(v: unknown, id: string): string | null {
  const r = object(v);
  if (r.notificationId !== id || typeof r.available !== "boolean")
    return fail();
  if (!r.available) return null;
  const target = object(r.target),
    encoded = (key: string) => encodeURIComponent(text(target[key]));
  if (target.kind === "POST" || target.kind === "THREAD") {
    const parent =
      target.kind === "POST"
        ? "/posts/" + encoded("postId")
        : "/signal-threads/" + encoded("threadId");
    return (
      parent +
      (target.discussionCursor == null
        ? ""
        : "?discussionCursor=" + encoded("discussionCursor")) +
      (target.commentId == null ? "" : "#discussion")
    );
  }
  if (target.kind === "STAR") return "/sky?star=" + encoded("ticId");
  if (target.kind === "CHALLENGE")
    return "/sky?quest=challenge&roundId=" + encoded("roundId");
  return fail();
}
