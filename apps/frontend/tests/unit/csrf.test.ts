import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApiClient } from "../../src/api/client";
import { readCsrfHeaders } from "../../src/api/csrf";

test("server CSRF token is passed unchanged; malformed/header substitution is rejected", () => {
  assert.deepEqual(
    readCsrfHeaders({ headerName: "X-CSRF-TOKEN", token: "XOR_masked-value" }),
    { "X-CSRF-TOKEN": "XOR_masked-value" },
  );
  for (const dto of [
    null,
    {},
    [],
    { headerName: "Authorization", token: "x" },
    { headerName: "X-CSRF-TOKEN", token: "" },
    { headerName: "X-CSRF-TOKEN", token: "x\r\ny" },
  ])
    assert.throws(
      () => readCsrfHeaders(dto),
      (e) => e instanceof ApiError && e.code === "INVALID_CSRF_RESPONSE",
    );
});

test("each write obtains fresh CSRF and never repeats a rejected write", async () => {
  let tokens = 0,
    writes = 0;
  const client = createApiClient({
    baseUrl: "/api",
    csrfHeaders: async () => ({ "X-CSRF-TOKEN": String(++tokens) }),
    fetch: async (_url, init) => {
      assert.equal(
        new Headers(init?.headers).get("X-CSRF-TOKEN"),
        String(tokens),
      );
      writes++;
      return Response.json({ code: "FORBIDDEN" }, { status: 403 });
    },
  });
  for (const method of ["POST", "PATCH"])
    await assert.rejects(
      client.request("/v1/example", { method }),
      (e) => e instanceof ApiError && e.status === 403 && !e.outcomeUnknown,
    );
  assert.equal(tokens, 2);
  assert.equal(writes, 2);
});

test("cancelling all requests while acquiring CSRF does not send a late write", async () => {
  let ready!: () => void,
    release!: (h: HeadersInit) => void,
    writes = 0;
  const entered = new Promise<void>((r) => (ready = r));
  const client = createApiClient({
    baseUrl: "/api",
    csrfHeaders: () => {
      ready();
      return new Promise((r) => (release = r));
    },
    fetch: async () => {
      writes++;
      return new Response(null, { status: 204 });
    },
  });
  const pending = client.request("/v1/example", { method: "POST" });
  await entered;
  client.cancelPending();
  release({ "X-CSRF-TOKEN": "expired" });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(writes, 0);
});

test("token timeout/failure is not an uncertain write", async () => {
  let writes = 0;
  const client = createApiClient({
    baseUrl: "/api",
    timeoutMs: 10,
    csrfHeaders: (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
    fetch: async () => {
      writes++;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    client.request("/v1/example", { method: "POST" }),
    (e) => e instanceof ApiError && e.code === "TIMEOUT" && !e.outcomeUnknown,
  );
  assert.equal(writes, 0);
});
