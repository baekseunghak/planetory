import { SkyContractError, type Star } from "../sky-data/contracts.ts";
import { readTutorialMarkers } from "./interaction.ts";

const fail = (): never => {
  throw new SkyContractError(
    "발견 별 목록의 항목 또는 이어읽기 정보를 확인해 주세요.",
  );
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown): string =>
  typeof v === "string" && v.length > 0 ? v : fail();
const tic = (v: unknown): string =>
  /^\d+$/.test(text(v)) ? (v as string) : fail();
const count = (v: unknown): number =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail();
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
export type DiscoveredStar = Pick<
  Star,
  | "ticId"
  | "progressStage"
  | "planetCount"
  | "completedWithoutPlanets"
  | "reopened"
> & {
  achievementCount: number;
  grade: string | null;
  currentCurveStep: number | null;
  reopenPending: boolean;
  unpublishedSignalCount: number;
  lastActivityAt: string;
};
export type DiscoveredPage = {
  items: DiscoveredStar[];
  nextCursor: string | null;
  hasNext: boolean;
};
export const discoveredPath = (cursor: string | null = null) => {
  const params = new URLSearchParams({
    scope: "discovered",
    sort: "recent",
    size: "20",
  });
  if (cursor !== null) params.set("cursor", cursor);
  return "/v1/me/stars?" + params;
};
export function readDiscoveredPage(value: unknown): DiscoveredPage {
  const v = obj(value);
  if (!Array.isArray(v.items) || v.items.length > 20) return fail();
  const items = v.items.map((raw): DiscoveredStar => {
    const s = obj(raw),
      stage = text(s.progressStage),
      planets = count(s.planetCount);
    if (!["unexplored", "in_progress", "completed"].includes(stage))
      return fail();
    const completed = bool(s.completedWithoutPlanets);
    if (completed !== (stage === "completed" && planets === 0)) return fail();
    const grade = s.grade === null ? null : text(s.grade),
      date = text(s.lastActivityAt);
    if (
      (grade !== null && !["A", "S", "SS", "SSS"].includes(grade)) ||
      !Number.isFinite(Date.parse(date))
    )
      return fail();
    return {
      ticId: tic(s.ticId),
      progressStage: stage as Star["progressStage"],
      planetCount: planets,
      completedWithoutPlanets: completed,
      achievementCount: count(s.achievementCount),
      grade,
      currentCurveStep:
        s.currentCurveStep === null ? null : count(s.currentCurveStep),
      reopenPending: bool(s.reopenPending),
      reopened: bool(s.reopened),
      unpublishedSignalCount: count(s.unpublishedSignalCount),
      lastActivityAt: date,
    };
  });
  if (new Set(items.map((s) => s.ticId)).size !== items.length) return fail();
  const hasNext = bool(v.hasNext),
    nextCursor = v.nextCursor === null ? null : text(v.nextCursor);
  if (hasNext !== (nextCursor !== null) || (hasNext && items.length === 0))
    return fail();
  return { items, hasNext, nextCursor };
}
export type QuestLink = {
  key: string;
  label: string;
  status: string;
  ticId: string | null;
};
export function readQuestLinks(value: unknown): QuestLink[] {
  readTutorialMarkers(value); // Includes locked TIC redaction and duplicate/sequence checks.
  const v = obj(value),
    tutorial = obj(v.tutorial);
  const labels: Record<string, string> = {
    locked: "잠김",
    unlocked: "시작 가능",
    in_progress: "진행 중",
    completed: "완료",
  };
  const links = (tutorial.items as unknown[])
    .map((raw) => {
      const s = obj(raw);
      return {
        key: "tutorial-" + count(s.seq),
        label: `튜토리얼 ${s.seq}`,
        status: labels[text(s.status)],
        ticId: s.ticId === null ? null : tic(s.ticId),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const c = obj(v.challenge),
    unlocked = bool(c.unlocked);
  if (!unlocked && c.ticId !== null) return fail();
  links.push({
    key: "challenge",
    label: "챌린지",
    status: unlocked ? "탐사 가능" : "아직 열리지 않음",
    ticId: unlocked ? tic(c.ticId) : null,
  });
  if (!Array.isArray(v.reopened)) return fail();
  for (const raw of v.reopened) {
    const id = tic(obj(raw).ticId);
    links.push({
      key: "reopened-" + id,
      label: `다시 열린 별 · TIC ${id}`,
      status: "이어서 탐사",
      ticId: id,
    });
  }
  if (new Set(links.map((q) => q.key)).size !== links.length) return fail();
  return links;
}
