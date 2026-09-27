import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApiClient } from "../../src/api/client";

test("cookies, Headers objects and caller cancellation reach fetch", async () => {
  let observed: RequestInit | undefined;
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async (_path, options) => {
      observed = options;
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(
    await client.request("/v1/me", {
      headers: new Headers({ "X-Feature": "test" }),
    }),
    { ok: true },
  );
  assert.equal(observed?.credentials, "include");
  assert.equal(new Headers(observed?.headers).get("X-Feature"), "test");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.request("/v1/me", { signal: controller.signal }),
    { name: "AbortError" },
  );
});
test("fieldErrors.reason and an agreed response request ID are retained", async () => {
  const client = createApiClient({
    baseUrl: "/api",
    requestIdHeader: "X-Team-Request",
    fetch: async () =>
      Response.json(
        {
          code: "VALIDATION_FAILED",
          message: "입력 확인",
          fieldErrors: [
            { field: "nickname", reason: "다른 이름을 입력해 주세요." },
            null,
            { field: "bad" },
          ],
        },
        { status: 400, headers: { "X-Team-Request": "server-123" } },
      ),
  });
  await assert.rejects(client.request("/v1/me"), (error) => {
    assert.ok(error instanceof ApiError);
    assert.deepEqual(error.fieldErrors, [
      { field: "nickname", reason: "다른 이름을 입력해 주세요." },
    ]);
    assert.equal(error.requestId, "server-123");
    assert.ok(error.localRequestId);
    return true;
  });
});
test("only 401 expires authentication, including a non-JSON error body", async () => {
  let status = 403,
    expirations = 0;
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async () => new Response("error", { status }),
  });
  const unsubscribe = client.onUnauthorized(() => expirations++);
  for (status of [403, 404, 401])
    await assert.rejects(
      client.request("/v1/me"),
      (error) => error instanceof ApiError && error.status === status,
    );
  assert.equal(expirations, 1);
  unsubscribe();
  await assert.rejects(client.request("/v1/me"));
  assert.equal(expirations, 1);
});
test("204 is empty; a malformed success is an error, never an empty data set", async () => {
  let response = new Response(null, { status: 204 });
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async () => response,
  });
  assert.equal(await client.request("/v1/me"), undefined);
  response = new Response("<html>SPA fallback</html>");
  await assert.rejects(
    client.request("/v1/me"),
    (error) => error instanceof ApiError && error.code === "INVALID_RESPONSE",
  );
});
test("aborting during response body parsing remains cancellation", async () => {
  const abort = new AbortController();
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async () => {
      const response = Response.json({});
      response.json = async () => {
        abort.abort();
        throw new DOMException("aborted", "AbortError");
      };
      return response;
    },
  });
  await assert.rejects(client.request("/v1/me", { signal: abort.signal }), {
    name: "AbortError",
  });
});
test("writes require configured CSRF; a lost response is uncertain and never retried", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    ++calls;
    assert.equal(
      new Headers(options?.headers).get("X-Agreed-CSRF"),
      "test-only-token",
    );
    throw new TypeError("connection lost");
  };
  const missing = createApiClient({ baseUrl: "/api", fetch: fetcher });
  await assert.rejects(
    missing.request("/v1/posts", {
      method: "POST",
      json: { title: "input preserved by form" },
    }),
    (error) =>
      error instanceof ApiError &&
      error.code === "CSRF_NOT_CONFIGURED" &&
      !error.outcomeUnknown,
  );
  assert.equal(calls, 0);
  const client = createApiClient({
    baseUrl: "/api",
    fetch: fetcher,
    csrfHeaders: () => ({ "X-Agreed-CSRF": "test-only-token" }),
  });
  for (const method of ["POST", "PATCH"])
    await assert.rejects(
      client.request("/v1/posts", { method, json: { title: "saved?" } }),
      (error) => error instanceof ApiError && error.outcomeUnknown,
    );
  assert.equal(calls, 2);
});
test("timeouts abort the request and are never retried", async () => {
  let calls = 0;
  const client = createApiClient({
    baseUrl: "/api",
    timeoutMs: 10,
    fetch: async (_url, options) => {
      ++calls;
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () =>
          reject(options!.signal!.reason),
        ),
      );
    },
  });
  await assert.rejects(
    client.request("/v1/me"),
    (error) =>
      error instanceof ApiError &&
      error.code === "TIMEOUT" &&
      !error.outcomeUnknown,
  );
  assert.equal(calls, 1);
});
test("reads wait out gateway 502/504; writes and the backend's 503 fail at once", async () => {
  let calls = 0,
    replies: number[] = [];
  const client = createApiClient({
    baseUrl: "/api",
    gatewayRetryMs: [0, 0, 0],
    csrfHeaders: () => ({}),
    fetch: async () => {
      ++calls;
      const status = replies.shift() ?? 200;
      return status === 200
        ? Response.json({ ok: true })
        : new Response("<h1>gateway</h1>", { status });
    },
  });
  replies = [502, 504];
  assert.deepEqual(await client.request("/v1/me/sky"), { ok: true });
  assert.equal(calls, 3);
  calls = 0;
  replies = [502, 502, 502, 502];
  await assert.rejects(
    client.request("/v1/me/sky"),
    (error) => error instanceof ApiError && error.status === 502,
  );
  assert.equal(calls, 4);
  calls = 0;
  replies = [503];
  await assert.rejects(
    client.request("/v1/me/sky"),
    (error) => error instanceof ApiError && error.status === 503,
  );
  assert.equal(calls, 1);
  calls = 0;
  replies = [502];
  await assert.rejects(
    client.request("/v1/posts", { method: "POST", json: {} }),
    (error) =>
      error instanceof ApiError && error.status === 502 && error.outcomeUnknown,
  );
  assert.equal(calls, 1);
});
test("cancelling a read stops its wait for the next gateway retry", async () => {
  let calls = 0;
  const abort = new AbortController();
  const client = createApiClient({
    baseUrl: "/api",
    gatewayRetryMs: [60_000],
    fetch: async () => {
      ++calls;
      setTimeout(() => abort.abort());
      return new Response("", { status: 502 });
    },
  });
  await assert.rejects(client.request("/v1/me/sky", { signal: abort.signal }), {
    name: "AbortError",
  });
  assert.equal(calls, 1);
});

