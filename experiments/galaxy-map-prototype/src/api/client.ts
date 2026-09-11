export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const BASE = import.meta.env?.VITE_API_BASE || "/api";
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(BASE + path, {
    ...options,
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    // Fetch can resolve its headers before cancellation interrupts the body.
    // Never turn that cancellation into a successful, incorrectly shaped DTO.
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (response.ok)
      throw new ApiError(
        response.status,
        "INVALID_RESPONSE",
        "서버 응답을 읽을 수 없습니다. 다시 시도해 주세요.",
      );
  }
  options.signal?.throwIfAborted();
  if (!response.ok) {
    const error =
      result && typeof result === "object"
        ? (result as Record<string, unknown>)
        : {};
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      response.status,
      typeof error.code === "string" ? error.code : "REQUEST_FAILED",
      typeof error.message === "string"
        ? error.message
        : "요청에 실패했습니다.",
    );
  }
  return result as T;
}
export const mutation = <T>(path: string, body: unknown, method = "POST") =>
  api<T>(path, { method, body: JSON.stringify(body) });
type QueryValues = Record<string, string | number | boolean | undefined>;
export function query(values: QueryValues): string;
export function query(path: string, values: QueryValues): string;
export function query(
  pathOrValues: string | QueryValues,
  values?: QueryValues,
) {
  const p = new URLSearchParams();
  Object.entries(
    typeof pathOrValues === "string" ? values || {} : pathOrValues,
  ).forEach(([k, v]) => {
    if (v !== undefined && v !== "") p.set(k, String(v));
  });
  return (
    (typeof pathOrValues === "string" ? pathOrValues + "?" : "") + p.toString()
  );
}
