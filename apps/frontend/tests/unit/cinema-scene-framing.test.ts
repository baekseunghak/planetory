import assert from "node:assert/strict";
import { test } from "node:test";
import { PerspectiveCamera, Vector3 } from "three";
import {
  BASE_FOV,
  DEFAULT_VIEW,
  HOME_DISTANCE,
  boundsCenter,
  boundsFramePoints,
  cameraBasis,
  fitDistance,
  fitPointsInView,
  focalPx,
  starWorld,
  viewDirection,
  viewOffset,
  type Bounds,
  type ScreenRect,
  type Vec3,
} from "../../src/cinema/scene/math";
import { MARKER_FRAME_MARGIN } from "../../src/cinema/shell/first-story";
import type { ViewInset } from "../../src/cinema/scene/contract";
import { exampleStar } from "../../dev/sky-reference/reference.mjs";
import type { Star } from "../../src/features/sky-data/contracts";

// The resting galaxy (the end of the login fly-in) keeps every tutorial
// marker on screen: engine `homePose` = the home pose moved by
// `fitPointsInView`, checked here through a three.js camera placed exactly
// as CameraRig places it (lookAt, then rotateZ(roll), view offset).

const SIZES = [
  [1440, 900],
  [1024, 768],
] as const;

/** Tutorial stars 1–5 sit on the personal-spiral-v1 anchors (ordinals 0–4). */
const tutorials: Star[] = Array.from({ length: 5 }, (_, n) => exampleStar(n));
const world = (star: Pick<Star, "x" | "y" | "depthZ">): Vec3 =>
  starWorld(star.x, star.y, star.depthZ);

function boundsOf(stars: readonly Pick<Star, "x" | "y">[]): Bounds {
  return {
    minX: Math.min(...stars.map((s) => s.x)),
    maxX: Math.max(...stars.map((s) => s.x)),
    minY: Math.min(...stars.map((s) => s.y)),
    maxY: Math.max(...stars.map((s) => s.y)),
  };
}

/** The engine's home pose for these bounds and this view (math only). */
function home(bounds: Bounds, width: number, height: number) {
  const back = viewDirection(DEFAULT_VIEW.yaw, DEFAULT_VIEW.tilt);
  const basis = cameraBasis(back, DEFAULT_VIEW.roll);
  const overview = fitDistance(
    boundsFramePoints(bounds),
    boundsCenter(bounds),
    basis,
    focalPx(height),
    width,
    height,
    0.84,
  );
  return {
    back,
    basis,
    overview,
    target: boundsCenter(bounds),
    distance: overview * HOME_DISTANCE,
  };
}

const safeRect = (
  width: number,
  height: number,
  margin: Required<ViewInset>,
): ScreenRect => ({
  left: margin.left,
  top: margin.top,
  right: width - margin.right,
  bottom: height - margin.bottom,
});

