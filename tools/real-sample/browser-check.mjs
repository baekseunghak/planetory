// Browser check for the real sample: a real star opens in the analysis panel,
// its recommended peak gives a matched submission and the discovery sequence
// plays. Start the server first, then (from the repository root):
//   CINEMA_PORT=58434 npm --prefix apps/frontend run dev:cinema
//   CINEMA_PORT=58434 REAL_TIC=150428135 SHOTS=<folder> node tools/real-sample/browser-check.mjs
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../../apps/frontend/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");

const base = `http://127.0.0.1:${process.env.CINEMA_PORT ?? 58434}`;
const tic = process.env.REAL_TIC ?? "150428135";
const shots =
  process.env.SHOTS ??
  fileURLToPath(new URL("./.cache/shots/", import.meta.url));
await mkdir(shots, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror " + String(e)));
page.on("console", (m) => m.type() === "error" && errors.push("console " + m.text()));
const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};
let submission = null;
page.on("response", async (response) => {
  if (/\/v1\/stars\/\d+\/submissions$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST") {
    try {
      submission = { status: response.status(), body: await response.json() };
    } catch {}
  }
});
const shot = async (name) => {
  await page.screenshot({ path: join(shots, `${name}.png`) });
  note(`shot ${name}.png`);
};

try {
  await page.goto(`${base}/api/dev-cinema/session?as=member`);
  await page.waitForURL(/\/sky/, { timeout: 30000 });
  await page.goto(`${base}/sky?star=${tic}`);
  const panel = page.getByRole("complementary", { name: "별 상세" });
  await expect(panel).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(2500);
  note("panel text: " + (await panel.innerText()).replace(/\s+/g, " ").slice(0, 300));
  await shot("01-real-star-panel");
  await panel.getByRole("link", { name: /분석 시작/ }).click();
  await page.waitForURL(new RegExp(`/analysis/${tic}`), { timeout: 20000 });

  const peaks = await (
    await page.request.fetch(
      `${base}/api/v1/stars/${tic}/candidate-peaks?bundleId=9007199254742001&curveStep=0`,
    )
  ).json();
  const top = peaks.peaks[0];
  note(`rank1 peak: P=${top.periodDays} grid=${top.gridIndex} dur=${top.suggestedDurationHours} phase=${top.suggestedPhaseCenter}`);

  await page.getByRole("button", { name: "1위 봉우리 선택", exact: true }).click({ timeout: 30000 });
  await expect(page.getByTestId("fold-panel")).toHaveAttribute("data-fold-ready", "true", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await shot("02-real-analysis-peak");

  // Pan the fold so its centre sits on the peak's suggested dip phase.
  const chart = page.getByRole("group", { name: "접힌 곡선 그래프" });
  await chart.focus();
  const view = async () => {
    const s = Number(await chart.getAttribute("data-view-start"));
    const e = Number(await chart.getAttribute("data-view-end"));
    return { s, e, c: (s + e) / 2, w: e - s };
  };
  const dipHalf = top.suggestedDurationHours / 24 / top.periodDays / 2;
  for (let i = 0; i < 16 && (await view()).w > Math.max(0.004, dipHalf * 4); i++) await chart.press("+");
  const pick = (v) =>
    [top.suggestedPhaseCenter - 1, top.suggestedPhaseCenter, top.suggestedPhaseCenter + 1]
      .filter((x) => x > -0.5 && x < 1.5)
      .sort((a, b) => Math.abs(a - v.c) - Math.abs(b - v.c))[0];
  let v = await view();
  const target = pick(v);
  for (let i = 0; i < 400; i++) {
    v = await view();
    const before = v.c;
    if (Math.abs(v.c - target) < dipHalf) break;
    await chart.press(v.c < target ? "ArrowRight" : "ArrowLeft");
    const after = (await view()).c;
    if (Math.abs(after - target) >= Math.abs(before - target)) {
      // Overshot: step back and zoom in for a finer pan step.
      await chart.press(v.c < target ? "ArrowLeft" : "ArrowRight");
      await chart.press("+");
    }
  }
  v = await view();
  note(`fold view ${v.s.toFixed(4)}..${v.e.toFixed(4)} centre ${v.c.toFixed(4)} target ${target.toFixed(4)}`);
  await page.getByRole("button", { name: "이 주기로 구간 선택", exact: true }).click();
  const keyboard = page.locator(".phase-keyboard-details");
  if ((await keyboard.getAttribute("open")) === null) await keyboard.locator("summary").click();
  await page.getByRole("button", { name: "구간 선택 시작", exact: true }).click();
  const value = page.getByTestId("phase-selection-value");
  await expect(value).toHaveAttribute("data-valid", "true");
  const start = Number(await value.getAttribute("data-start"));
  const end = Number(await value.getAttribute("data-end"));
  note(`window ${start.toFixed(4)}..${end.toFixed(4)} (dip ${target.toFixed(4)} +- ${dipHalf.toFixed(4)})`);
  await shot("03-real-analysis-window");
  await page.getByRole("button", { name: "구간 확정하고 판단하기", exact: true }).click();
  await page.getByRole("radio", { name: "행성 같음", exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toBeVisible();
  await shot("04-real-review");
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  // Discovery: transit scene, then the discovery card.
  const canvas = page.locator(".scene-canvas[data-scene-mode]");
  const modes = [];
  let transitShot = false;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const mode = await canvas.first().getAttribute("data-scene-mode").catch(() => null);
    if (mode && modes[modes.length - 1] !== mode) modes.push(mode);
    if (mode === "transit" && !transitShot) {
      await page.waitForTimeout(3500);
      await shot("05-real-transit");
      transitShot = true;
    }
    if (await page.locator(".cinema-discovery").first().isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  note(`scene modes: ${modes.join(" -> ")}`);
  const card = page.locator(".cinema-discovery").first();
  if (await card.isVisible().catch(() => false)) {
    await page.waitForTimeout(1200);
    note("card text: " + (await card.innerText()).replace(/\s+/g, " ").slice(0, 400));
    await shot("06-real-discovery-card");
  } else note("discovery card NOT visible");
  if (submission) {
    const b = submission.body;
    note(`submission ${submission.status} match=${JSON.stringify(b.match ?? {}).slice(0, 200)}`);
    note(`signal.bls=${JSON.stringify(b.signal?.bls)} external=${JSON.stringify(b.signal?.external)}`);
  } else note("no submission response captured");
} catch (error) {
  note("FAIL " + String(error).split("\n").slice(0, 6).join(" | "));
  await shot("99-failure").catch(() => {});
} finally {
  note("errors: " + JSON.stringify(errors.slice(0, 8)));
  await writeFile(join(shots, `run-${tic}.log`), log.join("\n") + "\n");
  await browser.close();
}
