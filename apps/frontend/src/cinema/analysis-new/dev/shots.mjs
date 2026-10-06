// Review script for the new analysis panel. Drives the real flows against
// `npm run dev:cinema` and saves screenshots.
//
//   CINEMA_PORT=58394 npm run dev:cinema
//   CINEMA_PORT=58394 CX_VIEWPORT=1440x900 CX_MODE=app CX_SHOTS=<dir> \
//     node src/cinema/analysis-new/dev/shots.mjs
//
// CX_MODE=app (default) opens the real route /analysis/:tic inside the cinema
// shell with the analysis variant stored as "cinematic". CX_MODE=harness opens
// the review harness (dev/harness.html) over a still backdrop; there the
// bridge events are recorded and checked.
//
// Every step is independent (its own star) and logs ok/FAIL. Failure states
// that the fixture cannot produce on demand (lost responses, bundle change,
// rejected fields, residual not ready, periodogram error) are made with
// page.route on the real endpoints; the app code is not changed. Slow folds
// wrap window.Worker so only the fold messages are delayed.
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CINEMA_PORT ?? 58394);
const base = `http://127.0.0.1:${port}`;
const [width, height] = (process.env.CX_VIEWPORT ?? "1440x900")
  .split("x")
  .map(Number);
const mode = process.env.CX_MODE === "harness" ? "harness" : "app";
const label = `${width}${mode === "harness" ? "-harness" : ""}`;
const shots = process.env.CX_SHOTS ?? "test-results/cinema-shots/new";
const only = process.env.CX_ONLY
  ? new Set(process.env.CX_ONLY.split(","))
  : null;
await mkdir(shots, { recursive: true });

const browser = await chromium.launch();
const results = [];
const pageErrors = [];

const urlFor = (tic, query = "") =>
  mode === "app"
    ? `${base}/analysis/${tic}?returnTo=${encodeURIComponent(`/sky?star=${tic}`)}`
    : `${base}/src/cinema/analysis-new/dev/harness.html?tic=${tic}${query}`;

async function newPage({ slowFold = 0, tic = "", mocked = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  await context.addInitScript((delay) => {
    try {
      localStorage.setItem("planetory:analysis-variant", "cinematic");
    } catch {
      /* The harness does not need it. */
    }
    if (!delay) return;
    const Native = window.Worker;
    window.Worker = class extends Native {
      postMessage(message, options) {
        if (message && message.type === "fold")
          setTimeout(() => super.postMessage(message, options), delay);
        else super.postMessage(message, options);
      }
    };
  }, slowFold);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${tic}: ${error}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Mocked 4xx/5xx replies are logged by the browser; they are the point.
    if (mocked && message.text().startsWith("Failed to load resource")) return;
    pageErrors.push(`${tic}: ${message.text()}`);
  });
  return { context, page };
}

async function open(tic, { slowFold = 0, mocked = false } = {}) {
  const { context, page } = await newPage({ slowFold, tic, mocked });
  await page.goto(urlFor(tic));
  await expect(page.getByTestId("cx-panel")).toBeVisible({ timeout: 30000 });
  return { page, context };
}
const shot = (page, name) =>
  page.screenshot({ path: join(shots, `${label}-${name}.png`) });

async function step(name, run) {
  if (only && !only.has(name)) return;
  const started = Date.now();
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(
      `FAIL ${name}\n     ${String(error).split("\n").slice(0, 6).join("\n     ")}`,
    );
  }
}

