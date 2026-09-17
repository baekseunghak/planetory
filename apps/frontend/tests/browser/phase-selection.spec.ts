import { expect, test, type Page } from "@playwright/test";

const plot = (page: Page) =>
  page.getByRole("group", { name: "접힌 곡선 그래프", exact: true });
const handle = (page: Page, end = false) =>
  page.getByRole("slider", {
    name: end ? "위상 구간 끝" : "위상 구간 시작",
    exact: true,
  });
async function open(page: Page) {
  await page.goto("/analysis/259377024");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
}
async function draw(page: Page, start: number, end: number) {
  await plot(page).scrollIntoViewIfNeeded();
  const box = (await plot(page).boundingBox())!;
  const low = Number(await plot(page).getAttribute("data-view-start"));
  const high = Number(await plot(page).getAttribute("data-view-end"));
  const x = (phase: number) =>
    box.x + ((phase - low) / (high - low)) * box.width;
  await page.mouse.move(x(start), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x(end), box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}

test("keyboard steps follow view width, Shift is ten steps, focus and Canvas are retained", async ({
  page,
}) => {
  await open(page);
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) calls.push(request.url());
  });
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
  await expect(handle(page)).toBeFocused();
  const initial = Number(await handle(page).getAttribute("aria-valuenow"));
  await handle(page).press("ArrowLeft");
  expect(Number(await handle(page).getAttribute("aria-valuenow"))).toBeCloseTo(
    initial - 0.002,
    12,
  );
  await handle(page).press("Shift+ArrowRight");
  expect(Number(await handle(page).getAttribute("aria-valuenow"))).toBeCloseTo(
    initial + 0.018,
    12,
  );
  await expect(plot(page)).toHaveAttribute("data-view-start", "-0.5");
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
  await plot(page).focus();
  for (let i = 0; i < 5; i++) await plot(page).press("+");
  const start = Number(await handle(page).getAttribute("aria-valuenow"));
  const viewStart = await plot(page).getAttribute("data-view-start");
  await plot(page)
    .locator("canvas")
    .evaluate((canvas) => {
      canvas.dataset.retained = "yes";
    });
  // Capture actual drawing calls after zoom settles, rather than infer performance from DOM reuse.
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.clearRect;
    (window as unknown as { selectionDraws: number }).selectionDraws = 0;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.closest(".fold-plot"))
        (window as unknown as { selectionDraws: number }).selectionDraws++;
      return original.apply(this, args);
    };
  });
  await handle(page).press("ArrowLeft");
  expect(Number(await handle(page).getAttribute("aria-valuenow"))).toBeCloseTo(
    start - 0.0625 / 1000,
    12,
  );
  await expect(handle(page)).toBeFocused();
  await expect(plot(page)).toHaveAttribute("data-view-start", viewStart!);
  await expect(plot(page).locator("canvas")).toHaveAttribute(
    "data-retained",
    "yes",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { selectionDraws: number }).selectionDraws,
    ),
  ).toBe(0);
  expect(calls).toEqual([]);
});

test("either repeated cycle and reverse dragging normalize a boundary crossing without rounding", async ({
  page,
}) => {
  await open(page);
  await draw(page, -0.01, 0.01);
  await expect(handle(page)).toBeFocused();
  const value = page.getByTestId("phase-selection-value");
  await expect(value).toHaveAttribute("data-valid", "true");
  const first = Number(await value.getAttribute("data-start"));
  const last = Number(await value.getAttribute("data-end"));
  expect(first).toBeGreaterThan(0.98);
  expect(last).toBeGreaterThan(1);
  await draw(page, 1.01, 0.99);
  await expect(value).toHaveAttribute("data-valid", "true");
  expect(Number(await value.getAttribute("data-start"))).toBeCloseTo(first, 2);
  expect(Number(await value.getAttribute("data-end"))).toBeCloseTo(last, 2);
  const selected = await value.getAttribute("data-start");
  await page
    .getByRole("button", { name: "접힌 곡선 확대", exact: true })
    .click();
  await expect(value).toHaveAttribute("data-start", selected!);
  await page
    .getByRole("button", { name: "접힌 곡선 전체 보기", exact: true })
    .click();
  await expect(value).toHaveAttribute("data-start", selected!);
});

