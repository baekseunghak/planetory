import test from "node:test";
import assert from "node:assert/strict";
import type { Star, Cluster } from "../../src/features/sky-data/contracts.ts";
import {
  inverse,
  transform,
  viewportBounds,
} from "../../src/features/sky-data/geometry.ts";
import {
  cameraMatrix,
  clusterColor,
  COMPLETE_COLOR,
  readOwnedSystem,
  renderPlan,
  rgb,
  starStyle,
} from "../../src/features/sky-renderer/model.ts";
const star = (i = 0, n = 0): Star => ({
  ticId: String(i),
  x: 0,
  y: 0,
  depthZ: 0,
  planetCount: n,
  colorLevel: Math.min(4, n),
  sizeLevel: Math.min(4, n),
  progressStage: "in_progress",
  completedWithoutPlanets: false,
  marker: null,
  reopened: false,
  orbits: Array.from({ length: n }, (_, j) => ({
    candidateId: `${i}-${j}`,
    periodDays: j + 1,
    kind: "confirmed",
  })),
});
const camera = { x: 0, y: 0, scale: 1, rotation: 0.3, tilt: 0.8, roll: -0.28 };
test("HOME-05 colors/sizes depend on planet count; apricot requires explicit completedWithoutPlanets", () => {
  const s = star(),
    colors = new Set(),
    sizes = [];
  for (let n = 0; n <= 5; n++) {
    const style = starStyle(star(n, n));
    colors.add(style.color);
    sizes.push(style.radius);
  }
  assert.equal(colors.size, 5);
  assert.equal(sizes[4], sizes[5]);
  for (let i = 1; i < 5; i++) assert(sizes[i] > sizes[i - 1]);
  assert.equal(
    starStyle({
      ...s,
      progressStage: "completed",
      completedWithoutPlanets: true,
    }).color,
    COMPLETE_COLOR,
  );
  assert.notEqual(starStyle(s).color, COMPLETE_COLOR);
  assert.throws(() => starStyle({ ...s, colorLevel: 4 }));
});
test("cluster color uses authoritative ratios without changing node or counts", () => {
  const c: Cluster = {
    nodeId: "n",
    x: 1,
    y: 2,
    count: 10,
    counts: { planet: 0, done: 10, new: 0 },
    bounds: { x: 0, y: 0, w: 512, h: 512 },
  };
  const before = structuredClone(c);
  assert.deepEqual(clusterColor(c), rgb(COMPLETE_COLOR));
  assert.deepEqual(c, before);
});
test("camera rotation/tilt/resize preserve stored coordinates and inverse viewport contains visible full-depth points", () => {
  const source = Array.from({ length: 81 }, (_, i) => ({
    ...star(i),
    x: ((i % 9) - 4) * 35,
    y: (Math.floor(i / 9) - 4) * 35,
    depthZ: (i % 3) - 1,
  }));
  const before = structuredClone(source);
  for (const width of [1024, 1440, 1920])
    for (const tilt of [-1.2, 0, 1.2]) {
      const matrix = cameraMatrix({ ...camera, tilt }, width, 900),
        inv = inverse(matrix),
        bounds = viewportBounds(matrix)!;
      for (const s of source) {
        const p = transform(matrix, { x: s.x, y: s.y, z: s.depthZ }),
          back = transform(inv, p);
        assert(Math.abs(back.x - s.x) < 1e-7);
        assert(Math.abs(back.y - s.y) < 1e-7);
        if (Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1) {
          assert(s.x >= bounds.x && s.x <= bounds.x + bounds.w);
          assert(s.y >= bounds.y && s.y <= bounds.y + bounds.h);
        }
      }
      renderPlan(source, [], matrix, width, 900);
    }
  assert.deepEqual(source, before);
});
test("render budgets fail explicitly without truncating or inventing official clusters", () => {
  const matrix = cameraMatrix(camera, 1440, 900);
  assert.equal(
    renderPlan(
      Array.from({ length: 401 }, (_, i) => star(i)),
      [],
      matrix,
      1440,
      900,
    ).overflow,
    "별 400개",
  );
  assert.equal(
    renderPlan(
      Array.from({ length: 61 }, (_, i) => star(i, 1)),
      [],
      matrix,
      1440,
      900,
    ).overflow,
    "궤도 표시 별 60개",
  );
  const nodes = Array.from({ length: 81 }, (_, i): Cluster => ({
    nodeId: String(i),
    x: 0,
    y: 0,
    count: 10,
    counts: { planet: 2, done: 3, new: 5 },
    bounds: { x: -30, y: -30, w: 60, h: 60 },
  }));
  const plan = renderPlan([], nodes, matrix, 1440, 900);
  assert.equal(plan.overflow, "성운 80개");
  assert.equal(plan.clusters.length, 81);
  assert.strictEqual(plan.clusters[0].node, nodes[0]);
  const outside = { ...star(9), x: 1e5 };
  assert.equal(renderPlan([outside], [], matrix, 1440, 900).stars.length, 0);
});
const detail = () => ({
  ticId: "001",
  unlock: { position: { x: 12, y: -20, depthZ: 0.42 } },
  planets: {
    count: 5,
    completedWithoutPlanets: false,
    items: Array.from({ length: 5 }, (_, i) => ({
      candidateId: `p${i}`,
      kind: i % 2 ? "unconfirmed" : "confirmed",
      periodDays: i ? i : null,
      depthPpm: i ? 100 : 0,
    })),
  },
});
test("personal-system boundary preserves all five owned items, stable IDs and null vs zero", () => {
  const d = detail(),
    read = readOwnedSystem(d);
  assert.equal(read.items.length, 5);
  assert.equal(read.items[0].periodDays, null);
  assert.equal(read.items[0].depthPpm, 0);
  assert.equal(read.position.depthZ, 0.42);
  assert.deepEqual(readOwnedSystem(d), read);
  const empty = detail();
  empty.planets.count = 0;
  empty.planets.items = [];
  assert.equal(readOwnedSystem(empty).items.length, 0);
});
test("invalid private planet payloads are errors, not silently deduplicated or filled", () => {
  const duplicate = detail();
  duplicate.planets.items[1].candidateId = "p0";
  assert.throws(() => readOwnedSystem(duplicate));
  const count = detail();
  count.planets.count = 4;
  assert.throws(() => readOwnedSystem(count));
  const fp = detail();
  fp.planets.items[0].kind = "fp";
  assert.throws(() => readOwnedSystem(fp));
  const depth = detail();
  depth.unlock.position.depthZ = 18;
  assert.throws(() => readOwnedSystem(depth));
  const absent = detail();
  delete (absent.planets.items[0] as any).depthPpm;
  assert.throws(() => readOwnedSystem(absent));
});