const fold = (page) => page.getByTestId("cx-fold");
async function pickPeak(page, rank = 1) {
  await page
    .getByRole("button", { name: `${rank}위 봉우리 선택`, exact: true })
    .click();
  await expect(fold(page)).toHaveAttribute("data-fold-ready", "true", {
    timeout: 20000,
  });
}
/** Zoom with the wheel around a phase, like a member hovering the dip. */
async function zoomAround(page, phase, notches = 4) {
  const box = await fold(page).boundingBox();
  for (let i = 0; i < notches; i++) {
    const start = Number(await fold(page).getAttribute("data-view-start"));
    const end = Number(await fold(page).getAttribute("data-view-end"));
    const x = box.x + ((phase - start) / (end - start)) * box.width;
    await page.mouse.move(x, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(60);
  }
}
async function dragWindow(page, from, to) {
  const box = await fold(page).boundingBox();
  const start = Number(await fold(page).getAttribute("data-view-start"));
  const end = Number(await fold(page).getAttribute("data-view-end"));
  const x = (phase) => box.x + ((phase - start) / (end - start)) * box.width;
  const y = box.y + box.height * 0.45;
  await page.mouse.move(x(from), y);
  await page.mouse.down();
  await page.mouse.move((x(from) + x(to)) / 2, y, { steps: 4 });
  await page.mouse.move(x(to), y, { steps: 4 });
  await page.mouse.up();
}
async function windowOverDip(page) {
  await zoomAround(page, 1, 4);
  await dragWindow(page, 0.993, 1.007);
  await expect(page.getByTestId("cx-window-phase")).toHaveAttribute(
    "data-valid",
    "true",
  );
}
/** EXP-12: "제출값 확인" shows what will be sent, "제출하기" sends it. */
async function send(page) {
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
}
async function judgeAndSubmit(page, judgment) {
  await page.getByRole("radio", { name: judgment, exact: true }).check();
  await send(page);
}
/**
 * The accepted result. In the app the shell may step the panel aside for a
 * transit and a discovery card first; its "이번 제출 결과" opens the detail
 * dialog over the panel's result region, which the step checks and closes.
 */
async function awaitResult(page, kind, cardShot) {
  const result = page.getByTestId("cx-result");
  await expect(result).toHaveAttribute("data-kind", kind, { timeout: 20000 });
  if (mode === "app") {
    const card = page.locator(".cinema-discovery");
    const appeared = await card
      .waitFor({ state: "visible", timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      if (cardShot) await shot(page, cardShot);
      await card.getByRole("button", { name: "이번 제출 결과" }).click();
      const detail = page.getByTestId("cx-result-detail");
      await expect(detail).toBeVisible({ timeout: 15000 });
      await detail.getByRole("button", { name: "닫기", exact: true }).click();
      await expect(detail).toBeHidden();
    }
  }
  await expect(result).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(450);
  return result;
}
const events = (page) => page.evaluate(() => window.__cxBridge ?? null);

await (async function reset() {
  const context = await browser.newContext();
  await context.request.post(`${base}/api/dev-cinema/reset`);
  await context.close();
})();

await step("loading", async () => {
  const { context, page } = await newPage({ tic: "900000009" });
  await page.route("**/api/v1/stars/*/analysis-context", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.continue().catch(() => undefined);
  });
  await page.goto(urlFor("900000009"));
  await expect(page.getByTestId("cx-loading")).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(600);
  await shot(page, "01-loading");
  await context.close();
});

await step("matched", async () => {
  const { page, context } = await open("900000010");
  await expect(
    page.getByRole("button", { name: "1위 봉우리 선택" }),
  ).toBeVisible({ timeout: 20000 });
  await shot(page, "02-start");
  await pickPeak(page, 1);
  // Fine-tune with the keyboard on the focused periodogram, then back.
  // An arrow moves 1/128 of a grid step, below the readout's three decimals:
  // compare the slider's unrounded period instead.
  const graph = page.getByRole("group", { name: "주기도 그래프" });
  const slider = page.locator('input[name="period-fine-tune-slider"]');
  await graph.focus();
  const before = await slider.inputValue();
  await graph.press("ArrowRight");
  await expect(fold(page)).toHaveAttribute("data-fold-ready", "true");
  const tuned = await slider.inputValue();
  if (tuned === before) throw new Error(`arrow did not tune: ${tuned}`);
  await graph.press("ArrowLeft");
  await expect(fold(page)).toHaveAttribute("data-fold-ready", "true");
  await shot(page, "03-period-focus");
  await windowOverDip(page);
  await shot(page, "04-window");
  await page.getByRole("radio", { name: "행성 같음", exact: true }).check();
  await page.locator(".cx-more summary").click();
  await page.getByRole("checkbox", { name: "V·U형" }).check();
  await page.getByPlaceholder("메모 (선택)").fill("U자 모양으로 떨어집니다.");
  await shot(page, "05-judgment");
  await send(page);
  await awaitResult(page, "matched", "06a-shell-discovery-card");
  await shot(page, "06-result-matched");
  await page
    .getByTestId("cx-result")
    .getByRole("button", { name: "이번 제출 결과" })
    .click();
  const detail = page.getByTestId("cx-result-detail");
  await expect(detail).toContainText("고른 주기가 신호와 맞았습니다.");
  await expect(detail).toContainText("성과로 인정되었습니다.");
  await shot(page, "07-result-detail");
  const log = await events(page);
  if (mode === "harness") {
    const types = new Set(log.map((event) => event.type));
    for (const type of [
      "sessionChanged",
      "periodChanged",
      "selectionChanged",
      "stageChanged",
      "submitted",
      "outcome",
    ])
      if (!types.has(type)) throw new Error(`missing bridge event ${type}`);
    const outcome = log
      .filter((event) => event.type === "outcome")
      .at(-1).payload;
    if (outcome.kind !== "matched" || !outcome.firstView)
      throw new Error(`outcome ${outcome.kind} firstView ${outcome.firstView}`);
    if (outcome.userJudgment !== "LIKELY_PLANET")
      throw new Error(`userJudgment ${outcome.userJudgment}`);
    if (outcome.achievement.unlockedTicIds.length !== 1)
      throw new Error("no unlocked star");
    const period = log.filter((event) => event.type === "periodChanged");
    if (!period.some((event) => event.payload.strength > 0.99))
      throw new Error("no strong period strength");
    if (!period.some((event) => event.payload.operation === "fine-tune"))
      throw new Error("no fine-tune event");
    const selection = log
      .filter(
        (event) => event.type === "selectionChanged" && event.payload.selection,
      )
      .at(-1).payload.selection;
    if (!selection.confirmed) throw new Error("selection never confirmed");
    const inset = await page.evaluate(() => window.__cxInset.at(-1));
    if (!inset || !(inset.bottom > 200))
      throw new Error(`inset ${JSON.stringify(inset)}`);
    console.log(
      `     outcome ${outcome.kind} unlocked ${outcome.achievement.unlockedTicIds} inset ${inset.bottom}px`,
    );
  }
  await context.close();
});

await step("numeric-mismatch", async () => {
  const { page, context } = await open("900000011");
  await pickPeak(page, 1);
  await zoomAround(page, 0.5, 4);
  await dragWindow(page, 0.493, 0.507);
  await expect(page.getByTestId("cx-window-phase")).toHaveAttribute(
    "data-valid",
    "true",
  );
  await judgeAndSubmit(page, "행성 같음");
  await awaitResult(page, "numericMismatch");
  await shot(page, "08-result-numeric");
  await context.close();
});

await step("judgment-mismatch", async () => {
  const { page, context } = await open("900000012");
  await pickPeak(page, 1);
  await windowOverDip(page);
  await judgeAndSubmit(page, "아닌 것 같음");
  await awaitResult(page, "judgmentMismatch", "09a-shell-judgment-card");
  await shot(page, "09-result-judgment");
  await page
    .getByTestId("cx-result")
    .getByRole("button", { name: "이번 제출 결과" })
    .click();
  await expect(page.getByTestId("cx-result-detail")).toContainText(
    "판단이 달라 성과로 인정되지 않았습니다.",
  );
  await shot(page, "10-result-judgment-detail");
  await context.close();
});

await step("invalid-window", async () => {
  const { page, context } = await open("900000019");
  await pickPeak(page, 1);
  await dragWindow(page, 0.9, 1.1);
  await expect(page.getByTestId("cx-window-phase")).toHaveAttribute(
    "data-valid",
    "false",
  );
  await expect(page.getByTestId("cx-guide")).toContainText("넓습니다");
  await shot(page, "11-window-invalid");
  await context.close();
});

await step("folding", async () => {
  const { page, context } = await open("900000019", { slowFold: 2600 });
  await page
    .getByRole("button", { name: "2위 봉우리 선택", exact: true })
    .click();
  await expect(page.getByTestId("cx-fold-status")).toContainText(
    "접고 있습니다",
    { timeout: 5000 },
  );
  await shot(page, "12-folding");
  await expect(fold(page)).toHaveAttribute("data-fold-ready", "true", {
    timeout: 20000,
  });
  await context.close();
});

await step("direct-pick", async () => {
  const { page, context } = await open("900000020");
  await page.getByRole("button", { name: "직접 선택" }).click();
  const graph = page.getByRole("group", { name: "주기도 그래프" });
  for (let i = 0; i < 6; i++) await graph.press("Shift+ArrowRight");
  await graph.press("Enter");
  await expect(fold(page)).toHaveAttribute("data-fold-ready", "true", {
    timeout: 20000,
  });
  await expect(page.getByText("직접 선택한 주기의 미세 조정은")).toBeVisible();
  await shot(page, "13-direct-pick");
  await context.close();
});

await step("keyboard-window", async () => {
  const { page, context } = await open("900000021");
  await pickPeak(page, 1);
  const chart = page.getByRole("group", { name: "접힌 곡선 그래프" });
  await chart.focus();
  for (const key of ["+", "+", "+", "+"]) await chart.press(key);
  for (let i = 0; i < 12; i++) await chart.press("ArrowRight");
  // Enter on the chart starts a window at the view's center.
  await chart.press("Enter");
  const start = page.getByRole("slider", { name: "위상 구간 시작" });
  await expect(start).toBeFocused();
  await start.press("Shift+ArrowLeft");
  await page.getByRole("slider", { name: "위상 구간 끝" }).focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("cx-window-phase")).toHaveAttribute(
    "data-valid",
    "true",
  );
  await shot(page, "14-keyboard-window");
  await context.close();
});

