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
    /**
     * 오류 본문 그대로. 일부 오류는 `code`·`message`·`fieldErrors` 밖에 값을
     * 더한다(예: 탐사 API `BUNDLE_CHANGED`의 `currentBundleId`). 어떤 값이
     * 올지는 각 API가 정하므로 해석하지 않고 보관만 하며 읽는 쪽이 검사한다.
     */
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

type RequestOptions = Omit<RequestInit, "credentials"> & {
  json?: unknown;
  timeoutMs?: number;
  // Capture metadata here; handle it after the request settles.
  onResponse?: (metadata: { status: number; headers: Headers }) => void;
  // Receipt-style reads can outlive the authenticated session that created
  // them. They still obey their own signal and timeout, but a /me 401 must not
  // cancel them or make their 401 expire an unrelated login session.
  sessionBound?: boolean;
};
type ClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  csrfHeaders?: (signal: AbortSignal) => HeadersInit | Promise<HeadersInit>;
  requestIdHeader?: string;
  gatewayRetryMs?: readonly number[];
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
// The backend never answers 502/504: they come from Nginx or the tunnel while
// the backend is unreachable, e.g. the ~20 s container swap of a deploy
// (S15P21C206-279). Reads wait that out; writes, the backend's own 503,
// timeouts and network errors still fail at once.
const GATEWAY_RETRY_MS = [1000, 2000, 4000, 8000, 15000];
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });

// Based on the existing prototype request client: cancellation and 204 handling
// remain shared, while field errors now use the backend's actual `reason` field.
export function createApiClient(config: ClientOptions) {
  const sessionPending = new Set<AbortController>();
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
    const {
      json,
      onResponse,
      sessionBound = true,
      timeoutMs,
      ...fetchOptions
    } = options;
    if (json !== undefined && options.body != null)
      throw new Error("json과 body는 함께 보낼 수 없습니다.");
    if (json !== undefined) headers.set("Content-Type", "application/json");
    const body = json !== undefined ? JSON.stringify(json) : options.body;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (sessionBound) sessionPending.add(controller);
    let timedOut = false;
    let dispatched = false;
    let serverRequestId: string | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Each attempt gets the whole timeout: waiting between gateway retries is
    // not a slow server.
    const arm = () => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
        },
        timeoutMs ?? config.timeoutMs ?? 15000,
      );
    };
    arm();
    try {
      controller.signal.throwIfAborted();
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
        // Keep acquisition inside the same cancellation/timeout boundary. A
        // logout/account change while waiting must never dispatch the write.
        new Headers(await config.csrfHeaders(controller.signal)).forEach(
          (value, key) => headers.set(key, value),
        );
        controller.signal.throwIfAborted();
      }
      dispatched = true;
      const send = () =>
        (config.fetch ?? fetch)(config.baseUrl.replace(/\/$/, "") + path, {
          ...fetchOptions,
          method,
          headers,
          body,
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
      let response = await send();
      for (const delay of writing
        ? []
        : (config.gatewayRetryMs ?? GATEWAY_RETRY_MS)) {
        if (response.status !== 502 && response.status !== 504) break;
        controller.signal.throwIfAborted();
        clearTimeout(timeout);
        await wait(delay, controller.signal);
        arm();
        response = await send();
      }
      controller.signal.throwIfAborted();
      onResponse?.({
        status: response.status,
        headers: new Headers(response.headers),
      });
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
        if (response.status === 401 && sessionBound)
          expired.forEach((listener) => listener());
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
          body,
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
      sessionPending.delete(controller);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  return {
    request,
    cancelPending: () => {
      for (const controller of sessionPending) controller.abort();
    },
    onUnauthorized(listener: () => void) {
      expired.add(listener);
      return () => {
        expired.delete(listener);
      };
    },
  };
}
