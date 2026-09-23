import { ApiError } from "../../api/client";
const fail = (): never => {
  throw new ApiError(
    0,
    "INVALID_RESPONSE",
    "탈퇴 처리 정보를 확인할 수 없습니다.",
  );
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : fail());
const lines = (v: unknown): string[] =>
  Array.isArray(v) && v.length > 0 ? v.map(text) : fail();
export type WithdrawalPolicy =
  | { available: false; reason: string }
  | {
      available: true;
      version: string;
      retention: string[];
      rejoining: string[];
      effects: string[];
    };
export function readWithdrawalPolicy(v: unknown): WithdrawalPolicy {
  const r = object(v);
  if (r.available === false)
    return { available: false, reason: text(r.reason) };
  if (r.available !== true) return fail();
  return {
    available: true,
    version: text(r.version),
    retention: lines(r.retention),
    rejoining: lines(r.rejoining),
    effects: lines(r.effects),
  };
}
export type WithdrawalStatus = {
  requestId: string;
  status: "READY" | "PROCESSING" | "COMPLETED" | "FAILED";
  message: string;
  effectiveAt: string | null;
};
export function readWithdrawalStatus(
  v: unknown,
  id?: string,
): WithdrawalStatus {
  const r = object(v);
  if (id !== undefined && r.requestId !== id) return fail();
  if (
    typeof r.status !== "string" ||
    !["READY", "PROCESSING", "COMPLETED", "FAILED"].includes(r.status)
  )
    return fail();
  return {
    requestId: text(r.requestId),
    status: r.status as WithdrawalStatus["status"],
    message: text(r.message),
    effectiveAt: r.effectiveAt === null ? null : text(r.effectiveAt),
  };
}
