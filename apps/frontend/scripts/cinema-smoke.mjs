// Demo rehearsal check for `npm run dev:cinema`: drives the three demo
// scenarios (dev/cinema-scenarios.ts) through the cinema shell and saves a
// 1440x900 screenshot of each step. Start the server first:
//
//   CINEMA_PORT=58390 npm run dev:cinema
//   CINEMA_PORT=58390 CINEMA_SHOTS=<dir> node scripts/cinema-smoke.mjs
//
// CINEMA_ONLY=newcomer,veteran,public,switch   run a subset (default: all)
// CINEMA_GPU=0                                 no GPU flags (software WebGL)
//
// It switches worlds through /api/dev-cinema/session, so the server's current
// world is replaced. Real TESS stars are used when the server loaded them
// (GET /api/dev-cinema/state `placement`); otherwise the synthetic stars.
// Selectors are the shell's (.scene-canvas[data-scene-*], markers, the
// discovery dialog) and the classic analysis variant's accessible names.
import { chromium, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const port = Number(process.env.CINEMA_PORT ?? 58390);
const base = process.env.CINEMA_URL ?? `http://127.0.0.1:${port}`;
const shots =
  process.env.CINEMA_SHOTS ??
  fileURLToPath(
    new URL("../test-results/cinema-shots/scenarios/", import.meta.url),
  );
const only = new Set(
  (process.env.CINEMA_ONLY ?? "newcomer,veteran,public,switch").split(","),
);
mkdirSync(shots, { recursive: true });

const results = [];
const notes = [];
const step = async (name, run) => {
  const started = Date.now();
  try {
    await run();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error).split("\n")[0] });
    console.log(
      `FAIL ${name}\n     ${String(error).split("\n").slice(0, 6).join("\n     ")}`,
    );
  }
};

