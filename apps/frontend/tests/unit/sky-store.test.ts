import { test } from "node:test";
import assert from "node:assert/strict";
import { SkyDataStore } from "../../src/features/sky-data/store";
import { ApiError } from "../../src/api/client";
import {
  publishSkyChange,
  subscribeSkyChange,
} from "../../src/features/sky-data/events";
import { meta, star, parse, tile, deferred } from "./sky-support";
const view = { level: 2, box: { x: 0, y: 0, w: 512, h: 256 } };
test("metadata is followed by initial visible pages even at level zero", async () => {
  const paths: string[] = [],
    m = meta();
  const store = new SkyDataStore(async (path) => {
    paths.push(path);
    if (path === "/v1/me/sky") return m;
    const q = parse(path);
    return tile(m, q.box, q.level, [star("1", 0, 0), star("2", 256, 0)]);
  }, "a");
  await store.refresh();
  await store.setView({ ...view, level: 0 });
  assert.equal(paths.length, 2);
  assert.equal(store.getSnapshot().loadedCount, 2);
  assert.equal(store.getSnapshot().meta!.starCount, 10000);
  assert.equal(store.getSnapshot().phase, "ready");
  await store.setView({ ...view, level: 0 });
  assert.equal(paths.length, 2);
});
test("camera pan requests missing cells only; cached return and offscreen selection survive", async () => {
  const paths: string[] = [],
    m = meta(),
    stars = [star("1", 0, 0), star("2", 256, 0), star("3", 512, 0)];
  const store = new SkyDataStore(async (p) => {
    if (p === "/v1/me/sky") return m;
    paths.push(p);
    const q = parse(p);
    return tile(m, q.box, q.level, stars);
  }, "a");
  await store.refresh();
  await store.setView(view);
  store.select("1");
  await store.setView({ ...view, box: { x: 256, y: 0, w: 512, h: 256 } });
  assert.equal(paths.length, 2);
  assert.equal(parse(paths[1]).box.x, 512);
  assert.equal(store.getSnapshot().selectionStatus, "not-loaded");
  await store.setView(view);
  assert.equal(paths.length, 2);
  assert.equal(store.getSnapshot().selectionStatus, "loaded");
  assert.deepEqual(
    store.getSnapshot().stars.map((s) => s.ticId),
    ["1", "2"],
  );
});
test("page 2 failure keeps page 1; retry resumes the opaque cursor with unchanged scope", async () => {
  const m = meta(),
    paths: string[] = [],
    hold = deferred<unknown>();
  let failed = true;
  const store = new SkyDataStore(
    async (p) => {
      if (p === "/v1/me/sky") return m;
      paths.push(p);
      const q = parse(p);
      if (!q.cursor)
        return {
          ...tile(m, q.box, q.level, [star("1", 0, 0)]),
          rangeStarCount: 3,
          nextCursor: "opaque /?+&=",
        };
      if (failed) {
        await hold.promise;
        throw Error("offline");
      }
      return {
        ...tile(m, q.box, q.level, [star("2", 1, 0), star("3", 2, 0)]),
        rangeStarCount: 3,
      };
    },
    "a",
    1024,
    2,
  );
  await store.refresh();
  const work = store.setView(view);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.getSnapshot().phase, "loading");
  assert.equal(store.getSnapshot().loadedCount, 1);
  assert.equal(store.getSnapshot().pageProgress[0].expected, 3);
  hold.resolve(null);
  await work;
  assert.equal(store.getSnapshot().phase, "partial");
  store.select("1");
  failed = false;
  await store.retry();
  assert.equal(store.getSnapshot().phase, "ready");
  assert.equal(store.getSnapshot().loadedCount, 3);
  assert.equal(store.getSnapshot().selectionStatus, "loaded");
  assert.equal(paths[1], paths[2]);
  assert.equal(parse(paths[1]).cursor, "opaque /?+&=");
});
test("2501 stars span three pages without a 1000/2000 rendering cap", async () => {
  const m = { ...meta(), starCount: 2501 },
    stars = Array.from({ length: 2501 }, (_, i) =>
      star(String(i + 1), i / 10, 0),
    );
  let pages = 0;
  const store = new SkyDataStore(async (p) => {
    if (p === "/v1/me/sky") return m;
    const q = parse(p),
      offset = q.cursor ? Number(q.cursor.slice(5)) : 0;
    pages++;
    return {
      ...tile(m, q.box, q.level, stars.slice(offset, offset + q.limit)),
      rangeStarCount: 2501,
      nextCursor:
        offset + q.limit < stars.length ? "page-" + (offset + q.limit) : null,
    };
  }, "a");
  await store.refresh();
  await store.setView(view);
  assert.equal(pages, 3);
  assert.equal(store.getSnapshot().stars.length, 2501);
  assert.equal(store.getSnapshot().phase, "ready");
});
test("partial range failure retains other regions and retries only the missing range", async () => {
  const m = meta(),
    stars = Array.from({ length: 17 }, (_, i) =>
      star(String(i + 1), i * 256, 0),
    ),
    paths: string[] = [];
  let failed = true;
  const store = new SkyDataStore(async (p) => {
    if (p === "/v1/me/sky") return m;
    paths.push(p);
    const q = parse(p);
    if (failed && q.box.x === 2048) throw Error("region");
    return tile(m, q.box, q.level, stars);
  }, "a");
  await store.refresh();
  await store.setView({ level: 2, box: { x: 0, y: 0, w: 17 * 256, h: 256 } });
  assert.equal(store.getSnapshot().stars.length, 9);
  assert.equal(store.getSnapshot().phase, "partial");
  failed = false;
  await store.retry();
  assert.equal(paths.length, 4);
  assert.equal(parse(paths[3]).box.x, 2048);
  assert.equal(store.getSnapshot().stars.length, 17);
});
test("page versionChanged without bounds restarts first page, preserving selection and camera", async () => {
  let m = meta(),
    changed = false;
  const paths: string[] = [];
  const store = new SkyDataStore(async (p) => {
    if (p === "/v1/me/sky") return m;
    paths.push(p);
    const q = parse(p);
    if (!changed && !q.cursor)
      return {
        ...tile(m, q.box, q.level, [star("1", 0, 0)]),
        rangeStarCount: 2,
        nextCursor: "old-cursor",
      };
    if (!changed) {
      changed = true;
      m = meta("v2");
      return {
        representation: "individual-stars",
        version: "v2",
        level: q.level,
        versionChanged: true,
        stars: [],
        nextCursor: null,
      };
    }
    return tile(m, q.box, q.level, [star("1", 0, 0), star("2", 256, 0)]);
  }, "a");
  store.select("1");
  await store.refresh();
  await store.setView(view);
  assert.equal(paths.length, 3);
  assert.equal(parse(paths[2]).cursor, null);
  assert.equal(parse(paths[2]).version, "v2");
  assert.equal(store.getSnapshot().meta!.version, "v2");
  assert.equal(store.getSnapshot().selectionStatus, "loaded");
  assert.deepEqual(store.getSnapshot().view, view);
});
test("continued version churn pauses once instead of retrying forever", async () => {
  let metaCalls = 0,
    tileCalls = 0;
  const store = new SkyDataStore(async (p) => {
    if (p === "/v1/me/sky") return meta("v" + ++metaCalls);
    const q = parse(p);
    return {
      representation: "individual-stars",
      version: "v" + (++tileCalls + 1),
      level: q.level,
      versionChanged: true,
      stars: [],
      nextCursor: null,
    };
  }, "a");
  await store.refresh();
  await store.setView(view);
  assert.equal(metaCalls, 2);
  assert.equal(tileCalls, 2);
  assert.equal(store.getSnapshot().needsRefresh, true);
});
test("late page from a previous level cannot restore old nodes", async () => {
  const m = meta(),
    hold = deferred<unknown>();
  let held = false;
  const store = new SkyDataStore(async (p) => {
    if (p === "/v1/me/sky") return m;
    const q = parse(p);
    if (q.level === 2 && !held) {
      held = true;
      return hold.promise;
    }
    return tile(m, q.box, q.level, [star("2", 0, 0)]);
  }, "a");
  await store.refresh();
  const prior = store.setView(view);
  await store.setView({ ...view, level: 1 });
  hold.resolve(tile(m, view.box, 2, [star("1", 0, 0)]));
  await prior;
  assert.deepEqual(
    store.getSnapshot().stars.map((s) => s.ticId),
    ["2"],
  );
});
test("failed metadata refresh preserves old data and resumes without resetting camera", async () => {
  let m = meta(),
    fail = false;
  const store = new SkyDataStore(async (p) => {
    if (p === "/v1/me/sky") {
      if (fail) throw Error("meta offline");
      return m;
    }
    const q = parse(p);
    return tile(m, q.box, q.level, [star("1", 0, 0)]);
  }, "a");
  await store.refresh();
  await store.setView(view);
  store.select("1");
  fail = true;
  await store.notifySkyChanged({ skyVersion: "v2" });
  assert.equal(store.getSnapshot().needsRefresh, true);
  assert.equal(store.getSnapshot().stars.length, 1);
  fail = false;
  m = meta("v2");
  await store.retry();
  assert.equal(store.getSnapshot().meta!.version, "v2");
  assert.deepEqual(store.getSnapshot().view, view);
  assert.equal(store.getSnapshot().selectedTicId, "1");
});
test("logout/member disposal aborts and clears all pages; late private response cannot return", async () => {
  const hold = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const a = new SkyDataStore(async (p, o) => {
    if (p === "/v1/me/sky") return meta();
    signal = o.signal;
    return hold.promise;
  }, "a");
  await a.refresh();
  const work = a.setView(view);
  a.dispose();
  assert.equal(signal!.aborted, true);
  hold.resolve(tile(meta(), view.box, 2, [star("1", 0, 0)]));
  await work;
  assert.equal(a.getSnapshot().meta, null);
  assert.deepEqual(a.getSnapshot().stars, []);
  let calls = 0;
  const off = subscribeSkyChange("b", () => {
    calls++;
  });
  publishSkyChange("a", { skyVersion: "v2" });
  off();
  assert.equal(calls, 0);
});
test("bounded cache evicts only offscreen cells", async () => {
  const m = meta();
  let calls = 0;
  const store = new SkyDataStore(
    async (p) => {
      if (p === "/v1/me/sky") return m;
      calls++;
      const q = parse(p);
      return tile(m, q.box, q.level, [star(String(q.box.x + 1), q.box.x, 0)]);
    },
    "a",
    1,
  );
  await store.refresh();
  await store.setView(view);
  await store.setView({ ...view, box: { x: 2048, y: 0, w: 256, h: 256 } });
  await store.setView(view);
  assert.equal(calls, 3);
  assert.equal(store.getSnapshot().loadedCount, 1);
});
test("opaque versions, overlapping metadata and older asOf are not treated as ordered IDs", async () => {
  const hold = deferred<unknown>();
  let calls = 0;
  const store = new SkyDataStore(
    async () => (++calls === 1 ? hold.promise : meta("opaque:2")),
    "a",
  );
  const first = store.refresh();
  await store.refresh();
  hold.resolve(meta("opaque:9999"));
  await first;
  assert.equal(store.getSnapshot().meta!.version, "opaque:2");
  let m = { ...meta("new"), asOf: "2026-09-15T00:00:10Z" };
  const other = new SkyDataStore(async () => m, "b");
  await other.refresh();
  m = { ...m, version: "different", asOf: "2026-09-15T00:00:09Z" };
  await other.refresh();
  assert.equal(other.getSnapshot().meta!.version, "new");
  assert.ok(other.getSnapshot().error);
});
test("bad final counts, cursor loops, shifted bounds and changed ordinals fail without empty success", async () => {
  for (const kind of ["count", "loop", "bounds", "ordinal", "stale"]) {
    const m = meta();
    const store = new SkyDataStore(async (p) => {
      if (p === "/v1/me/sky") return m;
      const q = parse(p);
      if (!q.cursor)
        return {
          ...tile(m, q.box, q.level, [star("1", 0, 0)]),
          rangeStarCount: 3,
          nextCursor: "cursor",
        };
      const data = {
        ...tile(m, q.box, q.level, [star("2", 1, 0)]),
        rangeStarCount: 3,
        nextCursor: null as string | null,
      };
      if (kind === "loop") data.nextCursor = "cursor";
      if (kind === "bounds") data.bounds = { ...q.box, w: q.box.w + 256 };
      if (kind === "ordinal") data.stars[0].layoutOrdinal = 1;
      return kind === "stale"
        ? { ...data, asOf: "2026-09-14T00:00:00Z" }
        : data;
    }, "a");
    await store.refresh();
    await store.setView(view);
    assert.equal(store.getSnapshot().phase, "partial", kind);
    assert.equal(store.getSnapshot().loadedCount, 1, kind);
    assert.equal(store.getSnapshot().failures.length, 1, kind);
  }
});
test("same-version metadata changes and unknown level are rejected, empty outside range succeeds", async () => {
  let m = meta();
  const store = new SkyDataStore(
    async (p) => (p === "/v1/me/sky" ? m : undefined),
    "a",
  );
  await store.refresh();
  await store.setView({ ...view, box: { x: 1e9, y: 1e9, w: 1, h: 1 } });
  assert.equal(store.getSnapshot().phase, "ready");
  await store.setView({ ...view, level: 99 });
  assert.ok(store.getSnapshot().error);
  m = { ...m, starCount: m.starCount + 1 };
  await store.refresh();
  assert.equal(store.getSnapshot().needsRefresh, true);
});
test("invalid cursor waits for manual retry then starts the failed range at page one", async () => {
  const m = meta(),
    paths: string[] = [];
  let invalid = true;
  const store = new SkyDataStore(async (p) => {
    if (p === "/v1/me/sky") return m;
    paths.push(p);
    const q = parse(p);
    if (!q.cursor)
      return {
        ...tile(m, q.box, q.level, [star("1", 0, 0)]),
        rangeStarCount: 2,
        nextCursor: "next",
      };
    if (invalid) throw new ApiError(400, "VALIDATION_FAILED", "cursor expired");
    return { ...tile(m, q.box, q.level, [star("2", 1, 0)]), rangeStarCount: 2 };
  }, "a");
  await store.refresh();
  await store.setView(view);
  assert.equal(paths.length, 2);
  assert.equal(store.getSnapshot().loadedCount, 1);
  invalid = false;
  await store.retry();
  assert.equal(parse(paths[2]).cursor, null);
  assert.equal(store.getSnapshot().phase, "ready");
  assert.equal(store.getSnapshot().loadedCount, 2);
});
test("global count and metadata bounds cannot silently contradict valid-looking individual ranges", async () => {
  const m = { ...meta(), starCount: 1 };
  const store = new SkyDataStore(async (p) => {
    if (p === "/v1/me/sky") return m;
    const q = parse(p);
    return tile(m, q.box, q.level, [star(String(q.box.x + 1), q.box.x, 0)]);
  }, "a");
  await store.refresh();
  await store.setView({ level: 0, box: { x: 0, y: 0, w: 17 * 256, h: 256 } });
  assert.equal(store.getSnapshot().phase, "partial");
  assert.equal(store.getSnapshot().loadedCount, 1);
  assert.equal(store.getSnapshot().failures.length, 2);
});
