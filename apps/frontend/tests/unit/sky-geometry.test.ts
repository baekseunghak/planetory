import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cacheKey,
  cellId,
  inverse,
  orthographicMatrix,
  requestGroups,
  tileQuery,
  transform,
  viewportBounds,
  visibleCells,
} from "../../src/features/sky-data/geometry";
import {
  readSkyMeta,
  readSkyTiles,
} from "../../src/features/sky-data/contracts";
import { meta, star } from "./sky-support";
test("orthographic inverse applies screen margin and uses the whole depth slab", () => {
  const matrix = orthographicMatrix(
      { x: 0, y: 0, rotation: 0, tilt: 0, scale: 1 },
      800,
      600,
      160,
      10000,
    ),
    b = viewportBounds(matrix)!;
  assert.ok(Math.abs(b.x + 560) < 1e-8);
  assert.ok(Math.abs(b.w - 1120) < 1e-8);
  assert.ok(Math.abs(b.y + 420) < 1e-8);
  assert.ok(Math.abs(b.h - 840) < 1e-8);
  const tilted = viewportBounds(
    orthographicMatrix(
      { x: 0, y: 0, rotation: 0, tilt: Math.PI / 3, scale: 1 },
      800,
      600,
      160,
      10000,
    ),
  )!;
  assert.ok(tilted.h > 840 / Math.cos(Math.PI / 3));
});
test("rotation, tilt, pan and depth: every independently forward-visible sample is requested", () => {
  for (const rotation of [0, 0.3, Math.PI / 2])
    for (const tilt of [0, 0.6, 1.4]) {
      const c = { x: -210, y: 120, rotation, tilt, scale: 0.75 },
        matrix = orthographicMatrix(c, 800, 600, 160, 10000),
        b = viewportBounds(matrix)!;
      for (let x = -2500; x <= 2500; x += 70)
        for (let y = -2200; y <= 2200; y += 80)
          for (const z of [-1, 0, 1]) {
            const dx = x - c.x,
              dy = y - c.y,
              screenX =
                (Math.cos(rotation) * dx - Math.sin(rotation) * dy) * c.scale;
            const screenY =
              (Math.cos(tilt) *
                (Math.sin(rotation) * dx + Math.cos(rotation) * dy) -
                Math.sin(tilt) * 160 * z) *
              c.scale;
            if (Math.abs(screenX) <= 560 && Math.abs(screenY) <= 420)
              assert.ok(
                x >= b.x - 1e-7 &&
                  x <= b.x + b.w + 1e-7 &&
                  y >= b.y - 1e-7 &&
                  y <= b.y + b.h + 1e-7,
                `${rotation},${tilt},${x},${y},${z}`,
              );
          }
    }
});
test("perspective frustum intersects normalized depth before choosing the world bbox", () => {
  const f = 1 / Math.tan(Math.PI / 8),
    a = -(2000 + 1) / (2000 - 1),
    b = (-2 * 2000) / (2000 - 1);
  const matrix = [
      f / (4 / 3),
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      a * 50,
      -50,
      0,
      0,
      -800 * a + b,
      800,
    ],
    box = viewportBounds(matrix)!;
  for (let x = -700; x < 700; x += 30)
    for (let y = -700; y < 700; y += 30)
      for (const z of [-1, 0, 1]) {
        const px = ((f / (4 / 3)) * x) / (800 - 50 * z),
          py = (f * y) / (800 - 50 * z);
        if (Math.abs(px) <= 1.4 && Math.abs(py) <= 1.4)
          assert.ok(
            x >= box.x - 1e-7 &&
              x <= box.x + box.w + 1e-7 &&
              y >= box.y - 1e-7 &&
              y <= box.y + box.h + 1e-7,
          );
      }
  const p = { x: 13, y: -44, z: 0.42 },
    roundtrip = transform(inverse(matrix), transform(matrix, p));
  for (const k of ["x", "y", "z"] as const)
    assert.ok(Math.abs(p[k] - roundtrip[k]) < 1e-7);
  assert.throws(() => inverse(Array(16).fill(0)));
});
test("negative/exact tile boundaries use floor and half-open ranges without duplicate cells", () => {
  const m = meta();
  assert.deepEqual(
    visibleCells({ x: -256, y: -256, w: 256, h: 256 }, m).map(cellId),
    ["-1:-1"],
  );
  assert.deepEqual(
    visibleCells({ x: -0.1, y: -0.1, w: 0.2, h: 0.2 }, m).map(cellId),
    ["-1:-1", "0:-1", "-1:0", "0:0"],
  );
  assert.deepEqual(visibleCells({ x: 50000, y: 50000, w: 256, h: 256 }, m), []);
  assert.equal(
    visibleCells(
      { x: 0, y: 0, w: 1, h: 1 },
      { ...m, bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 } },
    ).length,
    1,
  );
});
test("bbox protocol permits 64x64 tiles, splits wider views and sends no keys or 16-tile cap", () => {
  const m = {
    ...meta(),
    bounds: { minX: 0, maxX: 256 * 140, minY: 0, maxY: 256 * 140 },
  };
  const cells = visibleCells({ x: 0, y: 0, w: 256 * 65, h: 256 * 65 }, m),
    groups = requestGroups(cells, 64);
  assert.equal(groups.length, 4);
  assert.equal(groups.flatMap((g) => g.cells).length, 65 * 65);
  assert.equal(
    new Set(groups.flatMap((g) => g.cells.map(cellId))).size,
    65 * 65,
  );
  for (const g of groups) {
    const u = new URL(tileQuery(2, g.box, m), "https://app.test");
    assert.deepEqual(
      [...u.searchParams.keys()],
      ["level", "x", "y", "w", "h", "version"],
    );
    assert.ok(g.box.w <= 256 * 64 && g.box.h <= 256 * 64);
  }
  assert.doesNotThrow(() =>
    tileQuery(2, { x: 0, y: 0, w: 256 * 64, h: 256 * 64 }, m),
  );
  assert.throws(() => tileQuery(2, { x: 0, y: 0, w: 256 * 64 + 0.1, h: 1 }, m));
  assert.throws(() => tileQuery(77, { x: 0, y: 0, w: 1, h: 1 }, m));
  assert.notEqual(
    cacheKey("a:b", "c", 2, cells[0]),
    cacheKey("a", "b:c", 2, cells[0]),
  );
});
test("minimal DTO decoders reject missing arrays and four-level metadata without fabricating data", () => {
  assert.equal(readSkyMeta(meta()).zoomLevels.length, 6);
  assert.throws(() =>
    readSkyMeta({ ...meta(), zoomLevels: meta().zoomLevels.slice(0, 4) }),
  );
  assert.throws(() => readSkyMeta({ ...meta(), version: 123 }));
  const response = {
    version: "v1",
    level: 2,
    versionChanged: false,
    bounds: { x: 0, y: 0, w: 256, h: 256 },
    stars: [star("000123", 0, 0)],
    clusters: [],
  };
  assert.equal(readSkyTiles(response).stars[0].ticId, "000123");
  for (const invalid of [
    { ...response, stars: undefined },
    { ...response, stars: [star("a", 0, 0), star("a", 0, 0)] },
    { ...response, stars: [{ ...star("a", 0, 0), depthZ: 2 }] },
    { ...response, stars: [{ ...star("a", 0, 0), planetCount: 1 }] },
  ])
    assert.throws(() => readSkyTiles(invalid));
});

test("a distant viewport is empty, while an excessive intersecting grid is recoverable", () => {
  const m = meta();
  assert.deepEqual(visibleCells({ x: 1e10, y: 1e10, w: 256, h: 256 }, m), []);
  assert.throws(() =>
    visibleCells(
      { x: 0, y: 0, w: 1e6, h: 1e6 },
      { ...m, bounds: { minX: 0, minY: 0, maxX: 1e6, maxY: 1e6 } },
    ),
  );
});