const browser = await chromium.launch({
  args:
    process.env.CINEMA_GPU === "0"
      ? []
      : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror ${String(error)}`));
page.on("console", (message) => {
  if (message.type() === "error")
    errors.push(`console ${message.text().slice(0, 200)}`);
});
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const api = async (path, init) => {
  const response = await page.request.fetch(`${base}/api${path}`, init);
  return {
    status: response.status(),
    body: await response.json().catch(() => null),
  };
};
const canvas = () => page.locator(".scene-canvas");
/** The scene is drawing, in `mode`, and not moving. */
const settle = async (mode, timeout = 30000) => {
  await expect(canvas()).toHaveAttribute("data-scene", "ready", { timeout });
  if (mode)
    await expect(canvas()).toHaveAttribute("data-scene-mode", mode, {
      timeout,
    });
  await expect(canvas()).toHaveAttribute("data-scene-busy", "false", {
    timeout,
  });
};
/** Frame rate over `ms` (requestAnimationFrame gaps). */
const frames = (ms = 3000) =>
  page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const times = [];
        const t0 = performance.now();
        const tick = (t) => {
          times.push(t);
          if (t - t0 < duration) return requestAnimationFrame(tick);
          const gaps = times
            .slice(1)
            .map((v, i) => v - times[i])
            .sort((a, b) => a - b);
          resolve({
            fps: Math.round(
              (times.length - 1) / ((times.at(-1) - times[0]) / 1000),
            ),
            p95: Math.round(gaps[Math.floor(gaps.length * 0.95)] * 10) / 10,
            max: Math.round(gaps.at(-1) * 10) / 10,
          });
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
const panel = () => page.getByRole("complementary", { name: "별 상세" });
const number = (text) => Number(String(text).replace(/,/g, ""));

/** Rank-1 peak, a window over its dip, 행성 같음, submit (classic variant). */
async function discover(tic) {
  const context = (await api(`/v1/stars/${tic}/analysis-context`)).body;
  const current = context.currentCurveContext;
  const query = new URLSearchParams({
    bundleId: current.bundleId,
    curveStep: String(current.curveStep),
    removed: current.removedCandidateIds.join(","),
  });
  const top = (await api(`/v1/stars/${tic}/candidate-peaks?${query}`)).body
    .peaks[0];
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click({ timeout: 30000 });
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
    { timeout: 30000 },
  );
  await page
    .getByRole("button", { name: "이 주기로 구간 선택", exact: true })
    .click();
  // Drag across the dip on the fold (default view: phase -0.5 .. 1.5).
  const center = top.suggestedPhaseCenter ?? 0;
  const half = Math.min(
    0.08,
    Math.max(0.01, (top.suggestedDurationHours ?? 2) / 24 / top.periodDays),
  );
  const box = await page.locator(".phase-draw-target").first().boundingBox();
  const x = (phase) => box.x + ((phase + 0.5) / 2) * box.width;
  const y = box.y + box.height / 2;
  await page.mouse.move(x(center - half), y);
  await page.mouse.down();
  await page.mouse.move(x(center), y, { steps: 6 });
  await page.mouse.move(x(center + half), y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("phase-selection-value")).toHaveAttribute(
    "data-valid",
    "true",
  );
  await shot("n05-analysis-window");
  await page
    .getByRole("button", { name: "구간 확정하고 판단하기", exact: true })
    .click();
  await page.getByRole("radio", { name: "행성 같음", exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
}

if (only.has("newcomer"))
  await step("newcomer: login, first visit, discovery, new star", async () => {
    await page.goto(`${base}/api/dev-cinema/session?as=newcomer&start=login`);
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    const state = (await api("/dev-cinema/state")).body;
    const tutorial = state.placement["0"]?.ticId ?? "900000001";
    const unlock = state.placement["5"]?.ticId ?? "900000006";
    notes.push(`newcomer: tutorial 1 ${tutorial}, next star ${unlock}`);
    await page.waitForTimeout(1200);
    await shot("n01-login");
    await page.getByRole("button", { name: /SSAFY 계정으로 로그인/ }).click();
    await expect(page).toHaveURL(/\/sky/, { timeout: 20000 });
    // First login: the story over the far galaxy; 시작하기 starts the fly-in.
    const start = page.locator(".cinema-story").getByRole("button", {
      name: "시작하기",
    });
    await expect(start).toBeVisible({ timeout: 20000 });
    await shot("n02-story");
    await start.click();
    await page.waitForTimeout(2400);
    await shot("n02-fly-in");
    // The first visit flies to tutorial 1 by itself.
    await expect(page).toHaveURL(new RegExp(`star=${tutorial}`), {
      timeout: 30000,
    });
    await expect(
      panel().getByRole("heading", { name: `TIC ${tutorial}` }),
    ).toBeVisible({ timeout: 20000 });
    await settle("system");
    await page.waitForTimeout(800);
    await shot("n03-first-visit-tutorial-1");
    await panel().getByRole("button", { name: "← 나의 은하" }).click();
    await settle("galaxy");
    await page.waitForTimeout(1200);
    const markers = await page
      .locator('.cinema-markers .galaxy-marker[data-visible="true"]')
      .count();
    if (markers !== 5) throw new Error(`${markers} tutorial markers`);
    await expect(page.getByTestId("sky-total")).toHaveText("5");
    await shot("n04-galaxy-tutorial-markers");
    await page.goto(`${base}/sky?star=${tutorial}`);
    await settle("system");
    await panel()
      .getByRole("link", { name: /분석 시작/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/analysis/${tutorial}`));
    await discover(tutorial);
    await page.waitForTimeout(4500);
    await shot("n06-transit");
    const card = page.locator("dialog.cinema-discovery[open]");
    await expect(card).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(600);
    await shot("n07-discovery");
    await card.getByRole("button", { name: "은하로 돌아가기" }).click();
    await expect(page.getByTestId("new-star-reticle")).toHaveAttribute(
      "data-tic-id",
      unlock,
      { timeout: 30000 },
    );
    await page.waitForTimeout(1000);
    await shot("n08-new-star");
    await expect(page.getByTestId("sky-total")).toHaveText("6");
    const me = (await api("/v1/me")).body;
    if (!me.onboardingDone) throw new Error("onboarding still pending");
    await page.goto(`${base}/sky?star=${unlock}`);
    await expect(
      panel().getByRole("heading", { name: `TIC ${unlock}` }),
    ).toBeVisible({ timeout: 20000 });
    await settle("system");
    await page.waitForTimeout(800);
    await shot("n09-new-star-panel");
  });

if (only.has("veteran"))
  for (const stars of [5000, 10000])
    await step(`veteran ${stars}: counts match, frame rate`, async () => {
      const started = Date.now();
      await page.goto(
        `${base}/api/dev-cinema/session?as=veteran&stars=${stars}`,
      );
      await expect(page.getByTestId("sky-total")).toHaveText(
        stars.toLocaleString("ko-KR"),
        { timeout: 60000 },
      );
      await expect(page.getByTestId("planet-total")).toBeVisible({
        timeout: 60000,
      });
      await settle("galaxy", 60000);
      const loaded = Date.now() - started;
      await page.waitForTimeout(1200);
      const rate = await frames();
      const summary = (await api("/v1/me")).body.achievementSummary;
      const planets = number(
        await page.getByTestId("planet-total").textContent(),
      );
      const found = summary.byType.confirmed + summary.byType.unconfirmed;
      notes.push(
        `veteran ${stars}: ready ${loaded} ms, ${JSON.stringify(rate)}, power ${await canvas().getAttribute("data-scene-power")}, planets ${planets}`,
      );
      if (planets !== found || summary.discoveredStarCount !== stars)
        throw new Error(
          `top bar ${stars}/${planets} vs /v1/me ${summary.discoveredStarCount}/${found}`,
        );
      await shot(`v01-veteran-${stars}`);
      const done = (
        await api(
          "/v1/me/stars?scope=discovered&sort=recent&size=20&stage=completed",
        )
      ).body.items.find((item) => item.planetCount > 0);
      if (done) {
        await page.goto(`${base}/sky?star=${done.ticId}`);
        await settle("system", 30000);
        await page.waitForTimeout(1000);
        notes.push(
          `veteran ${stars} system: ${JSON.stringify(await frames(2000))}`,
        );
        await shot(`v02-veteran-${stars}-system`);
      }
    });