const unavailable = {
  status: 503,
  contentType: "application/json",
  body: JSON.stringify({
    code: "UNAVAILABLE",
    message: "잠시 후 다시 시도해 주세요.",
  }),
};
await step("sending-and-unresolved", async () => {
  const { page, context } = await open("900000013", { mocked: true });
  await pickPeak(page, 1);
  await windowOverDip(page);
  await page.route("**/api/v1/stars/*/submissions", (route) =>
    route.request().method() === "POST"
      ? setTimeout(() => route.fulfill(unavailable), 1500)
      : route.continue(),
  );
  await page.route("**/api/v1/submissions/by-request/*", (route) =>
    route.fulfill(unavailable),
  );
  await judgeAndSubmit(page, "행성 같음");
  // While sending, the review stays (its button busy) and its status says so.
  await expect(page.getByTestId("cx-review").getByRole("status")).toHaveText(
    "제출 중…",
  );
  await shot(page, "15-sending");
  await expect(page.getByTestId("cx-submission")).toHaveAttribute(
    "data-state",
    "unresolved",
    { timeout: 20000 },
  );
  await shot(page, "16-unresolved");
  // A reload keeps the request ID and offers the check again.
  await page.reload();
  await expect(page.getByTestId("cx-submission")).toHaveAttribute(
    "data-state",
    "unresolved",
    { timeout: 30000 },
  );
  await shot(page, "17-unresolved-after-reload");
  await page.unroute("**/api/v1/stars/*/submissions");
  await page.unroute("**/api/v1/submissions/by-request/*");
  await page.getByRole("button", { name: "접수 결과 확인" }).click();
  await expect(
    page.getByRole("button", { name: "같은 내용으로 다시 보내기" }),
  ).toBeVisible({ timeout: 15000 });
  await shot(page, "18-not-found-resend");
  await page.getByRole("button", { name: "같은 내용으로 다시 보내기" }).click();
  await awaitResult(page, "matched");
  if (mode === "harness") {
    const log = await events(page);
    const failed = log.filter((event) => event.type === "submitFailed");
    if (!failed.some((event) => event.payload.state === "unresolved"))
      throw new Error("no submitFailed unresolved");
    const outcome = log
      .filter((event) => event.type === "outcome")
      .at(-1)?.payload;
    if (outcome?.userJudgment !== "LIKELY_PLANET")
      throw new Error(`recovered judgment ${outcome?.userJudgment}`);
  }
  await shot(page, "19-recovered-result");
  await context.close();
});

