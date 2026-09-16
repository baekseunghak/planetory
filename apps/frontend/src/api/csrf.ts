import { ApiError } from "./client";

// MR !42 / S03: use the server's XOR/BREACH token unchanged. Acquire afresh for
// each write so no token survives a session change in storage or a shared cache.
export function readCsrfHeaders(value: unknown): HeadersInit {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const dto = value as Record<string, unknown>;
    if (
      dto.headerName === "X-CSRF-TOKEN" &&
      typeof dto.token === "string" &&
      dto.token.trim().length > 0 &&
      !/[\r\n]/.test(dto.token)
    )
      return { [dto.headerName]: dto.token };
  }
  throw new ApiError(
    0,
    "INVALID_CSRF_RESPONSE",
    "인증 정보를 확인할 수 없습니다. 다시 시도해 주세요.",
  );
}
