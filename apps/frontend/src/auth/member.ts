import { ApiError } from "../api/client";
export type Member = {
  memberId: string;
  nickname: string;
  onboardingDone: boolean;
  tutorialCompleted: boolean;
};
export function readMember(value: unknown): Member {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const member = value as Record<string, unknown>;
  if (
    typeof member.memberId !== "string" ||
    !member.memberId ||
    typeof member.nickname !== "string" ||
    typeof member.onboardingDone !== "boolean" ||
    typeof member.tutorialCompleted !== "boolean"
  )
    throw invalid();
  return {
    memberId: member.memberId,
    nickname: member.nickname,
    onboardingDone: member.onboardingDone,
    tutorialCompleted: member.tutorialCompleted,
  };
}
const invalid = () =>
  new ApiError(
    200,
    "INVALID_RESPONSE",
    "회원 정보의 응답 형식을 확인해 주세요.",
  );