async function refusal(tic, status, body, name, expectText) {
  const { page, context } = await open(tic, { mocked: true });
  await pickPeak(page, 1);
  await windowOverDip(page);
  await page.route("**/api/v1/stars/*/submissions", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        })
      : route.continue(),
  );
  await judgeAndSubmit(page, "행성 같음");
  await expect(page.getByTestId("cx-submission")).toContainText(expectText, {
    timeout: 15000,
  });
  await shot(page, name);
  await context.close();
}

await step("bundle-changed", () =>
  refusal(
    "900000014",
    409,
    {
      code: "BUNDLE_CHANGED",
      message: "데이터 판이 바뀌었습니다.",
      currentBundleId: "9007199254749999",
    },
    "20-bundle-changed",
    "최신 자료를 다시 불러온 뒤",
  ),
);

await step("rejected", () =>
  refusal(
    "900000015",
    400,
    {
      code: "VALIDATION_FAILED",
      message: "입력값을 확인해 주세요.",
      fieldErrors: [
        {
          field: "selection.phaseEnd",
          reason: "선택 구간에 관측점이 없습니다.",
        },
      ],
    },
    "21-rejected",
    "구간 끝: 선택 구간에 관측점이 없습니다.",
  ),
);

await step("context-not-ready", () =>
  refusal(
    "900000016",
    409,
    {
      code: "SUBMISSION_CONTEXT_NOT_READY",
      message: "잔차가 준비되지 않았습니다.",
      residual: { status: "QUEUED", jobId: "job-cx-1" },
    },
    "22-context-not-ready",
    "이 단계의 계산이 아직 끝나지 않았습니다.",
  ),
);

