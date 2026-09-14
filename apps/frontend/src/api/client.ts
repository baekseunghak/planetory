export type FieldError = { field: string; reason: string };
export class ApiError extends Error {
  readonly name = "ApiError";
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors: FieldError[] = [],
    public readonly requestId: string | null = null,
    public readonly localRequestId: string | null = null,
    public readonly outcomeUnknown = false,
  ) {
    super(message);
  }
}

type RequestOptions = Omit<RequestInit, "credentials"> & { json?: unknown };
type ClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  csrfHeaders?: () => HeadersInit;
  requestIdHeader?: string;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Based on the existing prototype request client: cancellation and 204 handling
// remain shared, while field errors now use the backend's actual `reason` field.
export function createApiClient(config: ClientOptions) {
  const pending = new Set<AbortController>();
  const expired = new Set<() => void>();
  async function request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\\\u0000-\u0020]/.test(path) ||
      path
        .split("?")[0]
        .split("/")
        .some((part) => part === ".." || part === ".")
    )
      throw new Error("API 경로는 /로 시작하는 상대 경로여야 합니다.");
    const method = (options.method || "GET").toUpperCase();
    const writing = !["GET", "HEAD", "OPTIONS"].includes(method);
    const localRequestId = crypto.randomUUID();
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (writing) {
      if (!config.csrfHeaders)
        throw new ApiError(
          0,
          "CSRF_NOT_CONFIGURED",
          "인증 연결이 아직 준비되지 않았습니다.",
          [],
          null,
          localRequestId,
        );
      new Headers(config.csrfHeaders()).forEach((value, key) =>
        headers.set(key, value),
      );
    }
    const { json, ...fetchOptions } = options;
    if (json !== undefined && options.body != null)
      throw new Error("json과 body는 함께 보낼 수 없습니다.");
    if (json !== undefined) headers.set("Content-Type", "application/json");
    const body = json !== undefined ? JSON.stringify(json) : options.body;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    pending.add(controller);
    let timedOut = false;
    let dispatched = false;
    let serverRequestId: string | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs ?? 15000);
    try {
      controller.signal.throwIfAborted();
      dispatched = true;
      const response = await (config.fetch ?? fetch)(
        config.baseUrl.replace(/\/$/, "") + path,
        {
          ...fetchOptions,
          method,
          headers,
          body,
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        },
      );
      controller.signal.throwIfAborted();
      serverRequestId = config.requestIdHeader
        ? response.headers.get(config.requestIdHeader)
        : null;
      if (response.status === 204) return undefined as T;
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        controller.signal.throwIfAborted();
        if (response.ok)
          throw new ApiError(
            response.status,
            "INVALID_RESPONSE",
            "서버 응답을 읽을 수 없습니다.",
            [],
            serverRequestId,
            localRequestId,
            writing,
          );
      }
      controller.signal.throwIfAborted();
      if (!response.ok) {
        const body = record(result);
        if (response.status === 401) expired.forEach((listener) => listener());
        throw new ApiError(
          response.status,
          typeof body.code === "string" ? body.code : "REQUEST_FAILED",
          typeof body.message === "string"
            ? body.message
            : "요청을 처리하지 못했습니다.",
          Array.isArray(body.fieldErrors)
            ? body.fieldErrors.filter(
                (item): item is FieldError =>
                  typeof record(item).field === "string" &&
                  typeof record(item).reason === "string",
              )
            : [],
          serverRequestId,
          localRequestId,
          writing && response.status >= 500,
        );
      }
      return result as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut)
        throw new ApiError(
          0,
          "TIMEOUT",
          "서버 응답이 지연되고 있습니다.",
          [],
          serverRequestId,
          localRequestId,
          writing && dispatched,
        );
      if (controller.signal.aborted) {
        if (writing && dispatched)
          throw new ApiError(
            0,
            "REQUEST_CANCELLED",
            "요청 대기를 중단했습니다. 저장 여부를 확인해 주세요.",
            [],
            serverRequestId,
            localRequestId,
            true,
          );
        throw controller.signal.reason;
      }
      throw new ApiError(
        0,
        "NETWORK_ERROR",
        "서버에 연결할 수 없습니다.",
        [],
        serverRequestId,
        localRequestId,
        writing && dispatched,
      );
    } finally {
      clearTimeout(timeout);
      pending.delete(controller);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  return {
    request,
    cancelPending: () => {
      for (const controller of pending) controller.abort();
    },
    onUnauthorized(listener: () => void) {
      expired.add(listener);
      return () => {
        expired.delete(listener);
      };
    },
  };
}