if (only.has("public"))
  await step(
    "other explorers: community, profile, galaxies, home",
    async () => {
      await page.goto(`${base}/api/dev-cinema/session?as=member`);
      await settle("galaxy", 30000);
      const mine = await page.getByTestId("sky-total").textContent();
      await page.goto(`${base}/community`);
      const author = page.locator('a[href^="/members/u-"]').first();
      await expect(author).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(800);
      await shot("p01-community");
      await author.click();
      const visit = page.getByRole("link", { name: /은하 방문하기/ });
      await expect(visit).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(800);
      await shot("p02-profile");
      await visit.click();
      const view = page.locator(".cinema-public");
      await expect(view).toHaveAttribute("data-public-loaded", "true", {
        timeout: 30000,
      });
      await settle("galaxy", 30000);
      await page.waitForTimeout(1200);
      await shot("p03-public-from-profile");
      await page.getByRole("button", { name: /다른 탐사자/ }).click();
      await shot("p04-explorer-list");
      await page
        .locator("#cinema-explorer-list")
        .getByRole("link", { name: /은하수집가/ })
        .click();
      await expect(
        page.locator('.cinema-public[data-owner="u-303"]'),
      ).toHaveAttribute("data-public-loaded", "true", { timeout: 60000 });
      await settle("galaxy", 30000);
      await page.waitForTimeout(1200);
      notes.push(`public 10000: ${JSON.stringify(await frames())}`);
      await shot("p05-public-10000");
      const shared = (await api("/dev-cinema/state")).body.placement["0"]
        ?.ticId;
      const tic = shared ?? "900000001";
      await page.goto(`${base}/members/u-303/sky?star=${tic}`);
      await expect(
        page.getByRole("complementary", { name: /의 별$/ }),
      ).toBeVisible({ timeout: 20000 });
      await settle("system", 30000);
      await page.waitForTimeout(1000);
      if (
        await page.getByRole("link", { name: /분석 시작|이어서 분석/ }).count()
      )
        throw new Error("analysis action on another explorer's star");
      await shot("p06-public-star");
      await page.goto(`${base}/members/u-301/sky`);
      await expect(
        page.locator('.cinema-public[data-owner="u-301"]'),
      ).toHaveAttribute("data-public-loaded", "true", { timeout: 30000 });
      await settle("galaxy", 30000);
      await page.waitForTimeout(1200);
      await shot("p07-public-50");
      await page.goto(`${base}/members/u-211/sky`);
      await expect(
        page.locator('.cinema-public[data-owner="u-211"]'),
      ).toHaveAttribute("data-public-loaded", "true", { timeout: 30000 });
      await settle("galaxy", 30000);
      await page.waitForTimeout(1000);
      await shot("p08-public-1000");
      await page.goto(`${base}/members/u-210/sky`);
      await expect(page.locator(".cinema-public-error")).toBeVisible({
        timeout: 20000,
      });
      await shot("p09-public-private");
      await page.getByRole("button", { name: "← 나의 은하로" }).click();
      await expect(page).toHaveURL(/\/sky$/);
      await expect(page.getByTestId("sky-total")).toHaveText(mine, {
        timeout: 20000,
      });
      await settle("galaxy", 30000);
      await page.waitForTimeout(1200);
      await shot("p10-back-home");
    },
  );

if (only.has("switch"))
  await step("demo switch lists scenarios and switches", async () => {
    await page.goto(`${base}/sky`);
    await settle("galaxy", 30000);
    await page.locator(".dev-demo-tab").click();
    await expect(page.locator("#dev-demo-panel")).toBeVisible();
    await shot("s01-demo-switch");
    await page
      .locator("#dev-demo-panel")
      .getByRole("button", { name: /처음 온 탐사자/ })
      .click();
    await expect(page.getByTestId("sky-total")).toHaveText("5", {
      timeout: 20000,
    });
    await page.goto(`${base}/api/dev-cinema/session?as=member`);
  });

await browser.close();
const failed = results.filter((item) => !item.ok);
writeFileSync(
  join(shots, "report.json"),
  JSON.stringify({ results, notes, errors }, null, 2),
);
console.log(
  `\n${results.length - failed.length}/${results.length} passed · page errors ${errors.length} · shots ${shots}`,
);
for (const note of notes) console.log(`note ${note}`);
for (const error of errors.slice(0, 8)) console.log(error);
process.exit(failed.length ? 1 : 0);
