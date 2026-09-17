import { safeReturnTo } from "../app/paths.ts";
export const returnStorageKey = "planetory.oauth.returnTo";
export function loginDestination(search: string, saved: string | null) {
  return safeReturnTo(new URLSearchParams(search).get("returnTo") ?? saved);
}
export function oauthDestination(configured: string, origin: string) {
  if (
    !configured ||
    /[\\\u0000-\u0020]/.test(configured) ||
    configured.startsWith("//")
  )
    return null;
  try {
    const url = new URL(configured, origin);
    if (url.username || url.password || url.hash) return null;
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function callbackProblem(search: string): "cancelled" | "failed" | null {
  const params = new URLSearchParams(search);
  if (params.get("error") === "access_denied") return "cancelled";
  // Code exchange, state validation and session creation belong on the server.
  if (
    params.has("error") ||
    params.has("code") ||
    params.has("access_token") ||
    params.has("id_token")
  )
    return "failed";
  return null;
}
export function normalizedNickname(input: string) {
  return input.normalize("NFC").trim();
}
export function nicknameProblem(input: string): string | null {
  const value = normalizedNickname(input);
  if ([...value].length < 2 || [...value].length > 20)
    return "닉네임은 2~20자로 입력해 주세요.";
  if (!/^[가-힣A-Za-z0-9_]+$/.test(value))
    return "한글, 영문, 숫자, 밑줄만 사용할 수 있습니다.";
  if (["system", "admin", "관리자", "운영자"].includes(value.toLowerCase()))
    return "사용할 수 없는 닉네임입니다.";
  return null;
}
