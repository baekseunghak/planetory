import { openData } from "../analysis-ui";
import { test, expect } from "@playwright/test";
const panelName = "반복 주기 그래프";
test("single chart supports keyboard zoom, pan and peak inspection without requests or selection", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/stars/")) requests.push(r.url());
  });
  await page.goto("/analysis/259377024");
  const panel = page.getByRole("region", { name: panelName, exact: true }),
    plot = panel.getByRole("group", { name: "주기도 그래프", exact: true });
  await expect(plot).toHaveAttribute("data-point-count", "5000");
  await expect(panel.locator("canvas")).toHaveCount(1);
  await expect(
    panel.getByRole("button", { name: /위 봉우리 선택/ }),
  ).toHaveCount(3);
  const count = requests.length;
  await plot.press("+");
  await expect(page.getByTestId("periodogram-zoom")).toHaveText("×2");
  const before = Number(await plot.getAttribute("data-view-start"));
  await plot.press("ArrowRight");
  expect(Number(await plot.getAttribute("data-view-start"))).toBeGreaterThan(
    before,
  );
  await plot.press("Home");
  await plot.press("ArrowDown");
  await expect(page.getByTestId("periodogram-readout")).toContainText(
    "주기 0.5일",
  );
  await panel
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .focus();
  await expect(page.getByTestId("periodogram-readout")).toContainText("power");
  await expect(page.getByTestId("selected-period")).not.toHaveAttribute(
    "data-period",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("periodogram-readout")).toHaveCount(0);
  await panel
    .getByRole("button", { name: "주기도 전체 보기", exact: true })
    .click();
  await expect(plot).toHaveAttribute("data-view-start", "0");
  expect(requests.length).toBe(count);
});

test("wheel, drag, focus, resize and supported narrow layout preserve usable chart controls", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/analysis/259377024");
  const panel = page.getByRole("region", { name: panelName, exact: true });
  const plot = panel.getByRole("group", { name: "주기도 그래프", exact: true });
  await expect(plot).toBeVisible();
  await plot.scrollIntoViewIfNeeded();
  await plot.focus();
  expect(
    await plot.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  let box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect(panel.getByTestId("periodogram-zoom")).toHaveText("×1.25");
  const before = Number(await plot.getAttribute("data-view-start"));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  expect(Number(await plot.getAttribute("data-view-start"))).toBeGreaterThan(
    before,
  );
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(plot).toBeVisible();
  expect(
    await panel
      .locator(".periodogram-y-axis span")
      .evaluateAll((labels) =>
        labels.every((label) => label.getBoundingClientRect().height < 24),
      ),
  ).toBe(true);
  await expect
    .poll(() =>
      plot
        .locator("canvas")
        .evaluate((canvas: HTMLCanvasElement) =>
          Math.abs(
            canvas.width -
              canvas.getBoundingClientRect().width * devicePixelRatio,
          ),
        ),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(
    page.getByText("Planetory는 폭 1024px 이상의 화면을 지원합니다."),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("loading and recoverable periodogram errors keep the time curve and announce state", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failing = true;
  await page.route(
    "**/api/v1/stars/259377024/periodogram?**",
    async (route) => {
      await gate;
      if (failing)
        await route.fulfill({
          status: 503,
          json: {
            code: "DEPENDENCY_UNAVAILABLE",
            message: "다시 시도해 주세요.",
          },
        });
      else await route.continue();
    },
  );
  await page.goto("/analysis/259377024");
  const panel = page.getByRole("region", { name: panelName, exact: true });
  await expect(panel.locator('[aria-live="polite"]')).toContainText(
    "불러오고 있습니다…",
  );
  await expect(
    page.getByRole("group", { name: "시간 곡선 그래프", exact: true }),
  ).toBeVisible();
  await expect(panel.locator("canvas")).toHaveCount(0);
  release();
  await expect(panel).toContainText("주기도를 불러오지 못했습니다.");
  failing = false;
  await panel.getByRole("button", { name: "주기도 다시 불러오기" }).click();
  await expect(
    panel.getByRole("group", { name: "주기도 그래프", exact: true }),
  ).toBeVisible();
});

test("empty, pending, malformed and mismatched responses never retain a prior chart", async ({
  page,
}) => {
  for (const [tic, text] of [
    ["259377025", "nPeriods/power.length"],
    ["259377026", "문맥이 달라 표시를 중단"],
    ["259377027", "표시할 추천 봉우리 자료가 없습니다."],
    ["259377028", "주기도를 불러오지 못했습니다."],
    ["259377029", "이 단계의 주기도 계산 결과가 없습니다."],
  ]) {
    await page.goto(`/analysis/${tic}`);
    const panel = page.getByRole("region", { name: panelName, exact: true });
    await expect(panel).toContainText(text);
    await expect(panel.locator("canvas")).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "시간 곡선 그래프", exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("button")).toBeEnabled();
  }
});

test("refresh unmounts the previous chart and route departure cannot accept a late old response", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  const panel = page.getByRole("region", { name: panelName, exact: true });
  const plot = panel.getByRole("group", { name: "주기도 그래프", exact: true });
  await expect(plot).toBeVisible();
  await plot.press("+");
  await openData(page);
  await page
    .getByRole("button", { name: "최신 자료 확인", exact: true })
    .click();
  await expect(panel.getByTestId("periodogram-zoom")).toHaveText("×1");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/v1/stars/259377024/candidate-peaks?**",
    async (route) => {
      await gate;
      await route.continue().catch(() => {});
    },
  );
  await openData(page);
  await page
    .getByRole("button", { name: "최신 자료 확인", exact: true })
    .click();
  await expect(panel).toContainText("불러오고 있습니다…");
  await page.locator(".analysis-fixture-details summary").click();
  await page
    .getByRole("link", { name: "주기도 오류 샘플", exact: true })
    .click();
  await expect(panel).toContainText("주기도를 불러오지 못했습니다.");
  release();
  await expect(panel.locator("canvas")).toHaveCount(0);
  await expect(page).toHaveURL(/259377028/);
});
