import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HitGrid,
  markerLabel,
  panCamera,
  planetLabel,
  readTutorialMarkers,
  readChallengeTicId,
  rotateCamera,
  starTargets,
  zoomCamera,
  type HitTarget,
} from "../../src/features/sky-renderer/interaction.ts";
import {
  cameraMatrix,
  INITIAL_CAMERA,
  screenPoint,
} from "../../src/features/sky-renderer/model.ts";
import { exampleStar } from "../../dev/sky-reference/reference.mjs";
test("wheel anchor stays under the pointer through rotation/depth and zoom clamps", () => {
  const s = exampleStar(8),
    c = { ...INITIAL_CAMERA, yaw: 2.1, tilt: -1.2, x: 90 },
    width = 1024,
    height = 650;
  const p = screenPoint(
    cameraMatrix(c, width, height),
    width,
    height,
    s.x,
    s.y,
    s.depthZ,
  );
  for (const factor of [2, 0.1, 1e12, 1e-12]) {
    const next = zoomCamera(c, factor, p.x, p.y, width, height);
    const after = screenPoint(
      cameraMatrix(next, width, height),
      width,
      height,
      s.x,
      s.y,
      s.depthZ,
    );
    assert.ok(Math.abs(p.x - after.x) < 1e-6 && Math.abs(p.y - after.y) < 1e-6);
    assert.ok(next.zoom >= 0.001 && next.zoom <= 10000);
  }
});
test("pan is screen-space at any yaw/tilt; camera changes never mutate stored coordinates", () => {
  const s = exampleStar(0),
    before = JSON.stringify(s),
    width = 1024,
    height = 640;
  const a = screenPoint(
    cameraMatrix(INITIAL_CAMERA, width, height),
    width,
    height,
    s.x,
    s.y,
    s.depthZ,
  );
  const b = screenPoint(
    cameraMatrix(
      panCamera(INITIAL_CAMERA, 70, -35, width, height),
      width,
      height,
    ),
    width,
    height,
    s.x,
    s.y,
    s.depthZ,
  );
  assert.ok(Math.abs(b.x - a.x - 70) < 1e-8 && Math.abs(b.y - a.y + 35) < 1e-8);
  assert.equal(JSON.stringify(s), before);
  assert.equal(rotateCamera(INITIAL_CAMERA, 5, 999).tilt, 1.42);
  assert.equal(rotateCamera(INITIAL_CAMERA, 5, -999).tilt, -1.42);
});
test("64px grid visits nearby cells, handles cell borders, ties and no cloud hit", () => {
  const targets: HitTarget[] = Array.from({ length: 2501 }, (_, i) => ({
    id: String(i),
    kind: "star",
    x: i * 70,
    y: 63,
    radius: 8,
    label: String(i),
  }));
  const grid = new HitGrid(targets);
  assert.equal(grid.hit(70, 65)?.id, "1");
  assert.ok(grid.examined < 4);
  assert.equal(grid.hit(35, 63), null);
  const same = new HitGrid([
    { ...targets[0], id: "b" },
    { ...targets[0], id: "a" },
  ]);
  assert.equal(same.hit(0, 63)?.id, "a");
});
test("only rendered visible stars enter index and source stars remain unchanged", () => {
  const stars = Array.from({ length: 1000 }, (_, i) => exampleStar(i)),
    before = JSON.stringify(stars);
  const targets = starTargets(
    stars,
    cameraMatrix({ ...INITIAL_CAMERA, zoom: 25 }, 1024, 640),
    1024,
    640,
    25,
    null,
    null,
  );
  assert.ok(targets.length < stars.length);
  assert.ok(
    targets.every((t) => t.x >= -80 && t.x <= 1104 && t.y >= -80 && t.y <= 720),
  );
  assert.equal(JSON.stringify(stars), before);
});
test("tutorial completion/skipping hides badge, missing state never guesses, challenge remains", () => {
  const value = {
    tutorial: {
      items: Array.from({ length: 5 }, (_, i) => ({
        seq: i + 1,
        status: i < 2 ? "completed" : "unlocked",
        ticId: String(900000001 + i),
        completionReason: i === 1 ? "skipped" : i === 0 ? "all_found" : null,
      })),
    },
  };
  const state = readTutorialMarkers(value);
  assert.equal(markerLabel(exampleStar(0), state), null);
  assert.equal(markerLabel(exampleStar(1), state), null);
  assert.equal(markerLabel(exampleStar(2), state), "3");
  assert.equal(markerLabel(exampleStar(2), null), null);
  assert.equal(markerLabel(exampleStar(5), null), null);
  const challenge = readChallengeTicId({
    challenge: { unlocked: true, ticId: exampleStar(5).ticId },
  });
  assert.equal(markerLabel(exampleStar(5), state, challenge), "!");
  assert.equal(markerLabel(exampleStar(4), state, challenge), "5");
  assert.equal(
    readChallengeTicId({ challenge: { unlocked: false, ticId: null } }),
    null,
  );
  assert.equal(
    markerLabel({ ...exampleStar(5), marker: { type: "challenge" } }, null),
    null,
  );
  for (const value of [
    {},
    { challenge: { unlocked: false, ticId: "123" } },
    { challenge: { unlocked: true, ticId: null } },
    { challenge: { unlocked: true, ticId: 123 } },
  ])
    assert.throws(() => readChallengeTicId(value));
  assert.throws(() => readTutorialMarkers({ tutorial: { items: [] } }));
});
test("planet identity and null measurements are displayed without invented values", () => {
  assert.match(
    planetLabel({
      candidateId: "p1",
      kind: "unconfirmed",
      periodDays: null,
      depthPpm: null,
    }),
    /주기 정보 없음 · 감광 깊이 정보 없음/,
  );
  assert.match(
    planetLabel({
      candidateId: "p2",
      kind: "confirmed",
      periodDays: 2.5,
      depthPpm: 100,
    }),
    /100 ppm \(0.01%\)/,
  );
});

test("partially visible edge markers stay indexed until the padded scene clips them", () => {
  const star = exampleStar(0),
    width = 1024,
    height = 640;
  const point = screenPoint(
    cameraMatrix(INITIAL_CAMERA, width, height),
    width,
    height,
    star.x,
    star.y,
    star.depthZ,
  );
  for (const [x, y, present] of [
    [-5, 320, true],
    [1029, 320, true],
    [512, 652, true],
    [-90, 320, false],
    [512, 730, false],
  ] as const) {
    const camera = panCamera(
      INITIAL_CAMERA,
      x - point.x,
      y - point.y,
      width,
      height,
    );
    const targets = starTargets(
      [star],
      cameraMatrix(camera, width, height),
      width,
      height,
      camera.zoom,
      null,
      null,
    );
    assert.equal(targets.length, present ? 1 : 0);
    if (present) assert.equal(targets[0].id, star.ticId);
  }
});

 test("challenge badge hides on completion and returns when exploration reopens", () => {
  const star = exampleStar(5);
  for (const progressStage of ["unexplored", "in_progress", "completed", "in_progress"] as const) {
    assert.equal(markerLabel({ ...star, progressStage }, null, star.ticId), progressStage === "completed" ? null : "!");
  }
});
