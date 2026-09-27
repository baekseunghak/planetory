// Screenshots and bridge checks for the classic analysis panel (variant A),
// through the dev harness. Adapted from scripts/cinema-smoke.mjs.
//
//   CINEMA_PORT=58393 npm run dev:cinema
//   CINEMA_PORT=58393 CINEMA_SHOTS=<dir> node src/cinema/analysis-classic/dev-harness/classic-shots.mjs
//
// Optional CINEMA_PATH points at the real route once the shell is wired, e.g.
// CINEMA_PATH=/analysis/{tic}?returnTo=%2Fsky (then the stand-in scene checks
// are skipped).
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CINEMA_PORT ?? 58393);
const base = `http://127.0.0.1:${port}`;
const shots = process.env.CINEMA_SHOTS ?? "test-results/cinema-shots/classic";
const route =
  process.env.CINEMA_PATH ??
  "/src/cinema/analysis-classic/dev-harness/index.html?tic={tic}";
const harness = !process.env.CINEMA_PATH;
await mkdir(shots, { recursive: true });

const results = [];
const logs = {};
const step = async (name, run) => {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error).split("\n")[0] });
    console.log(
      `FAIL ${name}\n     ${String(error).split("\n").slice(0, 5).join("\n     ")}`,
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
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const bridge = () => page.evaluate(() => window.__classicBridgeLog ?? []);
const sceneCalls = () =>
  page.evaluate(() => window.__classicScene?.calls ?? []);
const last = async (type) =>
  (await bridge()).filter((entry) => entry.type === type).at(-1)?.payload;
const panel = () => page.locator(".pc-classic-analysis");
/** Screenshots show the panel from its top, as a member first sees it. */
const top = () => panel().evaluate((element) => (element.scrollTop = 0));

await page.request.fetch(`${base}/api/dev-cinema/reset`, { method: "POST" });

async function open(tic) {
  await page.goto(`${base}${route.replace("{tic}", tic)}`);
  await expect(
    page.getByRole("button", { name: "1위 봉우리 선택", exact: true }),
  ).toBeVisible({ timeout: 20000 });
}
async function pickPeak() {
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
    { timeout: 20000 },
  );
}
async function chooseWindow(overDip) {
  if (overDip) {
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
  // Fold the keyboard helper away again, as a member would after using it.
  await keyboard.locator("summary").click();
  return {
    start: Number(await value.getAttribute("data-start")),
    end: Number(await value.getAttribute("data-end")),
  };
}
async function judge(judgment) {
  await page
    .getByRole("button", { name: "구간 확정하고 판단하기", exact: true })
    .click();
  await page.getByRole("radio", { name: judgment, exact: true }).check();
}
async function submit() {
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
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

await step("panel sits in the bottom 60% and reports its inset", async () => {
  await open("900000010");
  await expect(panel()).toBeVisible();
  const box = await panel().boundingBox();
  assert(box.height <= 900 * 0.6 + 1, `panel height ${box.height}`);
  assert(box.y >= 900 * 0.4 - 1, `panel top ${box.y}`);
  assert(
    Math.round(box.y + box.height) === 900,
    `panel bottom ${box.y + box.height}`,
  );
  const session = await last("sessionChanged");
  assert(session?.ticId === "900000010" && session.active, "sessionChanged");
  if (harness) {
    const inset = (await sceneCalls())
      .filter((call) => call.method === "setViewInset")
      .at(-1)?.args;
    assert(
      Math.abs(inset.bottom - box.height) <= 1,
      `inset ${JSON.stringify(inset)}`,
    );
  }
});

await step("stage 1 · period from the rank-1 peak", async () => {
  await pickPeak();
  const period = await last("periodChanged");
  assert(period?.operation === "reselect", `operation ${period?.operation}`);
  assert(
    period.sourcePeakGridIndex === 3600,
    `peak ${period.sourcePeakGridIndex}`,
  );
  assert(
    Math.abs(period.periodDays - 11.7346) < 0.01,
    `period ${period.periodDays}`,
  );
  assert(period.strength > 0.95, `strength ${period.strength}`);
  assert((await last("stageChanged"))?.stage === 1, "stage 1");
  await page.waitForTimeout(150);
  await top();
  await shot("01-period");
});

await step(
  "stage 1 · fine-tune and an off-peak pick change the strength",
  async () => {
    const peak = (await last("periodChanged")).strength;
    const slider = page.getByRole("slider", { name: "반복 주기 미세 조정" });
    await slider.focus();
    await slider.press("End");
    await expect
      .poll(async () => (await last("periodChanged"))?.operation)
      .toBe("fine-tune");
    const tuned = await last("periodChanged");
    assert(tuned.strength < peak, `fine-tune strength ${tuned.strength}`);
    // Direct pick: click the periodogram at 10% of its width (about 0.77 d,
    // far from every peak; the view centre would land on the rank-2 peak).
    const plot = page.getByRole("group", { name: "주기도 그래프" });
    await plot.scrollIntoViewIfNeeded();
    const box = await plot.boundingBox();
    await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.5);
    await expect
      .poll(async () => (await last("periodChanged"))?.sourcePeakGridIndex)
      .toBe(null);
    const direct = await last("periodChanged");
    assert(direct.strength < 0.5, `off-peak strength ${direct.strength}`);
    await expect(page.getByTestId("fold-panel")).toHaveAttribute(
      "data-fold-ready",
      "true",
      { timeout: 20000 },
    );
    await top();
    await page.waitForTimeout(150);
    await shot("01b-period-off-peak");
    logs.fineTune = tuned;
    logs.offPeak = direct;
    await pickPeak();
    assert((await last("periodChanged")).strength > 0.95, "back on the peak");
  },
);

await step("stage 2 · window over the dip", async () => {
  const window = await chooseWindow(true);
  assert(
    window.end >= 0.99 || window.start <= 0.01,
    `window ${JSON.stringify(window)}`,
  );
  const selection = (await last("selectionChanged"))?.selection;
  assert(selection && !selection.confirmed, "selection not confirmed yet");
  assert(Math.abs(selection.startPhase - window.start) < 1e-9, "startPhase");
  assert((await last("stageChanged"))?.stage === 2, "stage 2");
  await page.waitForTimeout(150);
  await top();
  await shot("02-window");
});

await step("stage 3 · judgment", async () => {
  await judge("행성 같음");
  const selection = (await last("selectionChanged"))?.selection;
  assert(selection?.confirmed === true, "selection confirmed");
  assert((await last("stageChanged"))?.stage === 3, "stage 3");
  await top();
  await shot("03-judgment");
});

await step("result · matched, planet and a new star", async () => {
  const result = await submit();
  await expect(result).toContainText("성과로 인정되었습니다.");
  await expect.poll(async () => (await last("outcome"))?.kind).toBe("matched");
  const outcome = await last("outcome");
  const submitted = await last("submitted");
  assert(
    submitted?.kind === "candidate",
    `submitted ${JSON.stringify(submitted)}`,
  );
  assert(outcome.firstView === true, "firstView");
  assert(
    outcome.userJudgment === "LIKELY_PLANET",
    `judgment ${outcome.userJudgment}`,
  );
  assert(outcome.revealsPlanet === true, "revealsPlanet");
  assert(outcome.planet?.candidateId, "planet");
  assert(outcome.achievement.unlockedTicIds.length === 1, "unlocked");
  logs.matched = outcome;
  if (harness) {
    const methods = (await sceneCalls()).map((call) => call.method);
    for (const method of ["playTransit", "revealPlanet", "ignite"])
      assert(methods.includes(method), `scene ${method}`);
  }
  await page.waitForTimeout(200);
  await shot("04-result-matched");
  const box = await page
    .locator("dialog.submission-dialog[open]")
    .boundingBox();
  assert(box.y >= 900 * 0.4 - 1, `dialog top ${box.y}`);
});

await step("result · numeric mismatch", async () => {
  await open("900000011");
  await pickPeak();
  await chooseWindow(false);
  await judge("행성 같음");
  const result = await submit();
  await expect(result).toContainText("맞는 신호를 찾지 못했습니다.");
  await expect
    .poll(async () => (await last("outcome"))?.kind)
    .toBe("numericMismatch");
  logs.numericMismatch = await last("outcome");
  if (harness)
    assert(
      (await sceneCalls()).some((call) => call.method === "playMismatch"),
      "scene playMismatch",
    );
  await page.waitForTimeout(200);
  await shot("05-result-numeric-mismatch");
});

await step("result · judgment mismatch", async () => {
  await open("900000012");
  await pickPeak();
  await chooseWindow(true);
  await judge("아닌 것 같음");
  const result = await submit();
  await expect(result).toContainText("판단이 달라 성과로 인정되지 않았습니다.");
  await expect
    .poll(async () => (await last("outcome"))?.kind)
    .toBe("judgmentMismatch");
  const outcome = await last("outcome");
  assert(
    outcome.userJudgment === "UNLIKELY_PLANET",
    `judgment ${outcome.userJudgment}`,
  );
  assert(outcome.achievement.unlockedTicIds.length === 0, "no unlock");
  logs.judgmentMismatch = outcome;
  await page.waitForTimeout(200);
  await shot("06-result-judgment-mismatch");
});

await step("closing the result keeps the panel and the session", async () => {
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog.submission-dialog[open]")).toHaveCount(0);
  await expect(panel()).toBeVisible();
  logs.events = (await bridge()).map((entry) => entry.type);
});

await step("refused submission · submitFailed, no outcome", async () => {
  // Dev-only fixture header: the residual for this step is not ready (409).
  // Nothing is stored, so the sky is not touched.
  await page.route("**/api/v1/stars/*/submissions", (route) =>
    route.request().method() === "POST"
      ? route.continue({
          headers: {
            ...route.request().headers(),
            "x-fixture-submit": "context-not-ready",
          },
        })
      : route.continue(),
  );
  await open("900000015");
  await pickPeak();
  await chooseWindow(true);
  await judge("모르겠음");
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await expect(page.getByTestId("submission-result")).toContainText(
    "아직 제출할 수 없습니다",
  );
  await expect
    .poll(async () => (await last("submitFailed"))?.state)
    .toBe("context-not-ready");
  assert((await last("submitted"))?.kind === "candidate", "submitted");
  assert((await last("outcome")) === undefined, "no outcome");
  logs.submitFailed = await last("submitFailed");
  await page.unroute("**/api/v1/stars/*/submissions");
  await page.waitForTimeout(150);
  await shot("09-submit-refused");
});

if (harness)
  await step("variant toggle clears the panel (AnalysisSwitch)", async () => {
    await page.goto(`${base}${route.replace("{tic}", "900000013")}&switch=1`);
    const toggle = page.getByRole("group", { name: "분석 화면 디자인" });
    await expect(toggle).toBeVisible({ timeout: 20000 });
    await expect(
      toggle.getByRole("button", { name: "기존형", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(panel()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "1위 봉우리 선택", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    const toggleBox = await toggle.boundingBox();
    const panelBox = await panel().boundingBox();
    assert(
      toggleBox.y + toggleBox.height <= panelBox.y,
      `toggle ${JSON.stringify(toggleBox)} panel top ${panelBox.y}`,
    );
    await shot("07-variant-toggle");
  });

await step("narrow desktop 1024x768 keeps the classic grid", async () => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open("900000014");
  await pickPeak();
  const box = await panel().boundingBox();
  assert(box.height <= 768 * 0.6 + 1, `panel height ${box.height}`);
  await top();
  await page.waitForTimeout(150);
  await shot("08-narrow-1024");
  await page.setViewportSize({ width: 1440, height: 900 });
});

await writeFile(join(shots, "bridge-log.json"), JSON.stringify(logs, null, 2));
await browser.close();
const failed = results.filter((item) => !item.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed · page errors ${errors.length} · shots ${shots}`,
);
for (const error of errors.slice(0, 8)) console.log(`page error: ${error}`);
process.exit(failed.length ? 1 : 0);
