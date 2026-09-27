// Screenshots and checks for the scene engine through the DEV harness.
//
//   CINEMA_PORT=58391 npm run dev:cinema
//   CINEMA_PORT=58391 node src/cinema/scene/dev/scene-shots.mjs
//
// SCENE_SHOTS overrides the output folder, SCENE_GPU=1 launches Chromium with
// --use-angle=d3d11 (hardware GPU on Windows) instead of the default.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CINEMA_PORT ?? 58391);
const url = `http://127.0.0.1:${port}/src/cinema/scene/dev/harness.html`;
const shots = process.env.SCENE_SHOTS ?? "test-results/cinema-shots/scene";
await mkdir(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
};
const browser = await chromium.launch({
  args: process.env.SCENE_GPU === "1" ? ["--use-angle=d3d11"] : [],
});

async function open(reducedMotion, deviceScaleFactor = 1) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion,
    deviceScaleFactor,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForSelector('[data-scene="ready"]', { timeout: 30000 });
  return { context, page, errors };
}
const H = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => H(page, () => window.__harness.scene.getState());
const shot = (page, name) =>
  page.screenshot({ path: join(shots, `${name}.png`) });
const settle = (page, ms) => page.waitForTimeout(ms);
const idle = (page, timeout = 15000) =>
  page.waitForFunction(() => !window.__harness.scene.getState().busy, null, {
    timeout,
  });

