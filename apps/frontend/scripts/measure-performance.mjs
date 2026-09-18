import { chromium, firefox } from "@playwright/test";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const [
  label = "baseline",
  channel = "chrome",
  countText = "100000",
  widthText = "1440",
  dprText = "1",
] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label))
  throw Error("Use a new lowercase result label");
const count = Number(countText),
  width = Number(widthText),
  dpr = Number(dprText);
const folder = `performance-results/${label}-${channel}-${count}-${width}-dpr${dpr}`;
await mkdir(folder, { recursive: false }); // Do not overwrite earlier measurements.
const bundleHash = createHash("sha256");
for (const path of (await readdir("benchmark-dist/assets")).sort()) {
  bundleHash
    .update(path)
    .update(await readFile(`benchmark-dist/assets/${path}`));
}
const browser = await (channel === "firefox" ? firefox : chromium).launch({
  headless: false,
  channel: channel === "firefox" ? "moz-firefox" : channel,
});
const context = await browser.newContext({
  viewport: { width, height: 900 },
  deviceScaleFactor: dpr,
});
const page = await context.newPage(),
  origin = "http://127.0.0.1:58360";
const result = {
  label,
  bundleSha256: bundleHash.digest("hex"),
  channel,
  count,
  width,
  dpr,
  date: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim(),
  browserVersion: browser.version(),
  errors: [],
  requests: [],
  heap: [],
  scenarios: [],
};
page.on("pageerror", (e) => result.errors.push(e.message));
page.on("response", async (r) => {
  if (!r.url().includes("/sky/tiles?")) return;
  try {
    const b = await r.json();
    result.requests.push({
      url: r.url(),
      status: r.status(),
      count: b.stars?.length,
      rangeStarCount: b.rangeStarCount,
      nextCursor: b.nextCursor,
      version: b.version,
    });
  } catch {
    /* An aborted body is recorded as incomplete, never accepted as a complete range. */
  }
});
let cdp,
  sampling = false;
if (channel !== "firefox") cdp = await context.newCDPSession(page);
const timer = setInterval(async () => {
  if (!cdp || sampling) return;
  sampling = true;
  try {
    result.heap.push({
      at: Date.now(),
      ...(await cdp.send("Runtime.getHeapUsage")),
    });
  } catch {
  } finally {
    sampling = false;
  }
}, 500);
const info = () =>
  page.evaluate(() => ({
    ...window.__planetoryBenchmark.info(),
    visibility: document.visibilityState,
  }));
