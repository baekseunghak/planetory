import { ApiError } from "../../api/client";
import { codePoints, stripTitle } from "./postContracts";

export type CommentParent = {
  parentType: "POST" | "SIGNAL_THREAD";
  parentId: string;
};
// W14 supplies selections only at final submit; the empty selection sends no fields.
export type CommentMaterials = import("./materialContracts").Materials;
export function commentError(body: string) {
  return !stripTitle(body) || codePoints(body) > 2000
    ? "댓글은 공백만 입력할 수 없으며 1~2,000자로 입력해 주세요."
    : "";
}
export function readCreatedComment(value: unknown) {
  const row = value as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.commentId !== "string" ||
    !row.commentId ||
    typeof row.createdAt !== "string" ||
    !/T.*(?:Z|\+00:00)$/.test(row.createdAt) ||
    !Number.isFinite(Date.parse(row.createdAt))
  )
    throw new ApiError(
      0,
      "INVALID_RESPONSE",
      "댓글 저장 응답을 확인할 수 없습니다.",
    );
  return { commentId: row.commentId, createdAt: row.createdAt };
}