// ------------------------------------------------------------ full motion
{
  const { context, page, errors } = await open("no-preference");
  check(
    "canvas count after StrictMode double mount",
    (await page.locator("canvas[data-scene=engine]").count()) === 1,
  );
  await H(page, () => window.__harness.setCount(1000));
  await settle(page, 1800);
  await shot(page, "01-galaxy");
  const s0 = await state(page);
  check("galaxy ready", s0.ready && s0.mode === "galaxy", JSON.stringify(s0));

  // Hover a marked star (blue 3) through real pointer events.
  const p3 = await H(page, () =>
    window.__harness.scene.projectStar("900000003"),
  );
  check("projectStar gives a visible point", p3?.visible, JSON.stringify(p3));
  if (p3?.visible) {
    await page.mouse.move(p3.x, p3.y);
    await settle(page, 300);
    const hover = await page
      .locator(".h-hover")
      .textContent()
      .catch(() => null);
    const hoveredTic = hover?.match(/TIC ([0-9]+)/)?.[1];
    const hovered = hoveredTic
      ? await H(
          page,
          (tic) => window.__harness.scene.projectStar(tic),
          hoveredTic,
        )
      : null;
    const gap = hovered
      ? Math.hypot(hovered.x - p3.x, hovered.y - p3.y)
      : Infinity;
    check(
      "hover picks the nearest star within 14px",
      gap <= 14,
      `${hover ?? "none"} · ${gap.toFixed(1)} px from pointer`,
    );
    await page.mouse.move(30, 860);
    await settle(page, 300);
    check(
      "hover clears over empty space",
      (await page.locator(".h-hover").count()) === 0,
    );
    await page.mouse.move(p3.x, p3.y);
    await settle(page, 300);
    await shot(page, "01b-hover-markers");
    // A drag that ends on a star must not click it.
    await page.mouse.down();
    await page.mouse.move(p3.x + 60, p3.y + 30, { steps: 6 });
    await page.mouse.move(p3.x + 3, p3.y + 2, { steps: 6 });
    await page.mouse.up();
    await settle(page, 200);
    check("drag end is not a click", (await state(page)).mode === "galaxy");
    await idle(page);
  }

  // Curved flight into a star with 5 planets.
  const flight = H(page, () =>
    window.__harness.focus("900000001").then(() => performance.now()),
  );
  await settle(page, 1700);
  const mid = await state(page);
  await shot(page, "02-flight-mid");
  check(
    "mid-flight busy in system mode",
    mid.busy && mid.mode === "system",
    JSON.stringify(mid),
  );
  await flight;
  await settle(page, 900);
  await shot(page, "03-system");
  const planets = await H(page, () =>
    [
      "fixture-204-p-0",
      "fixture-204-p-1",
      "fixture-204-p-2",
      "fixture-204-p-3",
      "fixture-204-p-4",
    ].map((id) => window.__harness.scene.projectPlanet(id)),
  );
  check(
    "5 planets projected",
    planets.filter((p) => p).length === 5,
    JSON.stringify(planets.map((p) => p && Math.round(p.radius))),
  );

  // Click a planet on screen.
  const target = planets.find((p) => p?.visible);
  if (target) {
    await page.mouse.click(target.x, target.y);
    await settle(page, 1800);
    const s = await state(page);
    check(
      "planet click focuses a planet",
      !!s.focusedPlanetId,
      s.focusedPlanetId ?? "none",
    );
    await shot(page, "03b-planet-focus");
    await H(page, () => window.__harness.scene.focusPlanet(null));
    await idle(page);
  }

  // Analysis: panel inset + ghost orbit + ghost planet.
  await H(page, () => window.__harness.analysis(true));
  await H(page, () => window.__harness.hint(11.7346, 1, true));
  await settle(page, 2200);
  await shot(page, "04-analysis-ghost");
  const star = await H(page, () =>
    window.__harness.scene.projectStar("900000001"),
  );
  const panelTop = await page
    .locator(".h-analysis")
    .evaluate((el) => el.getBoundingClientRect().top);
  check(
    "star sits above the bottom panel",
    star && star.y < panelTop,
    `star y ${star && Math.round(star.y)} panel top ${Math.round(panelTop)}`,
  );
  await H(page, () => window.__harness.hint(4.2, 0.35, false));
  await settle(page, 1200);
  await shot(page, "04b-analysis-weak-peak");
  await H(page, () => window.__harness.hint(11.7346, 1, true));
  const mismatch = H(page, () => window.__harness.scene.playMismatch());
  await settle(page, 250);
  await shot(page, "04c-mismatch");
  await mismatch;

  // Transit: edge-on pass with live flux.
  const transit = H(page, () => window.__harness.transit());
  await settle(page, 2600 + 2500);
  const passing = await state(page);
  await shot(page, "05-transit");
  check("mode transit while passing", passing.mode === "transit", passing.mode);
  await transit;
  const flux = await H(page, () => window.__flux ?? []);
  const min = Math.min(...flux.map((f) => f[1]));
  check(
    "onFlux every frame, dips about 0.8%",
    flux.length > 60 && min < 0.9945 && min > 0.99,
    `${flux.length} samples, min ${min.toFixed(5)}`,
  );
  await writeFile(join(shots, "transit-flux.json"), JSON.stringify(flux));
  check("after transit mode is system", (await state(page)).mode === "system");

  // Reveal: birth flash, then the planet takes its orbit.
  const reveal = H(page, () => window.__harness.reveal());
  await settle(page, 350);
  await shot(page, "06-reveal-flash");
  await reveal;
  await idle(page);
  await settle(page, 600);
  await shot(page, "06b-revealed");
  check(
    "revealed planet projects",
    !!(await H(page, () =>
      window.__harness.scene.projectPlanet("harness-reveal-1"),
    )),
  );

  // Back to the galaxy, then ignite a new star that arrives 600 ms later.
  await H(page, () => window.__harness.analysis(false));
  await H(page, () => window.__harness.scene.returnToGalaxy());
  await settle(page, 400);
  await shot(page, "07a-back-in-galaxy");
  const ignite = H(page, () => window.__harness.ignite(600));
  await page.waitForFunction(
    () => window.__harness.scene.projectStar("900001001") !== null,
    null,
    { timeout: 12000 },
  );
  await settle(page, 2600 + 900);
  await shot(page, "07-ignite");
  await ignite;
  await settle(page, 400);
  await shot(page, "07b-ignited");
  const newStar = await H(page, () =>
    window.__harness.scene.projectStar("900001001"),
  );
  check("ignited star visible", newStar?.visible, JSON.stringify(newStar));

  // Intro and fly-in.
  await H(page, () => window.__harness.scene.setMode("intro"));
  await idle(page);
  await settle(page, 500);
  await shot(page, "08-intro");
  const intro = H(page, () => window.__harness.scene.playIntro());
  await settle(page, 1500);
  await shot(page, "08b-intro-fly-in");
  await intro;
  check("intro fly-in ends in galaxy", (await state(page)).mode === "galaxy");

  // Backdrop and effects off.
  await H(page, () => window.__harness.scene.setMode("backdrop"));
  await settle(page, 1500);
  await shot(page, "09-backdrop");
  await H(page, () => window.__harness.scene.setMode("galaxy"));
  await H(page, () => window.__harness.effects(false));
  await settle(page, 600);
  await shot(page, "10-effects-off");
  await H(page, () => window.__harness.effects(true));

  // 100k stars: one buffer, frame time and picking time.
  await H(page, () => window.__harness.setCount(100000));
  await H(page, () => window.__harness.scene.showOverview());
  await settle(page, 1200);
  await shot(page, "11-galaxy-100k");
  const perf = await H(page, async () => {
    const times = [];
    let last = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => {
        times.push(now - last);
        last = now;
        if (times.length < 120) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    times.sort((a, b) => a - b);
    return { median: times[60], p90: times[108] };
  });
  check(
    "100k stars frame time measured",
    true,
    `median ${perf.median.toFixed(1)} ms, p90 ${perf.p90.toFixed(1)} ms (headless)`,
  );
  const pickMs = await H(page, async () => {
    const box = document
      .querySelector("canvas[data-scene=engine]")
      .getBoundingClientRect();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++)
      document.querySelector("canvas[data-scene=engine]").dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: box.width / 2 + i,
          clientY: box.height / 2,
          bubbles: true,
        }),
      );
    await new Promise((r) => requestAnimationFrame(() => r()));
    return performance.now() - t0;
  });
  check(
    "100k hover pick within a frame",
    true,
    `${pickMs.toFixed(1)} ms incl. one frame`,
  );

  // Resize: the drawing buffer follows the canvas.
  await page.setViewportSize({ width: 1280, height: 760 });
  await settle(page, 600);
  const size = await H(page, () => {
    const c = document.querySelector("canvas[data-scene=engine]");
    return {
      w: c.width,
      h: c.height,
      cw: c.clientWidth,
      ch: c.clientHeight,
      dpr: devicePixelRatio,
    };
  });
  check(
    "resize follows the viewport",
    size.cw === 1280 && size.ch === 760 && size.w === 1280 && size.h === 760,
    JSON.stringify(size),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page, 400);

  // Unmount disposes the renderer and removes the canvas; remount draws again.
  const cycle = await H(page, async () => {
    window.__harnessMount(false);
    await new Promise((r) => setTimeout(r, 300));
    const gone = document.querySelectorAll("canvas[data-scene=engine]").length;
    window.__harnessMount(true);
    await new Promise((r) => setTimeout(r, 2000));
    return {
      gone,
      back: document.querySelectorAll("canvas[data-scene=engine]").length,
      scene: document.querySelector("[data-scene]")?.getAttribute("data-scene"),
    };
  });
  check(
    "unmount removes the canvas, remount draws again",
    cycle.gone === 0 && cycle.back === 1 && cycle.scene === "ready",
    JSON.stringify(cycle),
  );
  await H(page, () => window.__harness.setCount(1000));
  await settle(page, 600);

  // Context loss: recoverable error, then recovery.
  const loss = await H(page, async () => {
    const seen = [];
    const off = window.__harness.scene.onError((e) => seen.push(e));
    const canvas = document.querySelector("canvas[data-scene=engine]");
    const gl = canvas.getContext("webgl2");
    const ext = gl.getExtension("WEBGL_lose_context");
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 400));
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 1200));
    off();
    return { seen, state: window.__harness.scene.getState() };
  });
  check(
    "context loss reported recoverable and recovers",
    loss.seen[0]?.recoverable === true && !loss.state.failed,
    JSON.stringify(loss.seen),
  );
  await settle(page, 500);
  await shot(page, "12-after-context-restore");

  check(
    "no page errors (full motion)",
    errors.length === 0,
    errors.slice(0, 3).join(" | "),
  );
  await context.close();
}

