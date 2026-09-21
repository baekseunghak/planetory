import { ApiError } from "../../api/client";
import { readFeed, readPage } from "../community/contracts";

export type FollowKind = "MEMBER" | "STAR";
export type FollowTarget = { kind: FollowKind; id: string; label: string };
export const invalidFollow = (): never => {
  throw new ApiError(
    0,
    "INVALID_RESPONSE",
    "팔로우 정보를 확인할 수 없습니다.",
  );
};
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : invalidFollow();
export const text = (v: unknown): string =>
  typeof v === "string" && v.trim() ? v : invalidFollow();
export const count = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : invalidFollow();
export function readTarget(v: unknown): FollowTarget {
  const r = object(v);
  if (r.kind !== "MEMBER" && r.kind !== "STAR") return invalidFollow();
  return { kind: r.kind, id: text(r.id), label: text(r.label) };
}
export const followPath = (t: Pick<FollowTarget, "kind" | "id">) =>
  `/v1/me/following/${t.kind === "MEMBER" ? "members" : "stars"}/${encodeURIComponent(t.id)}`;
export const targetHref = (t: FollowTarget) =>
  `${t.kind === "MEMBER" ? "/members" : "/community/stars"}/${encodeURIComponent(t.id)}`;
export function readRelation(
  v: unknown,
  target: Pick<FollowTarget, "kind" | "id">,
) {
  const r = object(v);
  if (
    r.kind !== target.kind ||
    r.id !== target.id ||
    typeof r.following !== "boolean"
  )
    return invalidFollow();
  return { kind: target.kind, id: target.id, following: r.following };
}
export function readFollowSummary(v: unknown, memberId: string) {
  const r = object(v);
  if (r.memberId !== memberId) return invalidFollow();
  return {
    memberId,
    followers: count(r.followers),
    followingMembers: count(r.followingMembers),
    followingStars: count(r.followingStars),
  };
}
export const readFollowing = (v: unknown, cursor?: string | null) =>
  readPage(v, readTarget, (t) => `${t.kind}:${t.id}`, cursor);
export function readFollowingFeed(v: unknown, cursor?: string | null) {
  const page = readFeed(v, cursor);
  const raw = object(v).items as unknown[];
  return {
    ...page,
    items: page.items.map((item, i) => {
      const matchedBy = object(raw[i]).matchedBy;
      if (
        !Array.isArray(matchedBy) ||
        !matchedBy.length ||
        matchedBy.some((k) => k !== "MEMBER" && k !== "STAR")
      )
        return invalidFollow();
      return { ...item, matchedBy: [...new Set(matchedBy)] as FollowKind[] };
    }),
  };
}