const settle = async () => {
  await page.waitForFunction(
    () => window.__planetoryBenchmark?.settled(),
    undefined,
    {
      timeout: 180000,
    },
  );
  await page.waitForTimeout(800); // Exclude focus animation/initial layout from steady-state windows.
};
async function measure(name, action, cadence = 40) {
  await page.bringToFront();
  await settle();
  const before = await info();
  await page.evaluate(() => window.__planetoryBenchmark.begin());
  const until = Date.now() + 5000;
  let i = 0;
  while (Date.now() < until) {
    if (action) await action(i++);
    await page.waitForTimeout(cadence);
  }
  const value = await page.evaluate(() => window.__planetoryBenchmark.end());
  if (before.visibility !== "visible")
    value.invalid.push("document was hidden at start");
  result.scenarios.push({ name, before, ...value });
  const f = [...value.frames].sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      name,
      n: f.length,
      p95: f[Math.ceil(f.length * 0.95) - 1],
      worst: f.at(-1),
      pending: value.pendingFrames,
      loaded: value.after.loaded,
      stars: value.after.metrics?.stars,
    }),
  );
}
try {
  const reset = await context.request.post(
    `${origin}/api/dev-galaxy-204/reset?count=${count}`,
  );
  assert.equal(reset.status(), 200);
  result.dataset = await (
    await context.request.get(`${origin}/api/dev-galaxy-204/manifest`)
  ).json();
  assert.equal(result.dataset.stars, count);
  if (count === 100000) assert.equal(result.dataset.planets, 5000);
  await page.bringToFront();
  await page.goto(origin + "/sky");
  await settle();
  const canvas = page.getByRole("listbox", {
    name: "내가 발견한 개별 별로 이루어진 3D 은하 지도",
  });
  await canvas.focus();
  await page.keyboard.press("Home");
  await settle();
  result.initial = await info();
  assert.equal(result.initial.loaded, count);
  assert.equal(result.initial.metrics.stars, count);
  assert.equal(result.initial.metrics.planets, 0);
  await measure("overview-idle");
  await canvas.scrollIntoViewIfNeeded();
  const initialBox = await canvas.boundingBox();
  await page.mouse.move(
    initialBox.x + initialBox.width * 0.4,
    Math.min(850, initialBox.y + initialBox.height * 0.5),
  );
  for (let i = 0; i < 16; i++) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(50);
  }
  await settle();
  assert.equal((await info()).camera.zoom, 0.001);
  await measure("maximum-zoom-out");
  await page.keyboard.press("Home");
  await measure("pan-keyboard", (i) =>
    page.keyboard.press(i % 12 < 6 ? "ArrowRight" : "ArrowLeft"),
  );
  await measure("rotate-keyboard", (i) =>
    page.keyboard.press(i % 12 < 6 ? "Shift+ArrowRight" : "Shift+ArrowLeft"),
  );
  const box = await canvas.boundingBox();
  for (const pan of [true, false]) {
    await page.keyboard.press("Home");
    await settle();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    if (pan) await page.keyboard.down("Shift");
    await page.mouse.down();
    await measure(
      pan ? "pan-drag" : "rotate-drag",
      (i) =>
        page.mouse.move(
          box.x + box.width * 0.5 + Math.sin(i * 0.07) * 110,
          box.y + box.height * 0.5 + Math.sin(i * 0.05) * 20,
        ),
      8,
    );
    await page.mouse.up();
    if (pan) await page.keyboard.up("Shift");
  }
  await measure("hover", (i) =>
    page.mouse.move(
      box.x + box.width * (0.3 + (i % 20) / 50),
      box.y + box.height * 0.5,
    ),
  );
  await page.screenshot({ path: folder + "/overview.png" });
  await page.keyboard.press("Home");
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await measure("zoom-loading", (i) =>
    page.mouse.wheel(0, i % 12 < 6 ? -50 : 50),
  );
  await measure("zoom-warm", (i) => page.mouse.wheel(0, i % 12 < 6 ? -50 : 50));
  const ordinals = count === 1 ? [0] : [0, 1, 3, 2];
  for (const ordinal of ordinals) {
    const tic = String(900000001 + ordinal);
    await page.goto(`${origin}/sky?star=${tic}`);
    await settle();
    await page
      .getByRole("heading", { name: `TIC ${tic}`, exact: true })
      .waitFor();
    await page.waitForTimeout(1000);
    const detail = await info();
    const expected =
      ordinal === 0 ? 0 : ordinal === 1 ? 1 : ordinal === 2 ? 32 : 5;
    assert.equal(detail.metrics.planets, expected);
    await measure(`selected-${expected}`);
  }
  await canvas.focus();
  await measure("near-pan", (i) =>
    page.keyboard.press(i % 12 < 6 ? "ArrowRight" : "ArrowLeft"),
  );
  const nearBox = await canvas.boundingBox();
  const nearY = Math.min(850, nearBox.y + nearBox.height * 0.6);
  for (const name of ["near-drag", "near-drag-warm"]) {
    await page.mouse.move(nearBox.x + nearBox.width * 0.7, nearY);
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await measure(
      name,
      (i) =>
        page.mouse.move(
          nearBox.x + nearBox.width * 0.7 + Math.sin(i * 0.07) * 75,
          nearY,
        ),
      8,
    );
    // Return to the same camera through the real drag handler, outside the
    // measurement window; replay after all newly visited tiles have loaded.
    await page.mouse.move(nearBox.x + nearBox.width * 0.7, nearY);
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await settle();
  }
  await page.screenshot({ path: folder + "/selected.png" });
  // GPU timing is a separate window; no timer queries run inside acceptance windows.
  await page.evaluate(() => window.__planetoryBenchmark.beginGpu());
  await page.waitForTimeout(3000);
  result.gpu = await page.evaluate(() => window.__planetoryBenchmark.endGpu());
  // A profile is separate from acceptance frame windows because sampling has overhead.
  if (cdp && count === 100000) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    for (let i = 0; i < 40; i++)
      await page.keyboard.press(i % 8 < 4 ? "ArrowRight" : "ArrowLeft");
    const { profile } = await cdp.send("Profiler.stop");
    await writeFile(folder + "/pan.cpuprofile", JSON.stringify(profile));
  }
  result.final = await info();
  assert.deepEqual(result.errors, []);
} catch (e) {
  result.failure = String(e);
  console.error(e);
  await page.screenshot({ path: folder + "/failure.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  await writeFile(folder + "/raw.json", JSON.stringify(result, null, 2));
  await browser.close();
}
const summary = {
  ...result,
  heap: undefined,
  requests: undefined,
  peakHeapMB: result.heap.length
    ? Math.max(...result.heap.map((h) => h.usedSize)) / 1e6
    : null,
  scenarios: result.scenarios.map((s) => {
    const f = [...s.frames].sort((a, b) => a - b);
    const byName = Object.fromEntries(
      ["draw-submit", "pack-scene", "hit"].map((name) => {
        const values = s.cpu.filter((x) => x.name === name),
          times = values.map((x) => x.ms).sort((a, b) => a - b);
        return [
          name,
          {
            samples: times.length,
            p95: times[Math.ceil(times.length * 0.95) - 1] ?? null,
            max: times.at(-1) ?? null,
            maxCandidates: Math.max(0, ...values.map((x) => x.count ?? 0)),
          },
        ];
      }),
    );
    const p95 = f[Math.ceil(f.length * 0.95) - 1] ?? null,
      worst = f.at(-1) ?? null;
    return {
      name: s.name,
      frames: f.length,
      p95,
      worst,
      cpu: byName,
      pendingFrames: s.pendingFrames,
      invalid: s.invalid,
      eligible: s.pendingFrames === 0 && s.invalid.length === 0,
      framePass: p95 !== null && p95 <= 16.7 + 1e-6 && worst <= 33 + 1e-6,
      before: s.before,
      after: s.after,
    };
  }),
};
await writeFile(folder + "/summary.json", JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify({
    folder,
    peakHeapMB: summary.peakHeapMB,
    failure: result.failure,
  }),
);
