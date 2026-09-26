// Smoke check for `npm run dev:cinema`. Drives whatever UI the server serves
// through the core flow and saves screenshots. Start the server first:
//
//   CINEMA_PORT=58390 npm run dev:cinema
//   CINEMA_PORT=58390 CINEMA_SHOTS=<dir> node scripts/cinema-smoke.mjs
//
// Selectors are the classic UI's accessible names. Builders who replace a
// screen should copy this file and swap the selectors for their own.
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const port = Number(process.env.CINEMA_PORT ?? 58390);
const base = process.env.CINEMA_URL ?? `http://127.0.0.1:${port}`;
const shots =
  process.env.CINEMA_SHOTS ??
  fileURLToPath(
    new URL("../test-results/cinema-shots/smoke/", import.meta.url),
  );
await mkdir(shots, { recursive: true });

const results = [];
const step = async (name, run) => {
  const started = Date.now();
  try {
    await run();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error).split("\n")[0] });
    console.log(
      `FAIL ${name}\n     ${String(error).split("\n").slice(0, 4).join("\n     ")}`,
    );
  }
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const api = async (path, init) => {
  const response = await page.request.fetch(`${base}/api${path}`, init);
  return {
    status: response.status(),
    body: await response.json().catch(() => null),
  };
};

await api("/dev-cinema/reset", { method: "POST" });

await step("anonymous visitor sees the login page", async () => {
  await page.goto(`${base}/api/dev-cinema/session?as=anonymous`);
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다" }),
  ).toBeVisible();
  await shot("01-login");
});

await step("login returns a member to the sky", async () => {
  await page.getByRole("button", { name: /SSAFY 계정으로 로그인/ }).click();
  await expect(page).toHaveURL(/\/sky/, { timeout: 15000 });
  const canvas = page.locator(".galaxy-scene canvas");
  await expect(canvas).toBeVisible({ timeout: 15000 });
  await expect
    .poll(
      async () => Number(await canvas.getAttribute("data-rendered-stars")),
      {
        timeout: 15000,
      },
    )
    .toBeGreaterThan(0);
  await expect(page.locator('.galaxy-marker[data-marker="3"]')).toBeVisible();
  await expect(page.locator('.galaxy-marker[data-marker="!"]')).toBeVisible();
  await shot("02-sky");
});

const panel = () => page.getByRole("complementary", { name: "별 상세" });

await step("a star with a confirmed planet and a candidate", async () => {
  await page.goto(`${base}/sky?star=900000008`);
  await expect(
    panel().getByRole("heading", { name: "TIC 900000008" }),
  ).toBeVisible();
  await expect(panel()).toContainText("내 행성 2개");
  await expect(
    panel().getByRole("link", { name: /이어서 분석/ }),
  ).toBeVisible();
  await panel().getByRole("button", { name: "행성 1 fixture-204-p-0" }).click();
  await expect(panel()).toContainText("확인된 행성");
  await panel().getByRole("button", { name: "NASA 행성 자료 보기" }).click();
  await expect(panel()).toContainText("TIC 900000008 b");
  await shot("03-star-planets");
  await panel().getByRole("button", { name: "행성 2 fixture-204-p-1" }).click();
  await expect(panel()).toContainText("아직 확인되지 않은 후보");
});

await step("tutorial marker opens a star with 분석 시작", async () => {
  await page.goto(`${base}/sky`);
  await page.locator('.galaxy-marker[data-marker="3"]').click();
  await expect(
    panel().getByRole("heading", { name: "TIC 900000003" }),
  ).toBeVisible();
  await expect(panel().getByRole("link", { name: /분석 시작/ })).toBeVisible();
  await shot("04-star-unexplored");
});

