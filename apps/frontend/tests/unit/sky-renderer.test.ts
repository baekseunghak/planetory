import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cameraMatrix,
  INITIAL_CAMERA,
  initialCamera,
  renderPlan,
  screenPoint,
  starStyle,
  readOwnedSystem,
} from "../../src/features/sky-renderer/model.ts";
import { exampleStar, appearance } from "../../dev/sky-reference/reference.mjs";
import { meta } from "./sky-support.ts";
import type { Star } from "../../src/features/sky-data/contracts.ts";
const vectors = JSON.parse(
  readFileSync(
    new URL("../../dev/sky-reference/vectors.json", import.meta.url),
    "utf8",
  ),
);
test("AT-125: 12 independent golden vectors reproduce appearance and CPU/shader matrix projection", () => {
  for (const v of vectors.vectors) {
    const style = starStyle(v),
      p = screenPoint(
        cameraMatrix(vectors.camera, 1440, 836),
        1440,
        836,
        v.x,
        v.y,
        v.depthZ,
      );
    assert(Math.abs(style.baseSize - v.baseSize) <= 1e-9);
    style.rgb.forEach((x, i) => assert(Math.abs(x - v.rgb[i]) <= 1e-9));
    assert(Math.abs(p.x - v.screen.x) <= 0.00001);
    assert(Math.abs(p.y - v.screen.y) <= 0.00001);
  }
});
test("all 1000 original appearances are invariant to status, page order and an added discovery", () => {
  const stars: Star[] = Array.from({ length: 1000 }, (_, i) => exampleStar(i));
  const before = new Map(stars.map((s) => [s.ticId, starStyle(s)]));
  const reversed: Star[] = [...stars].reverse().map((s) => ({
    ...s,
    planetCount: 5,
    completedWithoutPlanets: false,
    progressStage: "completed" as const,
  }));
  reversed.push(exampleStar(1000));
  for (const s of reversed.slice(0, 1000)) {
    assert.deepEqual(starStyle(s), before.get(s.ticId));
    assert.deepEqual(starStyle(s), appearance(s));
  }
  const changed = {
    ...stars[0],
    planetCount: 0,
    completedWithoutPlanets: true,
    progressStage: "completed" as const,
  };
  assert.deepEqual(starStyle(changed), before.get(changed.ticId));
});
test("render plan never caps individual stars at 400 or attaches overview orbit/cluster data", () => {
  const stars = Array.from({ length: 2501 }, (_, i) => exampleStar(i));
  const plan = renderPlan(
    stars,
    cameraMatrix(INITIAL_CAMERA, 1440, 836),
    1440,
    836,
  );
  assert.equal(plan.stars.length, 2501);
  assert.deepEqual(Object.keys(plan), ["stars"]);
  const far = { ...stars[0], x: 1e6 };
  assert.equal(
    renderPlan([far], cameraMatrix(INITIAL_CAMERA, 1440, 836), 1440, 836).stars
      .length,
    0,
  );
});
test("whole-view uses stored bounds at 1/10/100/1000 and never rewrites positions", () => {
  for (const n of [1, 10, 100, 1000]) {
    const stars = Array.from({ length: n }, (_, i) => exampleStar(i)),
      before = structuredClone(stars);
    const m = {
      ...meta(),
      starCount: n,
      bounds: {
        minX: Math.min(...stars.map((s) => s.x)),
        maxX: Math.max(...stars.map((s) => s.x)),
        minY: Math.min(...stars.map((s) => s.y)),
        maxY: Math.max(...stars.map((s) => s.y)),
      },
    };
    const matrix = cameraMatrix(initialCamera(m, 1440, 836), 1440, 836);
    assert.equal(renderPlan(stars, matrix, 1440, 836).stars.length, n);
    for (const s of stars) {
      const p = screenPoint(matrix, 1440, 836, s.x, s.y, s.depthZ);
      assert(p.x >= 0 && p.x <= 1440 && p.y >= 0 && p.y <= 836);
    }
    assert.deepEqual(stars, before);
  }
});

