import { ApiError } from "../../api/client";
export type Profile = {
  memberId: string;
  nickname: string;
  starListVisibility: "PUBLIC" | "PRIVATE";
  achievementSummary: {
    signalCount: number;
    starCountByGrade: Record<"A" | "S" | "SS" | "SSS", number>;
    discoveredStarCount?: number;
    completedStarCount?: number;
    byType?: Record<"confirmed" | "unconfirmed" | "fp", number>;
  };
};
const invalid = (): never => {
  throw new ApiError(
    0,
    "INVALID_RESPONSE",
    "프로필 정보를 확인할 수 없습니다.",
  );
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : invalid();
const text = (v: unknown) =>
  typeof v === "string" && v.trim() ? v : invalid();
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : invalid();
export function readProfile(
  value: unknown,
  memberId: string,
  own: boolean,
): Profile {
  const row = object(value),
    summary = object(row.achievementSummary),
    grades = object(summary.starCountByGrade);
  if (
    row.memberId !== memberId ||
    !["PUBLIC", "PRIVATE"].includes(String(row.starListVisibility))
  )
    return invalid();
  const result: Profile = {
    memberId: text(row.memberId),
    nickname: text(row.nickname),
    starListVisibility: row.starListVisibility as Profile["starListVisibility"],
    achievementSummary: {
      signalCount: count(summary.signalCount),
      starCountByGrade: {
        A: count(grades.A),
        S: count(grades.S),
        SS: count(grades.SS),
        SSS: count(grades.SSS),
      },
    },
  };
  if (own) {
    const types = object(summary.byType);
    Object.assign(result.achievementSummary, {
      discoveredStarCount: count(summary.discoveredStarCount),
      completedStarCount: count(summary.completedStarCount),
      byType: {
        confirmed: count(types.confirmed),
        unconfirmed: count(types.unconfirmed),
        fp: count(types.fp),
      },
    });
  }
  return result;
}
export function readNickname(value: unknown, id: string) {
  const r = object(value);
  if (r.memberId !== id) return invalid();
  return { memberId: id, nickname: text(r.nickname) };
}
