import { test } from "node:test";
import assert from "node:assert/strict";
import { SkyDataStore } from "../../src/features/sky-data/store";
import {
  publishSkyChange,
  subscribeSkyChange,
} from "../../src/features/sky-data/events";
import { meta, star, parse, tile, deferred } from "./sky-support";
const view = { level: 2, box: { x: 0, y: 0, w: 512, h: 256 } };
test("initial overview needs metadata only; visible total is independent of global starCount", async () => {
  const paths: string[] = [],
    m = meta();
  const store = new SkyDataStore(async (path) => {
    paths.push(path);
    if (path === "/v1/me/sky") return m;
    const q = parse(path);
    return tile(m, q.box, q.level, [star("one", 0, 0), star("two", 256, 0)]);
  }, "a");
  await store.refresh();
  await store.setView({ level: 0, box: null, overview: true });
  assert.deepEqual(paths, ["/v1/me/sky"]);
  assert.equal(store.getSnapshot().clusters[0].count, 1000);
  await store.setView(view);
  assert.equal(store.getSnapshot().stars.length, 2);
  assert.equal(store.getSnapshot().meta!.starCount, 1000);
  assert.equal(store.getSnapshot().clusters.length, 0);
});
test("pan requests missing cells only, cached return avoids requests, selection is not deleted", async () => {
  const paths: string[] = [],
    m = meta(),
    stars = [star("a", 0, 0), star("b", 256, 0), star("c", 512, 0)];
  const store = new SkyDataStore(async (path) => {
    if (path === "/v1/me/sky") return m;
    paths.push(path);
    const q = parse(path);
    return tile(m, q.box, q.level, stars);
  }, "a");
  await store.refresh();
  await store.setView(view);
  store.select("a");
  await store.setView({ ...view, box: { x: 256, y: 0, w: 512, h: 256 } });
  assert.equal(paths.length, 2);
  assert.equal(parse(paths[1]).box.x, 512);
  assert.equal(store.getSnapshot().selectionStatus, "not-loaded");
  await store.setView(view);
  assert.equal(paths.length, 2);
  assert.equal(store.getSnapshot().selectionStatus, "loaded");
  assert.deepEqual(
    store.getSnapshot().stars.map((s) => s.ticId),
    ["a", "b"],
  );
});
test("partial failure retains successful regions; manual retry requests only the failed range", async () => {
  const m = meta(),
    stars = Array.from({ length: 17 }, (_, i) => star(String(i), i * 256, 0)),
    paths: string[] = [];
  let fail = true;
  const store = new SkyDataStore(async (path) => {
    if (path === "/v1/me/sky") return m;
    paths.push(path);
    const q = parse(path);
    if (fail && q.box.x === 2048) throw new Error("partial");
    return tile(m, q.box, q.level, stars);
  }, "a");
  await store.refresh();
  await store.setView({ level: 2, box: { x: 0, y: 0, w: 17 * 256, h: 256 } });
  assert.equal(paths.length, 3);
  assert.equal(store.getSnapshot().phase, "partial");
  assert.equal(store.getSnapshot().stars.length, 9);
  assert.equal(store.getSnapshot().failures.length, 1);
  fail = false;
  await store.retry();
  assert.equal(paths.length, 4);
  assert.equal(parse(paths[3]).box.x, 2048);
  assert.equal(store.getSnapshot().stars.length, 17);
  assert.equal(store.getSnapshot().phase, "ready");
});
test("new version cancels late old tiles without moving the view or resetting selected TIC", async () => {
  let m = meta(),
    hold = true;
  const old = deferred<unknown>();
  const store = new SkyDataStore(async (path) => {
    if (path === "/v1/me/sky") return m;
    const q = parse(path);
    if (hold) {
      hold = false;
      return old.promise;
    }
    return tile(m, q.box, q.level, [star("kept", 0, 0), star("new", 256, 0)]);
  }, "a");
  await store.refresh();
  store.select("kept");
  const prior = store.setView(view);
  m = { ...meta("v2"), starCount: 1001, asOf: "2026-09-14T00:00:02Z" };
  await store.notifySkyChanged({
    skyVersion: "v2",
    asOf: "2026-09-14T00:00:01Z",
  });
  old.resolve(tile(meta(), view.box, 2, [star("old", 0, 0)]));
  await prior;
  assert.equal(store.getSnapshot().meta!.version, "v2");
  assert.deepEqual(
    store.getSnapshot().stars.map((s) => s.ticId),
    ["kept", "new"],
  );
  assert.deepEqual(store.getSnapshot().view, view);
  assert.equal(store.getSnapshot().selectedTicId, "kept");
  await store.notifySkyChanged({
    skyVersion: "v1",
    asOf: "2026-09-14T00:00:00Z",
  });
  assert.equal(store.getSnapshot().meta!.version, "v2");
});
test("level changes discard old responses; server clusters are never locally regrouped", async () => {
  const m = meta(),
    hold = deferred<unknown>();
  let held = false;
  const store = new SkyDataStore(async (path) => {
    if (path === "/v1/me/sky") return m;
    const q = parse(path);
    if (q.level === 2 && !held) {
      held = true;
      return hold.promise;
    }
    return {
      ...tile(m, q.box, q.level),
      clusters: [
        {
          nodeId: "official",
          x: 100,
          y: 100,
          count: 7,
          counts: { planet: 2, done: 1, new: 4 },
          bounds: q.box,
        },
      ],
    };
  }, "a");
  await store.refresh();
  const prior = store.setView(view);
  await store.setView({ ...view, level: 1 });
  hold.resolve(tile(m, view.box, 2, [star("late", 0, 0)]));
  await prior;
  assert.equal(store.getSnapshot().stars.length, 0);
  assert.equal(store.getSnapshot().clusters.length, 1);
  assert.equal(store.getSnapshot().clusters[0].count, 7);
});
test("versionChanged refreshes metadata once; continued churn pauses for explicit retry", async () => {
  let metaCalls = 0,
    tileCalls = 0;
  const store = new SkyDataStore(async (path) => {
    if (path === "/v1/me/sky") return meta(`v${++metaCalls}`);
    const q = parse(path);
    return {
      ...tile(meta(`v${++tileCalls + 1}`), q.box, q.level),
      versionChanged: true,
    };
  }, "a");
  await store.refresh();
  await store.setView(view);
  assert.equal(metaCalls, 2);
  assert.equal(tileCalls, 2);
  assert.equal(store.getSnapshot().needsRefresh, true);
  assert.equal(store.getSnapshot().failures.length, 1);
});
test("failed metadata replacement retains one old version, then retries without losing camera/selection", async () => {
  let m = meta(),
    fail = false;
  const store = new SkyDataStore(async (path) => {
    if (path === "/v1/me/sky") {
      if (fail) throw new Error("metadata offline");
      return m;
    }
    const q = parse(path);
    return tile(m, q.box, q.level, [star(m.version, 0, 0)]);
  }, "a");
  await store.refresh();
  await store.setView(view);
  store.select("v1");
  fail = true;
  await store.notifySkyChanged({ skyVersion: "v2" });
  assert.equal(store.getSnapshot().meta!.version, "v1");
  assert.equal(store.getSnapshot().stars[0].ticId, "v1");
  assert.equal(store.getSnapshot().needsRefresh, true);
  fail = false;
  m = meta("v2");
  await store.retry();
  assert.equal(store.getSnapshot().meta!.version, "v2");
  assert.equal(store.getSnapshot().stars[0].ticId, "v2");
  assert.equal(store.getSnapshot().selectedTicId, "v1");
  assert.deepEqual(store.getSnapshot().view, view);
});
test("malformed tile payload is a failure rather than empty success; invalid level is recoverable", async () => {
  const store = new SkyDataStore(
    async (path) => (path === "/v1/me/sky" ? meta() : { stars: undefined }),
    "a",
  );
  await store.refresh();
  await store.setView(view);
  assert.equal(store.getSnapshot().phase, "error");
  assert.equal(store.getSnapshot().failures.length, 1);
  assert.equal(store.getSnapshot().stars.length, 0);
  await store.setView({ ...view, level: 99 });
  assert.ok(store.getSnapshot().error);
});
test("session disposal aborts requests and purges private cache; late data cannot restore it", async () => {
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const a = new SkyDataStore(async (path, options) => {
    if (path === "/v1/me/sky") return meta();
    signal = options.signal;
    return pending.promise;
  }, "a");
  await a.refresh();
  const job = a.setView(view);
  a.dispose();
  assert.equal(signal!.aborted, true);
  pending.resolve(tile(meta(), view.box, 2, [star("private", 0, 0)]));
  await job;
  assert.equal(a.getSnapshot().meta, null);
  assert.deepEqual(a.getSnapshot().stars, []);
  let called = false;
  const off = subscribeSkyChange("b", () => {
    called = true;
  });
  publishSkyChange("a", { skyVersion: "v2" });
  assert.equal(called, false);
  off();
});
test("bounded cache evicts offscreen cells without dropping visible healthy cells", async () => {
  let calls = 0;
  const m = meta(),
    store = new SkyDataStore(
      async (path) => {
        if (path === "/v1/me/sky") return m;
        calls++;
        const q = parse(path);
        return tile(m, q.box, q.level, [star(String(q.box.x), q.box.x, 0)]);
      },
      "a",
      1,
    );
  await store.refresh();
  await store.setView(view);
  assert.equal(store.getSnapshot().stars.length, 1);
  await store.setView({ ...view, box: { x: 2048, y: 0, w: 256, h: 256 } });
  await store.setView(view);
  assert.equal(calls, 3);
});

test("overlapping metadata requests ignore late arrivals and opaque versions are not sorted", async () => {
  const old = deferred<unknown>();
  let calls = 0;
  const store = new SkyDataStore(async (path) => {
    if (path === "/v1/me/sky")
      return ++calls === 1 ? old.promise : meta("opaque:2");
    throw new Error("overview must not request tiles");
  }, "a");
  const first = store.refresh();
  await store.refresh();
  old.resolve(meta("opaque:9999"));
  await first;
  assert.equal(store.getSnapshot().meta!.version, "opaque:2");
});
test("older server asOf metadata cannot replace a newer snapshot", async () => {
  let m = { ...meta("new"), asOf: "2026-09-14T00:00:10Z" };
  const store = new SkyDataStore(async () => m, "a");
  await store.refresh();
  m = { ...meta("different"), asOf: "2026-09-14T00:00:09Z" };
  await store.refresh();
  assert.equal(store.getSnapshot().meta!.version, "new");
  assert.equal(store.getSnapshot().needsRefresh, true);
  assert.ok(store.getSnapshot().error);
});