test("one request can extend the timeout without changing the shared default", async () => {
  const client = createApiClient({
    baseUrl: "/api",
    timeoutMs: 5,
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await client.request("/v1/me", { timeoutMs: 500 }), {
    ok: true,
  });
  await assert.rejects(
    client.request("/v1/me"),
    (error) => error instanceof ApiError && error.code === "TIMEOUT",
  );
});
test("expired-session cancellation aborts other pending requests", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async (_url, options) => {
      entered();
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () =>
          reject(options!.signal!.reason),
        ),
      );
    },
  });
  const request = client.request("/v1/me");
  await started;
  client.cancelPending();
  await assert.rejects(request, { name: "AbortError" });
});
test("session cancellation does not abort an independent receipt read", async () => {
  let releaseReceipt!: (response: Response) => void;
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async (url, options) => {
      if (String(url).endsWith("/v1/me"))
        return new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), {
          status: 401,
        });
      return new Promise<Response>((resolve, reject) => {
        releaseReceipt = resolve;
        options!.signal!.addEventListener(
          "abort",
          () => reject(options!.signal!.reason),
          { once: true },
        );
      });
    },
  });
  client.onUnauthorized(() => client.cancelPending());
  const receipt = client.request("/v1/withdrawal-requests/receipt-1", {
    sessionBound: false,
  });
  await assert.rejects(
    client.request("/v1/me"),
    (error) => error instanceof ApiError && error.status === 401,
  );
  releaseReceipt(
    new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 }),
  );
  assert.deepEqual(await receipt, { status: "COMPLETED" });
});
test("cancelling a dispatched write does not claim that the server rolled back", async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const client = createApiClient({
    baseUrl: "/api",
    csrfHeaders: () => ({ "X-Test-CSRF": "test-only" }),
    fetch: async (_url, options) => {
      entered();
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () =>
          reject(options!.signal!.reason),
        ),
      );
    },
  });
  const request = client.request("/v1/posts", {
    method: "POST",
    json: { title: "input" },
    signal: abort.signal,
  });
  await started;
  abort.abort();
  await assert.rejects(
    request,
    (error) =>
      error instanceof ApiError &&
      error.code === "REQUEST_CANCELLED" &&
      error.outcomeUnknown,
  );
});

test("optional response metadata preserves body/errors and is not forwarded to fetch", async () => {
  let status = 200;
  const seen: number[] = [];
  const client = createApiClient({
    baseUrl: "/api",
    fetch: async (_path, options) => {
      assert.equal("onResponse" in (options ?? {}), false);
      return status === 204
        ? new Response(null, { status })
        : Response.json(
            { code: "BUNDLE_CHANGED" },
            { status, headers: { "X-Current-Bundle": "9007199254740997" } },
          );
    },
  });
  const options = {
    onResponse: (response: { status: number; headers: Headers }) => {
      seen.push(response.status);
      if (response.status !== 204)
        assert.equal(
          response.headers.get("x-current-bundle"),
          "9007199254740997",
        );
    },
  };
  assert.deepEqual(await client.request("/v1/test", options), {
    code: "BUNDLE_CHANGED",
  });
  status = 409;
  await assert.rejects(
    client.request("/v1/test", options),
    (error) => error instanceof ApiError && error.code === "BUNDLE_CHANGED",
  );
  status = 204;
  assert.equal(await client.request("/v1/test", options), undefined);
  assert.deepEqual(seen, [200, 409, 204]);
});
