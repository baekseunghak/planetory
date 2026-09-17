import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  readSkyMeta,
  readSkyTiles,
  readPersonalDetailProjection,
  DEPTH_SCALE,
} from "../../src/features/sky-data/contracts";
import {
  galaxyMatrix,
  viewportBounds,
  transform,
  tileQuery,
  visibleStarCount,
} from "../../src/features/sky-data/geometry";
import { meta, star, tile, parse } from "./sky-support";
import { SkyDataStore } from "../../src/features/sky-data/store";
import {
  exampleAccount,
  exampleStar,
  appearance,
  project,
  INITIAL_CAMERA,
} from "../../dev/sky-reference/reference.mjs";
const cases = JSON.parse(
  readFileSync(
    new URL("../../dev/sky-reference/contracts.json", import.meta.url),
    "utf8",
  ),
).cases;
const vectors = JSON.parse(
  readFileSync(
    new URL("../../dev/sky-reference/vectors.json", import.meta.url),
    "utf8",
  ),
);
test("only new representation/versions are accepted; a one-level meta is valid", () => {
  assert.equal(
    readSkyMeta({ ...meta(), zoomLevels: [{ level: 0, scale: 0.1 }] })
      .zoomLevels.length,
    1,
  );
  for (const invalid of [
    { representation: undefined },
    { layoutVersion: undefined },
    { presentationVersion: "future" },
    { overview: [] },
    { zoomLevels: [{ level: 0, scale: 1, clustered: false }] },
    { zoomLevels: [] },
    { zoomLevels: [{ level: 1, scale: 1 }] },
    { version: 123 },
  ])
    assert.throws(() => readSkyMeta({ ...meta(), ...invalid }));
});
test("new tile has stable ordinal and no cosmetic/orbit fields, preserving string TICs", () => {
  const m = meta(),
    b = { x: 0, y: 0, w: 256, h: 256 },
    valid = tile(m, b, 0, [star("000123", 0, 0)]);
  assert.equal(readSkyTiles(valid).stars[0].ticId, "000123");
  for (const invalid of [
    { stars: undefined },
    { clusters: [] },
    { nextCursor: undefined },
    { stars: [{ ...valid.stars[0], layoutOrdinal: undefined }] },
    { stars: [{ ...valid.stars[0], layoutOrdinal: 2147483648 }] },
    { stars: [{ ...valid.stars[0], depthZ: 2 }] },
    { stars: [{ ...valid.stars[0], colorLevel: 0 }] },
    { stars: [{ ...valid.stars[0], orbits: [] }] },
    { stars: [{ ...valid.stars[0], x: 256 }] },
    { stars: [star("2", 0, 0), star("1", 1, 0)], rangeStarCount: 2 },
  ])
    assert.throws(() => readSkyTiles({ ...valid, ...invalid }));
  assert.doesNotThrow(() =>
    readSkyTiles({ ...valid, stars: [{ ...valid.stars[0], planetCount: 5 }] }),
  );
  assert.equal(
    readSkyTiles(cases.find((c: any) => c.name === "version-changed").response)
      .versionChanged,
    true,
  );
});
test("query encodes opaque cursor and validates both 64 tile and 1..2000 page boundaries", () => {
  const m = meta(),
    b = { x: 0, y: 0, w: 256 * 64, h: 256 * 64 };
  for (const limit of [1, 1000, 2000]) {
    const q = new URL(
      tileQuery(0, b, m, limit, "opaque /?+&="),
      "https://fixture.test",
    ).searchParams;
    assert.equal(q.get("cursor"), "opaque /?+&=");
    assert.equal(q.get("limit"), String(limit));
    assert.equal(q.has("keys"), false);
  }
  for (const n of [0, 2001, 1.5, NaN])
    assert.throws(() => tileQuery(0, b, m, n));
  assert.throws(() => tileQuery(0, { ...b, h: b.h + 1 }, m));
});
test("galaxy matrix matches all twelve independent reference screen vectors and restores depth once", () => {
  assert.equal(DEPTH_SCALE, 256);
  const { width, height } = vectors.canvas;
  const matrix = galaxyMatrix(vectors.camera, width, height);
  for (const s of vectors.vectors) {
    const p = transform(matrix, { x: s.x, y: s.y, z: s.depthZ });
    assert.ok(Math.abs(((p.x + 1) * width) / 2 - s.screen.x) < 0.00001);
    assert.ok(Math.abs(((1 - p.y) * height) / 2 - s.screen.y) < 0.00001);
  }
});
test("rotated galaxy bbox includes every star inside the 20% margin at full normalized depth", () => {
  for (const yaw of [0, 0.12, 1.2])
    for (const tilt of [-1.42, 0, 1, 1.42])
      for (const roll of [-0.28, 0.7]) {
        const c = {
          ...INITIAL_CAMERA,
          x: 150,
          y: -80,
          yaw,
          tilt,
          roll,
          zoom: 2,
        };
        const matrix = galaxyMatrix(c, 1440, 836),
          b = viewportBounds(matrix)!;
        for (const s of exampleAccount(1000))
          for (const depthZ of [-1, s.depthZ, 1]) {
            const p = project({ ...s, depthZ }, c, 1440, 836);
            if (p.x >= -288 && p.x <= 1728 && p.y >= -167.2 && p.y <= 1003.2)
              assert.ok(
                s.x >= b.x - 1e-6 &&
                  s.x <= b.x + b.w + 1e-6 &&
                  s.y >= b.y - 1e-6 &&
                  s.y <= b.y + b.h + 1e-6,
              );
          }
      }
  const m = galaxyMatrix(INITIAL_CAMERA, 1440, 836);
  assert.ok(visibleStarCount([exampleStar(0)], m) <= 1);
  assert.throws(() =>
    galaxyMatrix({ ...INITIAL_CAMERA, zoom: Infinity }, 1440, 836),
  );
});
test("published first/last-page fixtures are accepted and reach ten unique stars", async () => {
  const first = cases.find((c: any) => c.name === "first-page"),
    last = cases.find((c: any) => c.name === "last-page");
  const m = readSkyMeta(first.meta);
  let calls = 0;
  const store = new SkyDataStore(
    async (p) =>
      p === "/v1/me/sky" ? m : ++calls === 1 ? first.response : last.response,
    "reference",
    1024,
    6,
  );
  await store.refresh();
  await store.setView({
    level: first.response.level,
    box: first.response.bounds,
  });
  assert.equal(store.getSnapshot().phase, "ready");
  assert.equal(store.getSnapshot().loadedCount, 10);
  assert.equal(calls, 2);
});
test("detail 0/1/2/5 planets retain full items and reject old version, duplicates and bad counts", () => {
  const first = cases.find((c: any) => c.name === "first-page"),
    m = readSkyMeta(first.meta);
  for (const count of [0, 1, 2, 5]) {
    const c = cases.find((c: any) => c.name === "selected-planets-" + count);
    const result = readPersonalDetailProjection(
      c.response,
      m,
      c.response.ticId,
    );
    assert.equal(result.planets.count, count);
  }
  for (const name of [
    "mismatched-detail-version",
    "count-mismatch",
    "duplicate-candidate",
  ]) {
    const c = cases.find((c: any) => c.name === name);
    assert.throws(
      () =>
        readPersonalDetailProjection(
          c.response,
          name === "mismatched-detail-version"
            ? { ...m, version: "fixture-a:2" }
            : m,
          c.response.ticId,
        ),
      name,
    );
  }
  const c = cases.find((c: any) => c.name === "selected-planets-1"),
    d = structuredClone(c.response);
  d.planets.items[0].periodDays = null;
  d.planets.items[0].depthPpm = null;
  assert.equal(
    readPersonalDetailProjection(d, m, d.ticId).planets.items[0].periodDays,
    null,
  );
});
test("store preserves server position and appearance inputs after status, page order and discovery changes", async () => {
  const before = exampleAccount(1000);
  let stars = structuredClone(before),
    m = {
      ...meta(),
      starCount: 1000,
      bounds: { minX: -1600, maxX: 1600, minY: -1600, maxY: 1600 },
    };
  const store = new SkyDataStore(async (path) => {
    if (path === "/v1/me/sky") return m;
    const q = parse(path);
    // Rows finish in different orders, independently of server record order.
    if (q.box.x < 0) await new Promise((resolve) => setImmediate(resolve));
    return tile(m, q.box, q.level, stars);
  }, "a");
  await store.refresh();
  await store.setView({
    level: 0,
    box: { x: -1600, y: -1600, w: 3200, h: 3200 },
  });
  assert.equal(store.getSnapshot().loadedCount, 1000);
  stars = [...structuredClone(before), exampleStar(1000)]
    .reverse()
    .map((s) => ({
      ...s,
      planetCount: 5,
      progressStage: "in_progress" as const,
    }));
  m = { ...m, version: "v2", starCount: 1001 };
  await store.notifySkyChanged({ skyVersion: "v2" });
  const after = store.getSnapshot().stars;
  assert.equal(after.length, 1001);
  for (const s of before) {
    const next = after.find((t) => t.ticId === s.ticId)!;
    for (const k of ["x", "y", "depthZ", "layoutOrdinal"] as const)
      assert.equal(next[k], s[k]);
    assert.deepEqual(appearance(next), appearance(s));
  }
  assert.deepEqual(before, exampleAccount(1000));
});
