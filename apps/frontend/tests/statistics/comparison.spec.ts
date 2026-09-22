import { test, expect } from "@playwright/test";
import { comparisonFixture } from "../fixtures/comparison";
import { personalStatisticsFixture } from "../fixtures/personal-statistics";
// Contract-only rendering case: the current backend cannot yet supply this myValue.
test("comparable values use equal-width tracks and preserve server values", async ({
  page,
}) => {
  const c = comparisonFixture();
  Object.assign(c.metrics.firstMatchAccuracy.myValue, {
    value: 25,
    numerator: 1,
    denominator: 4,
    status: "AVAILABLE",
    reason: null,
  });
  await page.route("**/api/v1/me/statistics", (r) =>
    r.fulfill({ json: { ...personalStatisticsFixture(), comparison: c } }),
  );
  await page.goto("/me?section=statistics");
  const table = page.getByRole("region", { name: "일별 비교 지표 표" });
  const bars = table.locator(".statistics-bar");
  await expect(bars).toHaveCount(2);
  await expect(table.getByText("25%", { exact: true })).toBeVisible();
  const widths = await bars.evaluateAll((nodes) =>
    nodes.map((n) => n.getBoundingClientRect().width),
  );
  expect(widths[1] / widths[0]).toBeCloseTo(2, 1);
});
test("historical source unavailable never borrows current values; periods and sample size are explicit", async ({
  page,
}) => {
  await page.route("**/api/v1/me/statistics", (r) =>
    r.fulfill({
      json: { ...personalStatisticsFixture(), comparison: comparisonFixture() },
    }),
  );
  await page.goto("/me?section=statistics");
  const area = page.getByRole("region", {
    name: "일별 중앙값 비교",
    exact: true,
  });
  await expect(area.getByText("당시 자료 부족", { exact: true })).toHaveCount(
    4,
  );
  await expect(area.locator(".statistics-bar")).toHaveCount(0);
  await expect(area.getByText("0%", { exact: true })).toBeVisible();
  await expect(area).toContainText("90일은 회원 선정 기간");
  await expect(
    area.locator('time[datetime="2026-09-21T15:05:00Z"]'),
  ).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await area.getByRole("region", { name: "일별 비교 지표 표" }).focus();
  await expect(
    area.getByRole("region", { name: "일별 비교 지표 표" }),
  ).toBeFocused();
});
test("stale and no sample keep cutoff; joined-after-cutoff is not zero", async ({
  page,
}) => {
  const c = comparisonFixture();
  c.status = "STALE";
  c.inCohort = false;
  for (const m of Object.values(c.metrics)) {
    m.myValue.status = "NOT_APPLICABLE";
    m.myValue.reason = "JOINED_AFTER_CUTOFF";
    m.median = null;
    m.sampleCount = 0;
    m.status = "NO_SAMPLE";
    m.reason = "ZERO_DENOMINATOR";
  }
  c.cohortMemberCount = 0;
  await page.route("**/api/v1/me/statistics", (r) =>
    r.fulfill({ json: { ...personalStatisticsFixture(), comparison: c } }),
  );
  await page.goto("/me?section=statistics");
  const area = page.getByRole("region", {
    name: "일별 중앙값 비교",
    exact: true,
  });
  await expect(area.getByRole("status")).toContainText("갱신 지연");
  await expect(
    area.getByText("가입 전 기준 통계", { exact: true }),
  ).toHaveCount(4);
  await expect(
    area.getByText("표본 없음 (분모 0)", { exact: true }),
  ).toHaveCount(4);
});
test("broken comparison preserves current statistics and can retry", async ({
  page,
}) => {
  let broken = true;
  await page.route("**/api/v1/me/statistics", (r) =>
    r.fulfill({
      json: {
        ...personalStatisticsFixture(),
        comparison: broken ? {} : comparisonFixture(),
      },
    }),
  );
  await page.goto("/me?section=statistics");
  await expect(page.getByRole("alert")).toContainText("비교 응답");
  await expect(page.getByText("0.7개/제출", { exact: true })).toBeVisible();
  broken = false;
  await page.getByRole("button", { name: "비교 통계 다시 불러오기" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("당시 자료 부족", { exact: true })).toHaveCount(
    4,
  );
});
