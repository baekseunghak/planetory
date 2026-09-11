import { test } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../src/api/client";
import { readMapNodes } from "../src/map/data";
import { MapIndex } from "../server/spatial-index";
import { Store } from "../server/store";

test("API preserves a body-read cancellation instead of returning an error-shaped success", async (t) => {
  const controller = new AbortController();
  const aborted = new DOMException("response body cancelled", "AbortError");
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => {
      controller.abort(aborted);
      throw aborted;
    },
  }));
  await assert.rejects(
    api("/map/tiles", { signal: controller.signal }),
    (e) => e === aborted,
  );
});

test("API rejects invalid JSON even when the HTTP status is successful", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{truncated", { status: 200 }),
  );
  await assert.rejects(
    api("/map/tiles"),
    (e) => e instanceof ApiError && e.code === "INVALID_RESPONSE",
  );
});

test("unreadable authentication errors still expire the session", async (t) => {
  const events = new EventTarget();
  let expired = 0;
  events.addEventListener("session-expired", () => expired++);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: events,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("upstream error", { status: 401 }),
  );
  await assert.rejects(
    api("/map/tiles"),
    (e) => e instanceof ApiError && e.status === 401,
  );
  assert.equal(expired, 1);
});

test("API keeps structured server error details", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ code: "STAR_LOCKED", message: "locked" }, { status: 403 }),
  );
  await assert.rejects(
    api("/stars/locked"),
    (e) =>
      e instanceof ApiError &&
      e.code === "STAR_LOCKED" &&
      e.message === "locked",
  );
});

test("map boundary accepts indexed nodes and empty results but rejects malformed payloads", () => {
  const store = new Store();
  store.addUser("map-reader", "지도검증");
  const node = store.dto("map-reader", "259377017");
  const index = new MapIndex([node]);
  const nodes = index.view(index.bounds, 1);
  assert.equal(readMapNodes({ nodes }), nodes);
  assert.deepEqual(readMapNodes({ nodes: [] }), []);
  for (const payload of [
    undefined,
    null,
    {},
    { nodes: null },
    { nodes: {} },
    { nodes: [null] },
    { nodes: [{ ...nodes[0], star: undefined }] },
    { nodes: [{ ...nodes[0], x: NaN }] },
  ])
    assert.throws(
      () => readMapNodes(payload),
      (e) => e instanceof ApiError && e.code === "INVALID_MAP_RESPONSE",
    );
});