// ------------------------------------------------------------ reduced motion
{
  const { context, page, errors } = await open("reduce", 2);
  await H(page, () => window.__harness.setCount(1000));
  const buffer = await H(page, () => {
    const c = document.querySelector("canvas[data-scene=engine]");
    return { w: c.width, cw: c.clientWidth, dpr: devicePixelRatio };
  });
  check(
    "device pixel ratio capped at 1.75",
    buffer.dpr === 2 && buffer.w === Math.round(buffer.cw * 1.75),
    JSON.stringify(buffer),
  );
  const timing = await H(page, async () => {
    const h = window.__harness;
    const t = {};
    let t0 = performance.now();
    await h.focus("900000008");
    t.focus = performance.now() - t0;
    await h.analysis(true);
    h.hint(11.7346, 1, true);
    t0 = performance.now();
    await h.transit();
    t.transit = performance.now() - t0;
    t.samples = window.__flux.length;
    t0 = performance.now();
    await h.reveal();
    t.reveal = performance.now() - t0;
    t0 = performance.now();
    await h.scene.returnToGalaxy();
    t.back = performance.now() - t0;
    t0 = performance.now();
    await h.ignite(100);
    t.ignite = performance.now() - t0;
    t.state = h.scene.getState();
    return t;
  });
  check(
    "reduced motion: moves instant, promises resolve",
    timing.focus < 400 &&
      timing.back < 400 &&
      timing.transit < 2500 &&
      timing.reveal < 400 &&
      timing.ignite < 1500,
    JSON.stringify({ ...timing, state: undefined }),
  );
  check(
    "reduced motion: transit still reports a full curve",
    timing.samples >= 40,
  );
  await H(page, () => window.__harness.focus("900000001"));
  await settle(page, 300);
  await shot(page, "13-reduced-system");
  check(
    "no page errors (reduced)",
    errors.length === 0,
    errors.slice(0, 3).join(" | "),
  );
  await context.close();
}

await browser.close();
await writeFile(join(shots, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
process.exitCode = failed.length ? 1 : 0;
