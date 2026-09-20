import { readMaterials } from "./materialContracts";
import { ApiError } from "../../api/client";

type ObjectValue = Record<string, unknown>;
const invalid = (): never => {
  throw new ApiError(
    0,
    "INVALID_RESPONSE",
    "게시판 응답 형식이 올바르지 않습니다. 다시 불러와 주세요.",
  );
};
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as ObjectValue;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalid();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalid();
  return value;
}
function utc(value: unknown): string {
  const result = text(value);
  if (!/T.*(?:Z|\+00:00)$/.test(result) || !Number.isFinite(Date.parse(result)))
    return invalid();
  return result;
}
export type Author = { memberId: string; nickname: string };
function author(value: unknown): Author {
  const row = object(value);
  return { memberId: text(row.memberId), nickname: text(row.nickname) };
}
export const judgments = [
  "LIKELY_PLANET",
  "UNLIKELY_PLANET",
  "UNSURE",
] as const;
export type Judgment = (typeof judgments)[number];
export const judgmentLabels: Record<Judgment, string> = {
  LIKELY_PLANET: "행성 같음",
  UNLIKELY_PLANET: "아닌 것 같음",
  UNSURE: "모르겠음",
};
export function judgment(value: unknown): Judgment {
  if (!judgments.includes(value as Judgment)) return invalid();
  return value as Judgment;
}
export type Summary = {
  participantCount: number;
  likelyPlanet: number;
  unlikelyPlanet: number;
  unsure: number;
  percentages?: {
    likelyPlanet: number;
    unlikelyPlanet: number;
    unsure: number;
  } | null;
  asOf?: string;
};
export function readSummary(value: unknown, full = false): Summary {
  const row = object(value);
  const result: Summary = {
    participantCount: count(row.participantCount),
    likelyPlanet: count(row.likelyPlanet),
    unlikelyPlanet: count(row.unlikelyPlanet),
    unsure: count(row.unsure),
  };
  if (
    result.likelyPlanet + result.unlikelyPlanet + result.unsure !==
    result.participantCount
  )
    return invalid();
  if (full) {
    result.asOf = utc(row.asOf);
    if (!result.participantCount) {
      if (row.percentages !== null) return invalid();
      result.percentages = null;
    } else {
      const percentages = object(row.percentages);
      const percent = (key: "likelyPlanet" | "unlikelyPlanet" | "unsure") => {
        const number = percentages[key];
        if (
          typeof number !== "number" ||
          !Number.isFinite(number) ||
          number < 0 ||
          number > 100 ||
          Math.abs(number - (result[key] / result.participantCount) * 100) >
            0.11
        )
          return invalid();
        return number;
      };
      result.percentages = {
        likelyPlanet: percent("likelyPlanet"),
        unlikelyPlanet: percent("unlikelyPlanet"),
        unsure: percent("unsure"),
      };
    }
  }
  return result;
}
export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasNext: boolean;
};
export function readPage<T>(
  value: unknown,
  decode: (value: unknown) => T,
  identity: (item: T) => string,
  cursor?: string | null,
): CursorPage<T> {
  const row = object(value);
  if (!Array.isArray(row.items) || typeof row.hasNext !== "boolean")
    return invalid();
  const nextCursor = row.nextCursor === null ? null : text(row.nextCursor);
  if (
    row.hasNext !== (nextCursor !== null) ||
    (row.hasNext && (!row.items.length || nextCursor === cursor))
  )
    return invalid();
  const items = row.items.map(decode);
  if (new Set(items.map(identity)).size !== items.length) return invalid();
  return { items, nextCursor, hasNext: row.hasNext };
}
export type FeedItem = {
  type: "POST" | "SIGNAL_THREAD";
  id: string;
  ticId: string | null;
  title: string;
  author: Author | { type: "SYSTEM"; displayName: "SYSTEM" };
  commentCount: number;
  createdAt: string;
  judgmentSummary?: Summary;
};
function system(value: unknown): { type: "SYSTEM"; displayName: "SYSTEM" } {
  const row = object(value);
  if (row.type !== "SYSTEM" || row.displayName !== "SYSTEM") return invalid();
  return { type: "SYSTEM", displayName: "SYSTEM" };
}
function readFeedItem(value: unknown): FeedItem {
  const row = object(value);
  if (row.type !== "POST" && row.type !== "SIGNAL_THREAD") return invalid();
  const isThread = row.type === "SIGNAL_THREAD";
  return {
    type: row.type,
    id: text(row.id),
    title: text(row.title),
    ticId: row.ticId === null && !isThread ? null : text(row.ticId),
    author: isThread ? system(row.author) : author(row.author),
    createdAt: utc(row.createdAt),
    commentCount: count(row.commentCount),
    ...(isThread ? { judgmentSummary: readSummary(row.judgmentSummary) } : {}),
  };
}
export const readFeed = (value: unknown, cursor?: string | null) =>
  readPage(value, readFeedItem, (item) => `${item.type}:${item.id}`, cursor);

// Selection and ordering belong to S18. Validate its result rather than
// filtering the general feed, counting analyses, or ranking in the browser.
export function readHotTopics(value: unknown, cursor?: string | null) {
  const page = readFeed(value, cursor);
  if (
    page.items.some(
      (item) =>
        item.type !== "SIGNAL_THREAD" ||
        !item.judgmentSummary ||
        item.judgmentSummary.participantCount < 10,
    )
  )
    return invalid();
  return page;
}

export function readPost(value: unknown) {
  const row = object(value);
  return {
    postId: text(row.postId),
    ...readMaterials(row),
    title: text(row.title),
    body: text(row.body),
    purposeTag: text(row.purposeTag),
    ticId: row.ticId === null ? null : text(row.ticId),
    author: author(row.author),
    commentCount: count(row.commentCount),
    createdAt: utc(row.createdAt),
    updatedAt: utc(row.updatedAt),
  };
}
export function readThread(value: unknown) {
  const row = object(value);
  return {
    threadId: text(row.threadId),
    ticId: text(row.ticId),
    candidateId: text(row.candidateId),
    title: text(row.title),
    author: system(row.author),
    judgmentSummary: readSummary(row.judgmentSummary, true),
  };
}
function readAnalysis(value: unknown) {
  const row = object(value);
  if (
    row.contributesToSummary !== undefined &&
    typeof row.contributesToSummary !== "boolean"
  )
    return invalid();
  return {
    analysisId: text(row.analysisId),
    author: author(row.author),
    submittedAt: utc(row.submittedAt),
    judgment: judgment(row.judgment),
    contributesToSummary: row.contributesToSummary as boolean | undefined,
  };
}
export const readAnalyses = (value: unknown, cursor?: string | null) =>
  readPage(value, readAnalysis, (item) => item.analysisId, cursor);
export function readComment(value: unknown) {
  const row = object(value);
  return {
    commentId: text(row.commentId),
    ...readMaterials(row),
    author: author(row.author),
    body: text(row.body),
    createdAt: utc(row.createdAt),
    updatedAt: utc(row.updatedAt),
  };
}
export const readComments = (value: unknown, cursor?: string | null) =>
  readPage(value, readComment, (item) => item.commentId, cursor);
export type CommentPage = ReturnType<typeof readComments>;

export function endpoint(
  path: string,
  values: Record<string, string | null | undefined> = {},
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value) query.set(key, value);
  return path + (query.size ? `?${query}` : "");
}
export function assertIdentity(actual: string, expected: string) {
  if (actual !== expected) invalid();
}