async function reachJudgment(tic, overDip) {
  await page.goto(`${base}/analysis/${tic}?returnTo=%2Fsky%3Fstar%3D${tic}`);
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
    {
      timeout: 20000,
    },
  );
  if (overDip) {
    // The dip sits on phase 0/1. Zoom the fold, pan to phase 1, then start
    // the window there. At the default view the keyboard window lands on 0.5.
    const chart = page.getByRole("group", { name: "접힌 곡선 그래프" });
    await chart.focus();
    await chart.press("+");
    for (let i = 0; i < 24; i++) await chart.press("ArrowRight");
  }
  await page
    .getByRole("button", { name: "이 주기로 구간 선택", exact: true })
    .click();
  const keyboard = page.locator(".phase-keyboard-details");
  if ((await keyboard.getAttribute("open")) === null)
    await keyboard.locator("summary").click();
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
  const value = page.getByTestId("phase-selection-value");
  await expect(value).toHaveAttribute("data-valid", "true");
  const start = Number(await value.getAttribute("data-start"));
  const end = Number(await value.getAttribute("data-end"));
  await page
    .getByRole("button", { name: "구간 확정하고 판단하기", exact: true })
    .click();
  return { start, end };
}
async function submit(judgment) {
  await page.getByRole("radio", { name: judgment, exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toBeVisible();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  const result = page.getByTestId("submission-result");
  await expect(result).toBeVisible({ timeout: 15000 });
  await expect(result.getByRole("heading").first()).toHaveText(
    "접수되었습니다",
  );
  return result;
}

await step("matched + correct judgment unlocks a new star", async () => {
  const before = await api("/v1/me/sky");
  const window = await reachJudgment("900000010", true);
  if (!(window.end >= 1 - 0.01 || window.start <= 0.01))
    throw new Error(`window missed the dip: ${JSON.stringify(window)}`);
  await shot("05-analysis-judgment");
  const result = await submit("행성 같음");
  await expect(result).toContainText("고른 주기가 신호와 맞았습니다.");
  await expect(result).toContainText("성과로 인정되었습니다.");
  const expected = String(900000001 + before.body.starCount);
  await expect(result).toContainText(`새로 열린 별 1개 · TIC ${expected}`);
  await shot("06-result-matched");
  const after = await api("/v1/me/sky");
  if (after.body.starCount !== before.body.starCount + 1)
    throw new Error(
      `starCount ${before.body.starCount} -> ${after.body.starCount}`,
    );
  if (after.body.version === before.body.version)
    throw new Error("sky version unchanged");
  const detail = await api("/v1/me/stars/900000010");
  const ids = detail.body.planets.items.map((item) => item.candidateId);
  if (!ids.includes("9007199254741101")) throw new Error(`planets ${ids}`);
  const unlocked = await api(`/v1/me/stars/${expected}`);
  if (unlocked.status !== 200)
    throw new Error(`unlocked star ${unlocked.status}`);
});

await step("window away from the dip is a numeric mismatch", async () => {
  const window = await reachJudgment("900000011", false);
  if (window.start < 0.1 || window.end > 0.9)
    throw new Error(`expected a window near 0.5: ${JSON.stringify(window)}`);
  const result = await submit("행성 같음");
  await expect(result).toContainText("맞는 신호를 찾지 못했습니다.");
  await shot("07-result-not-matched");
});

await step("matched + wrong judgment is a judgment mismatch", async () => {
  await reachJudgment("900000012", true);
  const result = await submit("아닌 것 같음");
  await expect(result).toContainText("고른 주기가 신호와 맞았습니다.");
  await expect(result).toContainText("판단이 달라 성과로 인정되지 않았습니다.");
  await shot("08-result-judgment-mismatch");
});

await step("the sky shows the unlocked star and the new planet", async () => {
  await page.goto(`${base}/sky?star=900000010`);
  await expect(
    panel().getByRole("heading", { name: "TIC 900000010" }),
  ).toBeVisible();
  await expect(panel()).toContainText("내 행성 1개");
  await expect(
    panel().getByRole("link", { name: /이어서 분석/ }),
  ).toBeVisible();
  const state = await api("/dev-cinema/state");
  await expect(page.getByTestId("sky-total")).toHaveText(
    state.body.starCount.toLocaleString(),
  );
  await shot("09-sky-after");
});

await step("community and my page still load", async () => {
  await page.goto(`${base}/community`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto(`${base}/me`);
  await expect(page.getByText("탐사자214").first()).toBeVisible();
  await shot("10-me");
});

await step("logout returns to the login page", async () => {
  await page.goto(`${base}/sky`);
  await page
    .getByRole("button", { name: "로그아웃", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  const me = await api("/v1/me");
  if (me.status !== 401) throw new Error(`/v1/me after logout: ${me.status}`);
  await page.goto(`${base}/api/dev-cinema/session?as=member`);
});

await browser.close();
const failed = results.filter((item) => !item.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed · page errors ${errors.length} · shots ${shots}`,
);
for (const error of errors.slice(0, 5)) console.log(`page error: ${error}`);
process.exit(failed.length ? 1 : 0);