test("camera culling preserves every visible star, order and depth at viewport edges", () => {
  const stars = Array.from({ length: 4097 }, (_, i) => exampleStar(i));
  for (const width of [1024, 1440])
    for (const zoom of [0.001, 1, 3, 9, 30])
      for (const yaw of [-2, 0.12, 1.5]) {
        const matrix = cameraMatrix(
          { ...INITIAL_CAMERA, zoom, yaw, x: 150, y: -80 },
          width,
          836,
        );
        const expected = stars.filter((s) => {
          const p = screenPoint(matrix, width, 836, s.x, s.y, s.depthZ);
          return (
            Math.abs(p.depth) <= 1 &&
            p.x >= -80 &&
            p.x <= width + 80 &&
            p.y >= -80 &&
            p.y <= 916
          );
        });
        const plan = renderPlan(stars, matrix, width, 836);
        assert.deepEqual(plan.stars, expected);
        if (plan.spans) {
          assert.equal(plan.spans.source, stars);
          assert.deepEqual(
            plan.spans.ranges.flatMap(([start, end]) =>
              stars.slice(start, end),
            ),
            expected,
          );
        }
      }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const boundary = [-1.16, 1.16, -1.160001, 1.160001].map((x, i) => ({
    ...stars[i],
    x,
    y: 0,
    depthZ: 0,
  }));
  boundary.push(
    { ...stars[4], x: 0, y: 0, depthZ: 1 },
    { ...stars[5], x: 0, y: 0, depthZ: 1.00001 },
  );
  assert.deepEqual(renderPlan(boundary, identity, 1000, 1000).stars, [
    boundary[0],
    boundary[1],
    boundary[4],
  ]);
});
const detail = (count: number) => {
  const s = { ...exampleStar(0), planetCount: count },
    m = meta();
  const value = {
    ticId: s.ticId,
    version: m.version,
    presentationVersion: m.presentationVersion,
    unlock: {
      position: {
        x: s.x,
        y: s.y,
        depthZ: s.depthZ,
        layoutOrdinal: s.layoutOrdinal,
        layoutVersion: m.layoutVersion,
      },
    },
    planets: {
      count,
      items: Array.from({ length: count }, (_, i) => ({
        candidateId: "p" + i,
        kind: "confirmed",
        periodDays: i ? i : null,
        depthPpm: i ? 300 : 0,
      })),
    },
  };
  return { s, m, value };
};
test("0/1/2/5 selected owned planets preserve IDs, full arrays and null versus zero", () => {
  for (const n of [0, 1, 2, 5]) {
    const { s, m, value } = detail(n),
      out = readOwnedSystem(value, m, s.ticId, s);
    assert.equal(out.items.length, n);
    assert.equal(out.version, m.version);
    if (n) {
      assert.equal(out.items[0].periodDays, null);
      assert.equal(out.items[0].depthPpm, 0);
    }
  }
});
test("selected detail rejects mismatched version, positions, count, duplicate or forbidden planets", () => {
  const cases = [
    (v: any) => (v.version = "stale"),
    (v: any) => (v.unlock.position.depthZ = 0.5),
    (v: any) => (v.planets.count = 4),
    (v: any) => (v.planets.items[1].candidateId = "p0"),
    (v: any) => (v.planets.items[0].kind = "fp"),
    (v: any) => (v.unlock.position.layoutOrdinal = 100),
  ];
  for (const change of cases) {
    const { s, m, value } = detail(5);
    change(value);
    assert.throws(() => readOwnedSystem(value, m, s.ticId, s));
  }
});
test("camera validates finite zoom and tilt boundaries", () => {
  for (const patch of [
    { zoom: 0 },
    { zoom: 10001 },
    { tilt: 1.43 },
    { x: NaN },
  ])
    assert.throws(() =>
      cameraMatrix({ ...INITIAL_CAMERA, ...patch }, 1440, 836),
    );
  for (const zoom of [0.001, 10000])
    assert.doesNotThrow(() =>
      cameraMatrix({ ...INITIAL_CAMERA, zoom }, 1440, 836),
    );
});
