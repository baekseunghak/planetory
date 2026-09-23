import { ApiError } from "../../api/client";

export type Visibility = "PUBLIC" | "PRIVATE";
export function readVisibility(value: unknown, memberId?: string): Visibility {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (
      (memberId === undefined || row.memberId === memberId) &&
      (row.starListVisibility === "PUBLIC" ||
        row.starListVisibility === "PRIVATE")
    )
      return row.starListVisibility;
  }
  // A missing row is normalized by the server; a missing response field is not PUBLIC.
  throw new ApiError(
    200,
    "INVALID_RESPONSE",
    "별 목록 공개 설정을 확인할 수 없습니다.",
  );
}
