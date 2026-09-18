import { ApiError } from "../../api/client";
import { readPage } from "./contracts";
export const reactions = ["AGREE", "DISAGREE", "NONE"] as const;
export type Reaction = (typeof reactions)[number];
export type ReactionSummary = {
  myReaction: Reaction;
  agree: number;
  disagree: number;
};
export function readReactionSummary(value: unknown): ReactionSummary {
  const row = value as ReactionSummary | null;
  if (
    !row ||
    !reactions.includes(row.myReaction) ||
    ![row.agree, row.disagree].every(
      (x) => Number.isSafeInteger(x) && x >= 0,
    ) ||
    (row.myReaction === "AGREE" && row.agree < 1) ||
    (row.myReaction === "DISAGREE" && row.disagree < 1)
  )
    throw new ApiError(
      0,
      "INVALID_RESPONSE",
      "반응 정보를 확인할 수 없습니다.",
    );
  return {
    myReaction: row.myReaction,
    agree: row.agree,
    disagree: row.disagree,
  };
}
export function readReactionResult(value: unknown, id: string) {
  const row = value as { postId: string } | null;
  if (!row || row.postId !== id)
    throw new ApiError(0, "INVALID_RESPONSE", "다른 글의 반응 응답입니다.");
  return readReactionSummary(row);
}
export function readReactors(value: unknown, cursor: string | null) {
  return readPage(
    value,
    (value) => {
      const row = value as { memberId: string; nickname: string } | null;
      if (
        !row ||
        typeof row.memberId !== "string" ||
        !row.memberId ||
        typeof row.nickname !== "string" ||
        !row.nickname
      )
        throw new ApiError(
          0,
          "INVALID_RESPONSE",
          "반응자 정보를 확인할 수 없습니다.",
        );
      return { memberId: row.memberId, nickname: row.nickname };
    },
    (item) => item.memberId,
    cursor,
  );
}