test("invalid widths remain editable, Escape and pointer cancel restore the previous selection", async ({
  page,
}) => {
  await open(page);
  await draw(page, 0.1, 0.8);
  await expect(page.getByTestId("phase-selection-value")).toHaveAttribute(
    "data-valid",
    "false",
  );
  await expect(page.getByTestId("phase-selection-status")).toContainText(
    "최소·최대 폭",
  );
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
  const previous = await handle(page).getAttribute("aria-valuenow");
  for (const cancellation of ["Escape", "pointercancel"]) {
    await handle(page).scrollIntoViewIfNeeded();
    const box = (await handle(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 20, box.y + box.height / 2);
    if (cancellation === "Escape") await handle(page).press("Escape");
    else await handle(page).dispatchEvent("pointercancel");
    await page.mouse.up();
    await expect(handle(page)).toHaveAttribute("aria-valuenow", previous!);
  }
  await page.getByRole("button", { name: "구간 지우기", exact: true }).click();
  await expect(handle(page)).toHaveCount(0);
  await expect(page.getByTestId("phase-selection-value")).toContainText(
    "아직 선택한 구간",
  );
  await plot(page).scrollIntoViewIfNeeded();
  const box = (await plot(page).boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(handle(page)).toHaveCount(0);
  await expect(plot(page)).toBeFocused();
});

test("pointer handles resize without losing the grab offset and keep both targets 44px at 1024px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 844 });
  await open(page);
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
  await plot(page).focus();
  for (let i = 0; i < 5; i++) await plot(page).press("+");
  await handle(page, true).scrollIntoViewIfNeeded();
  const before = Number(await handle(page, true).getAttribute("aria-valuenow"));
  const width = (await plot(page).boundingBox())!.width;
  const box = (await handle(page, true).boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.mouse.move(box.x + 5, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 15, box.y + 10, { steps: 5 });
  await page.mouse.up();
  expect(
    Number(await handle(page, true).getAttribute("aria-valuenow")),
  ).toBeCloseTo(before + (10 / width) * 0.0625, 10);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("missing selection rules disable only the selection UI, not the folded curve", async ({
  page,
}) => {
  await page.route("**/api/v1/stars/*/analysis-context", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    delete json.selectionRules.minWindowDays;
    await route.fulfill({ response, json });
  });
  await open(page);
  await expect(plot(page).locator("canvas")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "구간 선택 시작", exact: true }),
  ).toBeDisabled();
  await expect(page.getByTestId("phase-selection-status")).not.toBeEmpty();
});

test("default drag selects directly; Shift drag pans without changing selection or recalculating the fold", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByRole("button", { name: "새 구간 그리기", exact: true }),
  ).toHaveCount(0);
  await draw(page, -0.01, 0.01);
  const value = page.getByTestId("phase-selection-value");
  const selectedStart = await value.getAttribute("data-start");
  const selectedEnd = await value.getAttribute("data-end");
  const revision = await page
    .getByTestId("fold-result")
    .getAttribute("data-revision");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push(request.url());
  });
  await plot(page).focus();
  await plot(page).press("+");
  await plot(page).press("+");
  const before = Number(await plot(page).getAttribute("data-view-start"));
  await plot(page).scrollIntoViewIfNeeded();
  const box = (await plot(page).boundingBox())!;
  const from = Math.round(box.x + box.width / 2);
  await page.keyboard.down("Shift");
  await page.mouse.move(from, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(from + 100, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect(Number(await plot(page).getAttribute("data-view-start"))).toBeCloseTo(
    before - (100 / box.width) * 0.5,
    10,
  );
  await expect(value).toHaveAttribute("data-start", selectedStart!);
  await expect(value).toHaveAttribute("data-end", selectedEnd!);
  await expect(page.getByTestId("fold-result")).toHaveAttribute(
    "data-revision",
    revision!,
  );
  await expect(page.getByTestId("fold-zoom")).toHaveText("×4");
  await expect(plot(page)).toBeFocused();
  // Double-click is a view reset, not a zero-width replacement selection.
  await page.mouse.dblclick(from, box.y + box.height / 2);
  await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
  await expect(value).toHaveAttribute("data-start", selectedStart!);
  await expect(value).toHaveAttribute("data-end", selectedEnd!);
  expect(requests).toEqual([]);
});

