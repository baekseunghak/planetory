import { ApiError, createApiClient } from "./client";
import { readCsrfHeaders } from "./csrf";

const env = import.meta.env;
const header = env.VITE_CSRF_HEADER?.trim();
const cookie = env.VITE_CSRF_COOKIE?.trim();
export const http = createApiClient({
  baseUrl: env.VITE_API_BASE || "/api",
  requestIdHeader: env.VITE_REQUEST_ID_HEADER || undefined,
  csrfHeaders:
    header && cookie
      ? () => {
          const token = document.cookie
            .split(";")
            .map((item) => item.trim())
            .find((item) => item.startsWith(`${cookie}=`))
            ?.slice(cookie.length + 1);
          if (!token)
            throw new ApiError(
              0,
              "CSRF_TOKEN_MISSING",
              "인증 정보를 확인할 수 없습니다. 다시 로그인해 주세요.",
            );
          return { [header]: decodeURIComponent(token) };
        }
      : async (signal) => {
          if (header || cookie)
            throw new ApiError(
              0,
              "CSRF_NOT_CONFIGURED",
              "인증 연결 설정을 확인해 주세요.",
            );
          return readCsrfHeaders(
            await http.request<unknown>("/v1/auth/csrf", { signal }),
          );
        },
});
export const api = http.request;
export { ApiError } from "./client";
