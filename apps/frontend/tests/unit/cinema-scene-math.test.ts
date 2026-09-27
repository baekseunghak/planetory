import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE_FOV,
  DEFAULT_VIEW,
  STAR_RADIUS,
  boundsFramePoints,
  cameraBasis,
  circleOverlapArea,
  densityBloom,
  densityScale,
  coveredFraction,
  fitDistance,
  focalPx,
  GHOST_FLOOR,
  ghostDisplayRadius,
  ghostOpacity,
  ghostRadius,
  ghostScale,
  limbWeight,
  orbitAngle,
  orbitSlotRadius,
  orbitSpeed,
  pickCircle,
  pickNearest,
  planetPalette,
  projectPoint,
  resolveInset,
  starHitRadius,
  starPointCss,
  starWorld,
  transitBrightness,
  transitCoverage,
  transitFlux,
  transitHalfAngle,
  transitPlanetRadius,
  transitTheta,
  isSoftwareRenderer,
  viewDirection,
  viewOffset,
  type Vec3,
} from "../../src/cinema/scene/math";
import { armAngle, decorativeStar } from "../../src/cinema/scene/procedural";
import { signalSeed } from "../../src/features/sky-renderer/personal-system";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (±${eps})`);

/** Column-major perspective * view for a camera at `eye` looking at `target`. */
function viewProjection(
  eye: Vec3,
  target: Vec3,
  fovDeg: number,
  aspect: number,
) {
  const f: Vec3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const len = Math.hypot(...f);
  const fwd = f.map((v) => v / len) as Vec3;
  const basis = cameraBasis([-fwd[0], -fwd[1], -fwd[2]]);
  const { right: r, up: u, back: b } = basis;
  const t = [
    -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
    -(b[0] * eye[0] + b[1] * eye[1] + b[2] * eye[2]),
  ];
  // view (row-major rows r,u,b) then projection
  const n = 0.01,
    fa = 1000,
    ft = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const P = [
    [ft / aspect, 0, 0, 0],
    [0, ft, 0, 0],
    [0, 0, (fa + n) / (n - fa), (2 * fa * n) / (n - fa)],
    [0, 0, -1, 0],
  ];
  const V = [
    [r[0], r[1], r[2], t[0]],
    [u[0], u[1], u[2], t[1]],
    [b[0], b[1], b[2], t[2]],
    [0, 0, 0, 1],
  ];
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += P[row][k] * V[k][col];
      out[col * 4 + row] = s;
    }
  return out;
}

test("world mapping keeps stored x/y/depthZ with render z = depthZ * 256", () => {
  assert.deepEqual(starWorld(100, -200, 0.5), [1, 1.28, -2]);
  const d = viewDirection(DEFAULT_VIEW.yaw, DEFAULT_VIEW.tilt);
  near(Math.hypot(...d), 1);
  // tilt 1 from face-on: the camera sits ~33 degrees above the galaxy plane
  near(Math.asin(d[1]), Math.PI / 2 - 1, 1e-12);
  near(Math.atan2(d[0], d[2]), DEFAULT_VIEW.yaw, 1e-12);
});

test("camera basis is orthonormal and roll turns the picture like rotateZ", () => {
  const back = viewDirection(0.12, 1);
  const plain = cameraBasis(back, 0);
  const rolled = cameraBasis(back, -0.28);
  for (const b of [plain, rolled]) {
    const dot = (x: Vec3, y: Vec3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    near(dot(b.right, b.up), 0, 1e-12);
    near(dot(b.right, b.back), 0, 1e-12);
    near(Math.hypot(...b.right), 1, 1e-12);
  }
  // unrolled right is horizontal; negative roll tips it down on the right
  near(plain.right[1], 0, 1e-12);
  assert.ok(rolled.right[1] < 0);
});

test("projectPoint maps the look target to the centre and hides points behind", () => {
  const m = viewProjection([0, 0, 10], [0, 0, 0], 45, 1440 / 900);
  const centre = projectPoint(m, 0, 0, 0, 1440, 900);
  near(centre.x, 720, 1e-6);
  near(centre.y, 450, 1e-6);
  near(centre.depth, 10, 1e-9);
  assert.equal(centre.visible, true);
  const up = projectPoint(m, 0, 1, 0, 1440, 900);
  assert.ok(up.y < 450, "world +Y is screen up");
  near(450 - up.y, focalPx(900, 45) / 10, 1e-6);
  const behind = projectPoint(m, 0, 0, 20, 1440, 900);
  assert.equal(behind.inFront, false);
  assert.equal(behind.visible, false);
});

test("view offset centres the target in the free area at the same pixel scale", () => {
  const w = 1440,
    h = 900;
  const plain = viewOffset(w, h, { right: 0, bottom: 0 });
  assert.equal(plain.shifted, false);
  near(plain.fov, BASE_FOV, 1e-9);
  const panel = viewOffset(w, h, { right: 0, bottom: 360 });
  // principal point sits at the centre of the area above the panel
  const principalY = panel.fullHeight / 2 - panel.offsetY;
  near(principalY, (h - 360) / 2, 1e-9);
  near(panel.aspect, panel.fullWidth / panel.fullHeight, 1e-12);
  // focal length over the full view equals the plain camera's
  const focalFull =
    panel.fullHeight / 2 / Math.tan((panel.fov * Math.PI) / 360);
  near(focalFull, focalPx(h), 1e-6);
  const side = viewOffset(w, h, { left: 440, right: 0, bottom: 0 });
  near(side.fullWidth / 2 - side.offsetX, 440 + (w - 440) / 2, 1e-9);
  assert.deepEqual(resolveInset({ right: 5000, bottom: -3 }, w, h), {
    top: 0,
    right: w - 80,
    bottom: 0,
    left: 0,
  });
});

test("fitDistance keeps every point inside the fill fraction", () => {
  const basis = cameraBasis([0, 0, 1]);
  const focal = focalPx(900);
  const d = fitDistance(
    [
      [2, 0, 0],
      [-2, 0, 0],
      [0, 1, 0],
    ],
    [0, 0, 0],
    basis,
    focal,
    1440,
    900,
    0.8,
  );
  near(d, (2 * focal) / (720 * 0.8), 1e-9);
  // a point toward the camera needs extra distance
  const deeper = fitDistance(
    [[2, 0, 1]],
    [0, 0, 0],
    basis,
    focal,
    1440,
    900,
    0.8,
  );
  near(deeper, 1 + (2 * focal) / (720 * 0.8), 1e-9);
  const ring = boundsFramePoints({
    minX: -1000,
    maxX: 1000,
    minY: -500,
    maxY: 500,
  });
  assert.equal(ring.length, 64);
  near(Math.max(...ring.map((p) => p[0])), 11.2, 1e-9);
});

test("overlap area: disjoint, contained and the two-unit-circle lens", () => {
  assert.equal(circleOverlapArea(1, 0.2, 1.3), 0);
  near(circleOverlapArea(1, 0.2, 0.5), Math.PI * 0.04, 1e-12);
  near(circleOverlapArea(1, 1, 1), (2 * Math.PI) / 3 - Math.sqrt(3) / 2, 1e-12);
  near(circleOverlapArea(0.3, 1, 0.1), Math.PI * 0.09, 1e-12);
  // coverage rises monotonically as the planet slides onto the disc
  let last = -1;
  for (let d = 1.3; d >= 0; d -= 0.01) {
    const c = transitCoverage(1, 0.2, d);
    assert.ok(c >= last - 1e-12, `coverage fell at d=${d}`);
    last = c;
  }
  near(last, 1, 1e-12);
  near(coveredFraction(1, 0.2, 0), 0.04, 1e-12);
});

test("transit flux matches the measured depth; the drawn dimming is exaggerated", () => {
  near(transitFlux(0.008, 1, 0), 0.992, 1e-12);
  near(transitFlux(0.008, 0, 0), 1, 1e-12);
  assert.ok(
    transitFlux(0.008, 1, 0.9) > transitFlux(0.008, 1, 0),
    "limb darkening",
  );
  near(limbWeight(1), 0.4, 1e-12);
  near(transitFlux(0.008, 0.5, 0), 0.996, 1e-12);
  assert.equal(transitBrightness(0), 1);
  near(transitBrightness(0.04), 1 - 0.28, 1e-12);
  near(transitBrightness(1), 0.45, 1e-12); // never dims past 55%
  const rp = transitPlanetRadius(0.008);
  assert.ok(rp > STAR_RADIUS * Math.sqrt(0.008), "exaggerated for visibility");
  assert.ok(rp <= STAR_RADIUS * 0.28);
  // the pass starts and ends with the planet off the disc
  const orbit = orbitSlotRadius(0),
    half = transitHalfAngle(orbit, STAR_RADIUS, rp);
  assert.ok(orbit * Math.sin(half) > STAR_RADIUS + rp);
});

test("ghost orbit radius scales with period^(2/3) relative to the system", () => {
  const empty = ghostScale([], orbitSlotRadius(0));
  near(ghostRadius(10, empty, 0, 99), orbitSlotRadius(0), 1e-12);
  near(ghostRadius(80, empty, 0, 99) / ghostRadius(10, empty, 0, 99), 4, 1e-9);
  // one known planet anchors the law exactly on its drawn orbit
  const anchored = ghostScale(
    [{ periodDays: 3.2, radius: orbitSlotRadius(0) }],
    orbitSlotRadius(1),
  );
  near(ghostRadius(3.2, anchored, 0, 99), orbitSlotRadius(0), 1e-12);
  // two planets: log-mean fit
  const two = ghostScale(
    [
      { periodDays: 2, radius: 1 },
      { periodDays: 16, radius: 2 },
    ],
    3,
  );
  near(
    two,
    Math.exp(
      (Math.log(1) -
        (2 / 3) * Math.log(2) +
        Math.log(2) -
        (2 / 3) * Math.log(16)) /
        2,
    ),
    1e-12,
  );
  // unknown periods do not anchor; clamps hold
  near(
    ghostScale([{ periodDays: null, radius: 5 }], orbitSlotRadius(1)),
    ghostScale([], orbitSlotRadius(1)),
    1e-12,
  );
  assert.equal(ghostRadius(0.001, empty, 0.05, 1), 0.05);
  assert.equal(ghostRadius(1e6, empty, 0.05, 1), 1);
  assert.equal(ghostRadius(Number.NaN, empty, 0.05, 1), 0.05);
});

test("ghost opacity lets only strong peaks glow", () => {
  near(ghostOpacity(0), 0.05, 1e-12);
  near(ghostOpacity(1), 0.9, 1e-12);
  assert.ok(ghostOpacity(0.5) < 0.11);
  assert.ok(ghostOpacity(0.95) > 0.7);
  assert.equal(ghostOpacity(Number.NaN), 0.05);
  assert.equal(ghostOpacity(3), 0.9);
});

test("pickNearest: nearest star within 14px, hidden and behind-camera skipped", () => {
  const m = viewProjection([0, 0, 10], [0, 0, 0], 45, 1440 / 900);
  const px = 1 / (focalPx(900) / 10); // world units per pixel at depth 10
  const positions = new Float32Array([
    0,
    0,
    0, // 0: centre
    5 * px,
    0,
    0, // 1: 5px right
    30 * px,
    0,
    0, // 2: 30px right
    0,
    0,
    12, // 3: behind the camera
  ]);
  const hit = pickNearest(positions, 4, m, 1440, 900, 724, 450, 14);
  assert.equal(hit?.index, 1);
  near(hit!.distance, 1, 1e-3);
  assert.equal(
    pickNearest(positions, 4, m, 1440, 900, 720, 450 + 20, 14),
    null,
  );
  const hidden = pickNearest(
    positions,
    4,
    m,
    1440,
    900,
    724,
    450,
    14,
    (i) => i === 1,
  );
  assert.equal(hidden?.index, 0);
  assert.equal(
    pickNearest(positions, 4, m, 1440, 900, 720, 450, 14, (i) => i < 3),
    null,
  );
  // equal distance: the star nearer the camera wins
  const tie = new Float32Array([2 * px, 0, 0, 2 * px * 0.5, 0, 5]);
  assert.equal(pickNearest(tie, 2, m, 1440, 900, 722, 450, 14)?.index, 1);
});

test("pickCircle picks planets by edge distance with padding", () => {
  const targets = [
    { x: 100, y: 100, radius: 20, depth: 5 },
    { x: 160, y: 100, radius: 6, depth: 4 },
  ];
  assert.equal(pickCircle(targets, 115, 100), 0);
  assert.equal(pickCircle(targets, 170, 100), 1);
  assert.equal(pickCircle(targets, 400, 400), -1);
});

test("star point size matches the shader and gives a usable hit radius", () => {
  const css = starPointCss(6.5, 836, 30, 30);
  near(css, 6.5 * 1.5, 1e-12);
  assert.ok(starPointCss(6.5, 836, 30, 1) > css, "grows when close");
  near(starPointCss(6.5, 836, 30, 1, 2.2) / css, Math.pow(2.2, 0.55), 1e-12);
  assert.equal(starHitRadius(4), 6);
});

test("dense galaxies shrink points at the overview and restore them up close", () => {
  assert.equal(densityScale(1000, 1), 1);
  assert.equal(densityScale(400, 1), 1);
  const dense = densityScale(100000, 1);
  near(dense, Math.pow(0.01, 0.16), 1e-12);
  assert.ok(densityScale(10000, 1) > dense);
  assert.ok(densityScale(100000, 2) > dense, "grows while approaching");
  assert.equal(densityScale(100000, 6), 1);
  assert.equal(densityScale(1e9, 1), 0.45);
  near(densityBloom(100000), Math.pow(0.01, 0.12), 1e-12);
  assert.equal(densityBloom(10), 1);
});

test("orbits follow personal-system.ts: slots, speed .32/sqrt(P), palettes by seed", () => {
  assert.ok(orbitSlotRadius(1) - orbitSlotRadius(0) > 0);
  near(orbitSlotRadius(1) / orbitSlotRadius(0), 265 / 180, 1e-12);
  near(orbitSpeed(4), 0.16, 1e-12);
  near(orbitSpeed(null), 0.32, 1e-12);
  near(orbitSpeed(0.1), 0.32 / Math.sqrt(0.4), 1e-12);
  near(orbitAngle(0, 0, 4, 10) - orbitAngle(0, 0, 4, 0), 1.6, 1e-12);
  assert.equal(planetPalette(0.69), "brown");
  assert.equal(planetPalette(0.16), "teal");
  assert.equal(planetPalette(0.5), "ocean");
  const seed = signalSeed("fixture-204-p-0");
  assert.ok(seed >= 0 && seed < 1);
});

test("decorative intro galaxy follows the personal-spiral-v1 arms", () => {
  near(armAngle(1, 0), Math.PI / 2, 1e-12);
  near(armAngle(0, 1200), 5.6, 1e-12);
  const anchors = [decorativeStar(12), decorativeStar(13)];
  for (const s of anchors) {
    assert.ok(Math.abs(s.depthZ) <= 1);
    assert.ok(Math.hypot(s.x, s.y) < 1500);
  }
});

test("software WebGL is recognised by its renderer name", () => {
  for (const name of [
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "llvmpipe (LLVM 15.0.7, 256 bits)",
    "Software Rasterizer",
    "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
  ])
    assert.equal(isSoftwareRenderer(name), true, name);
  for (const name of [
    "ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "Apple M2",
    "WebKit WebGL",
    "",
    null,
  ])
    assert.equal(isSoftwareRenderer(name), false, String(name));
});

test("ghost orbits clear the corona for short periods and keep Kepler order", () => {
  const k = ghostScale([], orbitSlotRadius(0));
  const max = orbitSlotRadius(4);
  const r = (p: number) => ghostDisplayRadius(p, k, GHOST_FLOOR, max);
  // Rank 3 (2.03 d) and rank 2 (4.47 d) of the sample sit inside the corona
  // on the plain Kepler radius; drawn, they clear it and stay apart.
  assert.ok(ghostRadius(2.03, k, 0, max) < GHOST_FLOOR);
  assert.ok(r(2.03) >= GHOST_FLOOR);
  assert.ok(r(4.47) > r(2.03) * 1.15, `${r(4.47)} vs ${r(2.03)}`);
  assert.ok(r(11.73) > r(4.47));
  // Well above the floor it is the Kepler radius (a known orbit lines up).
  near(r(10), orbitSlotRadius(0), orbitSlotRadius(0) * 0.02);
  assert.equal(r(1e6), max);
  assert.equal(r(Number.NaN), GHOST_FLOOR);
  assert.equal(r(-1), GHOST_FLOOR);
});

test("the transit pass runs the way the orbits turn", () => {
  const half = 0.4;
  near(transitTheta(half, 0), half);
  near(transitTheta(half, 1), -half);
  near(transitTheta(half, 0.5), 0);
  // right = up x back; the planet sits at back*cos(theta) + right*sin(theta).
  const back: Vec3 = [Math.sin(0.7), 0, Math.cos(0.7)];
  const right: Vec3 = [back[2], 0, -back[0]];
  const angle = (t: number) => {
    const th = transitTheta(half, t);
    const x = back[0] * Math.cos(th) + right[0] * Math.sin(th);
    const z = back[2] * Math.cos(th) + right[2] * Math.sin(th);
    return Math.atan2(z, x);
  };
  const a0 = angle(0.2),
    a1 = angle(0.8);
  // orbitAngle grows with time; so does the pass.
  assert.ok(orbitAngle(0, 0.5, 11.7, 10) > orbitAngle(0, 0.5, 11.7, 0));
  assert.ok(Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0)) > 0);
});