/** Screen px through a three.js camera placed like CameraRig. */
function projector(
  target: Vec3,
  back: Vec3,
  distance: number,
  width: number,
  height: number,
  inset: ViewInset = { right: 0, bottom: 0 },
) {
  const view = viewOffset(width, height, inset);
  const camera = new PerspectiveCamera(view.fov, view.aspect, 0.01, 2400);
  if (view.shifted)
    camera.setViewOffset(
      view.fullWidth,
      view.fullHeight,
      view.offsetX,
      view.offsetY,
      view.width,
      view.height,
    );
  camera.position.set(
    target[0] + back[0] * distance,
    target[1] + back[1] * distance,
    target[2] + back[2] * distance,
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(new Vector3(...target));
  camera.rotateZ(DEFAULT_VIEW.roll);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return (p: Vec3) => {
    const v = new Vector3(...p).project(camera);
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
  };
}

const inside = (
  point: { x: number; y: number },
  rect: ScreenRect,
  slack = 0.5,
) =>
  point.x >= rect.left - slack &&
  point.x <= rect.right + slack &&
  point.y >= rect.top - slack &&
  point.y <= rect.bottom + slack;

test("the plain home pose leaves tutorial markers 1 and 4 off screen for a newcomer (the reported bug)", () => {
  const bounds = boundsOf(tutorials);
  for (const [w, h] of SIZES) {
    const pose = home(bounds, w, h);
    const project = projector(pose.target, pose.back, pose.distance, w, h);
    const off = tutorials
      .map((star, i) => ({ seq: i + 1, ...project(world(star)) }))
      .filter((p) => p.x < 0 || p.x > w || p.y < 0 || p.y > h)
      .map((p) => p.seq);
    assert.deepEqual(off, [1, 4], `${w}x${h}`);
  }
});

test("a newcomer's fly-in ends with all five tutorial markers inside, clear of the top bar and the bottom HUD", () => {
  const bounds = boundsOf(tutorials);
  const points = tutorials.map(world);
  for (const [w, h] of SIZES) {
    const pose = home(bounds, w, h);
    const safe = safeRect(w, h, MARKER_FRAME_MARGIN);
    const fit = fitPointsInView(
      points,
      pose.target,
      pose.basis,
      pose.distance,
      focalPx(h),
      { x: w / 2, y: h / 2 },
      safe,
    );
    assert.equal(fit.moved, true);
    const project = projector(fit.target, pose.back, fit.distance, w, h);
    for (const [i, p] of points.entries()) {
      const star = project(p);
      assert.ok(
        inside(star, safe),
        `${w}x${h} marker ${i + 1} ${star.x},${star.y}`,
      );
      // The marker box (30px, drawn 135% above its star) is under neither
      // the 56px top bar nor the bottom HUD (pills 22 + 40, the first-visit
      // line at 70 + 30), and not at the side edges.
      assert.ok(star.y - 40.5 >= 56 + 16, `${w}x${h} marker ${i + 1} top`);
      assert.ok(star.y <= h - 100 - 16, `${w}x${h} marker ${i + 1} bottom`);
      assert.ok(star.x - 15 >= 24 && star.x + 15 <= w - 24);
    }
    // As close as it can be: still nearer than 전체 보기, never nearer than
    // home, and tight (some marker sits on the left and the right edge).
    assert.ok(fit.distance > pose.distance);
    assert.ok(fit.distance < pose.overview, `${w}x${h} closer than overview`);
    const xs = points.map((p) => project(p).x);
    assert.ok(Math.abs(Math.min(...xs) - safe.left) < 0.5);
    assert.ok(Math.abs(Math.max(...xs) - safe.right) < 0.5);
    // One percent nearer, no pan at all fits the five (scan every pan).
    const nearer = fit.distance * 0.99;
    let fits = false;
    for (let a = -3; a <= 3 && !fits; a += 0.002) {
      const t: Vec3 = [
        fit.target[0] + pose.basis.right[0] * a,
        fit.target[1] + pose.basis.right[1] * a,
        fit.target[2] + pose.basis.right[2] * a,
      ];
      const at = projector(t, pose.back, nearer, w, h);
      const px = points.map((p) => at(p).x);
      fits = Math.min(...px) >= safe.left && Math.max(...px) <= safe.right;
    }
    assert.equal(fits, false, `${w}x${h} minimal distance`);
  }
});

test("a pose that already shows every marker is kept (a member's 1,000-star galaxy)", () => {
  const stars = Array.from({ length: 1000 }, (_, n) => exampleStar(n));
  const bounds = boundsOf(stars);
  for (const [w, h] of SIZES) {
    const pose = home(bounds, w, h);
    const fit = fitPointsInView(
      tutorials.map(world),
      pose.target,
      pose.basis,
      pose.distance,
      focalPx(h),
      { x: w / 2, y: h / 2 },
      safeRect(w, h, MARKER_FRAME_MARGIN),
    );
    assert.equal(fit.moved, false, `${w}x${h}`);
    assert.equal(fit.distance, pose.distance);
    assert.equal(fit.target, pose.target);
  }
});

test("points that fit in size but sit to one side are panned to, not zoomed out for", () => {
  const w = 1440,
    h = 900;
  const back = viewDirection(DEFAULT_VIEW.yaw, DEFAULT_VIEW.tilt);
  const basis = cameraBasis(back, DEFAULT_VIEW.roll);
  const target: Vec3 = [0, 0, 0];
  const offset = (k: number, j: number): Vec3 => [
    basis.right[0] * k + basis.up[0] * j,
    basis.right[1] * k + basis.up[1] * j,
    basis.right[2] * k + basis.up[2] * j,
  ];
  // A small cluster off the right edge and below the bottom at distance 10.
  const points = [offset(7, -3.5), offset(8, -4), offset(7.5, -3)];
  const safe = safeRect(w, h, MARKER_FRAME_MARGIN);
  const before = projector(target, back, 10, w, h);
  assert.ok(points.some((p) => !inside(before(p), safe)));
  const fit = fitPointsInView(
    points,
    target,
    basis,
    10,
    focalPx(h),
    { x: w / 2, y: h / 2 },
    safe,
  );
  assert.equal(fit.moved, true);
  assert.equal(fit.distance, 10, "no zoom when a pan is enough");
  const after = projector(fit.target, back, fit.distance, w, h);
  for (const p of points) assert.ok(inside(after(p), safe));
  // The least pan: one of them rests on the right edge.
  assert.ok(
    points.some((p) => Math.abs(after(p).x - safe.right) < 0.5),
    "pans only as far as needed",
  );
});

test("the free area's centre (a view offset) and points behind the camera are handled", () => {
  const w = 1024,
    h = 768;
  const inset = { top: 56, right: 0, bottom: 300, left: 0 };
  const view = viewOffset(w, h, inset);
  const back = viewDirection(DEFAULT_VIEW.yaw, DEFAULT_VIEW.tilt);
  const basis = cameraBasis(back, DEFAULT_VIEW.roll);
  const points = tutorials.map(world);
  const target = boundsCenter(boundsOf(tutorials));
  const safe = { left: 40, top: 70, right: w - 40, bottom: h - 310 };
  const fit = fitPointsInView(
    points,
    target,
    basis,
    3,
    focalPx(view.height),
    {
      x: view.free.x + view.free.width / 2,
      y: view.free.y + view.free.height / 2,
    },
    safe,
  );
  const project = projector(fit.target, back, fit.distance, w, h, inset);
  for (const p of points) assert.ok(inside(project(p), safe));
  // Starting with the camera among the stars (some behind it) still ends
  // with every one in front and inside.
  const close = fitPointsInView(
    points,
    target,
    basis,
    0.5,
    focalPx(h),
    { x: w / 2, y: h / 2 },
    safeRect(w, h, MARKER_FRAME_MARGIN),
  );
  const from = projector(close.target, back, close.distance, w, h);
  for (const p of points)
    assert.ok(inside(from(p), safeRect(w, h, MARKER_FRAME_MARGIN)));
});

test("nothing to frame, or no room to frame it in, keeps the pose", () => {
  const basis = cameraBasis([0, 0, 1]);
  const target: Vec3 = [1, 2, 3];
  const rect = { left: 0, top: 0, right: 100, bottom: 100 };
  const none = fitPointsInView(
    [],
    target,
    basis,
    5,
    500,
    { x: 50, y: 50 },
    rect,
  );
  assert.deepEqual(none, { distance: 5, target, moved: false });
  const flat = fitPointsInView(
    [[40, 0, 0]],
    target,
    basis,
    5,
    500,
    { x: 50, y: 50 },
    { left: 60, top: 0, right: 60, bottom: 100 },
  );
  assert.equal(flat.moved, false);
  const noFocal = fitPointsInView(
    [[40, 0, 0]],
    target,
    basis,
    5,
    0,
    { x: 50, y: 50 },
    rect,
  );
  assert.equal(noFocal.moved, false);
  // BASE_FOV is the one the engine frames with.
  assert.equal(BASE_FOV, 45);
});
