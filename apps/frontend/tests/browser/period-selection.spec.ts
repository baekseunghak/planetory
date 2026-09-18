import { selectPeak, openData } from "../analysis-ui";
import { test, expect } from "@playwright/test";
import { candidatePeaksFixture } from "../../dev/periodogram-fixtures";
import { FINE_TUNE_DIVISIONS } from "../../src/features/analysis/period-selection";

test("peak slider uses the fine step for arrows and the server step for Page keys, clamps bounds and preserves source without requests", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) requests.push(r.url());
  });
  await page.goto("/analysis/259377024");
  await selectPeak(page);
  const selected = page.getByTestId("selected-period"),
    peak = candidatePeaksFixture().peaks[0];
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.periodDays),
  );
  const loaded = requests.slice(),
    slider = page.getByRole("slider", { name: "반복 주기 미세 조정" });
  await slider.press("ArrowRight");
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.periodDays + peak.fineTune.periodStepDays / FINE_TUNE_DIVISIONS),
  );
  await expect(selected).toHaveAttribute("data-source", "3600");
  await expect(selected).toHaveAttribute("data-operation", "fine-tune");
  // Page 키는 서버 격자 한 칸을 그대로 움직인다.
  await slider.press("ArrowLeft");
  await slider.press("PageUp");
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.periodDays + peak.fineTune.periodStepDays),
  );
  await slider.press("PageDown");
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.periodDays),
  );
  await slider.press("Home");
  await slider.press("ArrowLeft");
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.fineTune.periodMinDays),
  );
  await slider.press("End");
  await slider.press("ArrowRight");
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.fineTune.periodMaxDays),
  );
  await selectPeak(page);
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.periodDays),
  );
  await expect(selected).toHaveAttribute("data-operation", "reselect");
  expect(requests).toEqual(loaded);
});

test("direct grid selection has null source and deferred fine tuning; read-only steps cannot reselect", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  const plot = page.getByRole("group", { name: "주기도 그래프", exact: true });
  await plot.press("ArrowDown");
  await plot.press("Enter");
  const selected = page.getByTestId("selected-period");
  await expect(selected).toHaveAttribute("data-period", "0.5");
  await expect(selected).toHaveAttribute("data-source", "null");
  await expect(
    page.getByText("직접 선택한 주기의 미세 조정은 아직 지원하지 않습니다.", {
      exact: false,
    }),
  ).toBeVisible();
  // 주기 선택 단계에 머무르므로 몇 번이든 다시 고를 수 있다.
  const revision = await selected.getAttribute("data-revision");
  await plot.press("ArrowDown");
  await plot.press("Enter");
  await expect(selected).not.toHaveAttribute("data-revision", revision!);
  await expect(selected).not.toHaveAttribute("data-period", "0.5");
  await expect(selected).toHaveAttribute("data-source", "null");
  // 다음 단계로 넘어가야 주기도가 읽기 전용이 된다.
  await selectPeak(page);
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  await page
    .getByRole("button", { name: "이 주기로 구간 선택", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "1위 봉우리 선택", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  const locked = await selected.getAttribute("data-revision");
  await plot.press("ArrowDown");
  await plot.press("Enter");
  await expect(selected).toHaveAttribute("data-revision", locked!);
});

test("dragging does not select; direct click and continuous pointer slider stay within bounds", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  const plot = page.getByRole("group", { name: "주기도 그래프", exact: true }),
    selected = page.getByTestId("selected-period");
  await expect(plot).toBeVisible();
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.85);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.85, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(selected).not.toHaveAttribute("data-period");
  await plot.click({ position: { x: box.width * 0.4, y: box.height * 0.85 } });
  await expect(selected).toHaveAttribute("data-source", "null");
  await selectPeak(page);
  const slider = page.getByRole("slider", { name: "반복 주기 미세 조정" }),
    track = (await slider.boundingBox())!;
  await slider.click({
    position: { x: track.width * 0.8, y: track.height / 2 },
  });
  await expect(selected).toHaveAttribute("data-operation", "fine-tune");
  const p = Number(await selected.getAttribute("data-period")),
    fine = candidatePeaksFixture().peaks[0].fineTune;
  expect(p).toBeGreaterThanOrEqual(fine.periodMinDays);
  expect(p).toBeLessThanOrEqual(fine.periodMaxDays);
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(slider).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("refresh and route changes discard selections; unavailable responses cannot select", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  await selectPeak(page);
  await openData(page);
  await page
    .getByRole("button", { name: "최신 자료 확인", exact: true })
    .click();
  await expect(page.getByTestId("selected-period")).not.toHaveAttribute(
    "data-period",
  );
  await expect(
    page.getByRole("slider", { name: "반복 주기 미세 조정" }),
  ).toBeDisabled();
  await selectPeak(page, 2);
  await page.locator(".analysis-fixture-details summary").click();
  await page
    .getByRole("link", { name: "주기도 오류 샘플", exact: true })
    .click();
  await expect(page.getByTestId("selected-period")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /위 봉우리 선택/ }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "빈 봉우리 샘플", exact: true }).click();
  await expect(
    page.getByText("표시할 추천 봉우리 자료가 없습니다.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /위 봉우리 선택/ }),
  ).toHaveCount(0);
});