test("Shift pan supports cancellation and clamps the view; Shift on a handle still edits the boundary", async ({
  page,
}) => {
  await open(page);
  await plot(page).focus();
  for (let i = 0; i < 5; i++) await plot(page).press("+");
  await plot(page).scrollIntoViewIfNeeded();
  const box = (await plot(page).boundingBox())!;
  const from = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const before = await plot(page).getAttribute("data-view-start");
  await page.keyboard.down("Shift");
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move(from + 80, y);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(plot(page)).toHaveAttribute("data-view-start", before!);
  await expect(handle(page)).toHaveCount(0);
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(box.x + 10, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 10, y);
    await page.mouse.up();
  }
  await page.keyboard.up("Shift");
  await expect(plot(page)).toHaveAttribute("data-view-start", "-0.5");
  await expect(page.getByTestId("fold-zoom")).toHaveText("×32");
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
  await handle(page, true).scrollIntoViewIfNeeded();
  const endBefore = await handle(page, true).getAttribute("aria-valuenow");
  const endBox = (await handle(page, true).boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(
    endBox.x + endBox.width / 2,
    endBox.y + endBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    endBox.x + endBox.width / 2 + 10,
    endBox.y + endBox.height / 2,
  );
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(handle(page, true)).not.toHaveAttribute(
    "aria-valuenow",
    endBefore!,
  );
  await expect(plot(page)).toHaveAttribute("data-view-start", "-0.5");
});

test("refolding locks selection, failure restores it, successful retry clears it without remounting Canvas", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let count = 0;
    window.Worker = class extends NativeWorker {
      override postMessage(message: unknown) {
        const job = message as {
          type: string;
          dataId: string;
          revision: number;
        };
        if (job.type === "fold" && ++count === 2) {
          setTimeout(
            () =>
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: {
                    type: "fold-error",
                    dataId: job.dataId,
                    revision: job.revision,
                    error: "selection test failure",
                  },
                }),
              ),
            1200,
          );
        } else super.postMessage(message);
      }
    };
  });
  await open(page);
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
  const before = await handle(page).getAttribute("aria-valuenow");
  await plot(page)
    .locator("canvas")
    .evaluate((canvas) => {
      canvas.dataset.retained = "yes";
    });
  await handle(page).scrollIntoViewIfNeeded();
  const box = (await handle(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 10, box.y + box.height / 2);
  await page
    .getByRole("button", { name: "한 간격 늘리기", exact: true })
    .press("Enter");
  await expect(handle(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "구간 선택 시작", exact: true }),
  ).toBeDisabled();
  await expect(page.getByTestId("fold-status")).toContainText("접기에 실패");
  await expect(handle(page)).toBeEnabled();
  await expect(handle(page)).toHaveAttribute("aria-valuenow", before!);
  await page.mouse.up();
  // A new drag must work even if refolding interrupted pointer capture.
  await handle(page).scrollIntoViewIfNeeded();
  const restored = (await handle(page).boundingBox())!;
  await page.mouse.move(
    restored.x + restored.width / 2,
    restored.y + restored.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(restored.x - 5, restored.y + restored.height / 2);
  await page.mouse.up();
  await expect(handle(page)).not.toHaveAttribute("aria-valuenow", before!);
  await page
    .getByRole("button", { name: "접기 다시 계산", exact: true })
    .click();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  await expect(handle(page)).toHaveCount(0);
  await expect(plot(page).locator("canvas")).toHaveAttribute(
    "data-retained",
    "yes",
  );
});