await step("periodogram-error", async () => {
  const { context, page } = await newPage({ tic: "900000017", mocked: true });
  await page.route("**/api/v1/stars/*/candidate-peaks*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        code: "INTERNAL",
        message: "봉우리 계산 서버 오류",
      }),
    }),
  );
  await page.goto(urlFor("900000017"));
  await expect(page.getByTestId("cx-periodogram-state")).toContainText(
    "주기도를 불러오지 못했습니다.",
    { timeout: 20000 },
  );
  await expect(
    page.getByRole("button", { name: "주기도 다시 불러오기" }),
  ).toBeVisible();
  await shot(page, "23-periodogram-error");
  await context.close();
});

await step("draft-restore", async () => {
  const { page, context } = await open("900000018");
  await pickPeak(page, 1);
  await windowOverDip(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.reload();
  await expect(page.getByRole("button", { name: "초안 불러오기" })).toBeVisible(
    { timeout: 30000 },
  );
  await shot(page, "24-draft-offer");
  await page.getByRole("button", { name: "초안 불러오기" }).click();
  await expect(page.getByTestId("cx-window-phase")).toHaveAttribute(
    "data-valid",
    "true",
    { timeout: 20000 },
  );
  await shot(page, "25-draft-restored");
  // A draft never restores the confirmation (analysis-frontend-spec 5.1) and a
  // judgment shows only for a confirmed window: picking it again confirms.
  const unsure = page.getByRole("radio", { name: "모르겠음", exact: true });
  await expect(unsure).not.toBeChecked();
  await unsure.check();
  await expect(
    page.getByRole("button", { name: "제출값 확인", exact: true }),
  ).toBeEnabled();
  await context.close();
});

await step("special-submission", async () => {
  const { page, context } = await open("900000022");
  await page.getByRole("button", { name: "더 이상 없음" }).click();
  await expect(page.getByTestId("cx-submission-confirm")).toBeVisible();
  await shot(page, "26-no-candidate-confirm");
  await page.getByRole("button", { name: "취소" }).click();
  await context.close();
});

await step("curve-step", async () => {
  const { page, context } = await open("900000023");
  await page.getByRole("button", { name: "다음 곡선 단계로" }).click();
  await expect(page.getByTestId("cx-residual-progress")).toBeVisible({
    timeout: 5000,
  });
  await shot(page, "27-curve-step-running");
  await expect(page.getByText("곡선 단계 1").first()).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId("cx-residual-progress")).toHaveCount(0, {
    timeout: 30000,
  });
  await shot(page, "28-curve-step-1");
  await context.close();
});

await step("help", async () => {
  const { page, context } = await open("900000024");
  await page.getByRole("button", { name: "조작법", exact: true }).click();
  await expect(page.getByTestId("cx-help-dialog")).toBeVisible();
  await shot(page, "29-help");
  await context.close();
});

await browser.close();
const failed = results.filter((item) => !item.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} steps passed at ${width}x${height} (${mode}); page errors: ${pageErrors.length}`,
);
for (const error of pageErrors) console.log(`  ${error}`);
process.exitCode = failed.length || pageErrors.length ? 1 : 0;
