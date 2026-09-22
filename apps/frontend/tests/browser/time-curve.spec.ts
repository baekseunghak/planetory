import { openData } from "../analysis-ui";
import { test, expect } from "@playwright/test";
test("time chart preserves all points, shows actual times, and supports keyboard zoom and pan without API calls", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/stars/")) requests.push(request.url());
  });
  await page.goto("/analysis/259377017");
  const chart = page.getByRole("region", { name: "시간 곡선", exact: true });
  const plot = chart.getByRole("group", {
    name: "시간 곡선 그래프",
    exact: true,
  });
  await expect(plot).toHaveAttribute("data-point-count", "11");
  await expect(chart.getByText("Sector 14", { exact: true })).toBeVisible();
  await expect(chart.getByText("Sector 41", { exact: true })).toBeVisible();
  const requestCount = requests.length;
  await plot.focus();
  await page.keyboard.press("ArrowDown");
  await expect(chart.locator(".analysis-time-readout")).toContainText(
    `BTJD ${1683.35 + 5 / 1440} · 밝기 1 normalized`,
  );
  await page.keyboard.press("+");
  await expect(chart.getByTestId("time-zoom")).toHaveText("×2");
  const before = Number(await plot.getAttribute("data-view-start"));
  await page.keyboard.press("ArrowRight");
  expect(Number(await plot.getAttribute("data-view-start"))).toBeGreaterThan(
    before,
  );
  await page.keyboard.press("Home");
  await expect(chart.getByTestId("time-zoom")).toHaveText("×1");
  await plot.press("-");
  await expect(chart.getByTestId("time-zoom")).toHaveText("×1");
  await expect(plot).toHaveAttribute("data-point-count", "11");
  expect(requests.length).toBe(requestCount);
  await openData(page);
  await expect(
    page.locator(".analysis-secondary").getByText(/Sector 14 → 41:/),
  ).toContainText("736.59486일");
});
test("wheel zoom, drag pan, resize and reset redraw the same curve", async ({
  page,
}) => {
  await page.goto("/analysis/259377017");
  const plot = page.getByRole("group", {
    name: "시간 곡선 그래프",
    exact: true,
  });
  await expect(plot).toHaveAttribute("data-point-count", "11");
  await plot.scrollIntoViewIfNeeded();
  let box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect(page.getByTestId("time-zoom")).toHaveText("×1.25");
  const before = Number(await plot.getAttribute("data-view-start"));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  expect(Number(await plot.getAttribute("data-view-start"))).toBeGreaterThan(
    before,
  );
  await page
    .getByRole("button", { name: "시간 곡선 전체 보기", exact: true })
    .click();
  await expect(page.getByTestId("time-zoom")).toHaveText("×1");
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(plot).toBeVisible();
  await expect
    .poll(() =>
      plot.locator("canvas").evaluateAll((canvases) =>
        Math.max(
          ...canvases.map((element) => {
            const canvas = element as HTMLCanvasElement;
            return Math.abs(
              canvas.width -
                canvas.getBoundingClientRect().width * window.devicePixelRatio,
            );
          }),
        ),
      ),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(plot).toHaveAttribute("data-point-count", "11");
});
