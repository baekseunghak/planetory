import { test, expect } from "@playwright/test";
import { personalStatisticsFixture } from "../fixtures/personal-statistics";
test("loading can be left safely and another profile never requests personal statistics", async ({
  page,
}) => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/me/statistics", async (route) => {
    calls++;
    await gate;
    await route.fulfill({ json: personalStatisticsFixture() }).catch(() => {});
  });
  await page.goto("/me?section=statistics");
  await expect(
    page.getByRole("status").filter({ hasText: "내 탐사 통계" }),
  ).toBeVisible();
  await page.goto("/members/u-211?section=statistics");
  release();
  await expect(
    page.getByRole("heading", { name: "다른탐사자", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "내 탐사 통계" })).toHaveCount(
    0,
  );
  // StrictMode can start and abort an extra read in development.
  expect(calls).toBeGreaterThan(0);
  calls = 0;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "다른탐사자", exact: true }),
  ).toBeVisible();
  expect(calls).toBe(0);
});
test("permission and malformed response do not display values", async ({
  page,
}) => {
  await page.route("**/api/v1/me/statistics", (r) =>
    r.fulfill({ status: 403, json: { code: "FORBIDDEN", message: "denied" } }),
  );
  await page.goto("/me?section=statistics");
  await expect(page.getByRole("alert")).toContainText("접근 권한");
  await page.unroute("**/api/v1/me/statistics");
  await page.route("**/api/v1/me/statistics", (r) =>
    r.fulfill({ json: { current: { status: "READY" } } }),
  );
  await page.getByRole("button", { name: "통계 다시 불러오기" }).click();
  await expect(page.getByRole("alert")).toContainText("불러오지 못했습니다");
  await expect(page.getByRole("table")).toHaveCount(0);
});
test("personal slot shows source values, eight weeks and accessible evidence without comparison", async ({
  page,
}) => {
  await page.route("**/api/v1/me/statistics", (r) =>
    r.fulfill({ json: personalStatisticsFixture() }),
  );
  await page.goto("/me?section=statistics");
  await expect(
    page.getByRole("heading", { name: "내 탐사 통계" }),
  ).toBeVisible();
  await expect(page.getByText("당시 기록 부족", { exact: true })).toBeVisible();
  await expect(page.getByText("0.7개/제출", { exact: true })).toBeVisible();
  const weeks = page.getByRole("region", { name: "8주 추이 표" });
  await expect(weeks.getByRole("row")).toHaveCount(9);
  await expect(weeks).toContainText("2026-09-21");
  await expect(
    page.getByRole("region", { name: "근거 통계 표" }),
  ).toContainText("홀짝 깊이");
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await weeks.focus();
  await expect(weeks).toBeFocused();
});
test("empty data is not a request error and percentages are not fabricated", async ({
  page,
}) => {
  await page.route("**/api/v1/me/statistics", (r) =>
    r.fulfill({ json: personalStatisticsFixture(true) }),
  );
  await page.goto("/me?section=statistics");
  await expect(page.getByText(/아직 탐사 제출 기록이 없습니다/)).toBeVisible();
  await expect(page.getByText("표본 없음 (분모 0)").first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("failure retries with read only and discards old values", async ({
  page,
}) => {
  let fail = true;
  const methods: string[] = [];
  await page.route("**/api/v1/me/statistics", (r) => {
    methods.push(r.request().method());
    return r.fulfill(
      fail
        ? {
            status: 503,
            json: { code: "DEPENDENCY_UNAVAILABLE", message: "unavailable" },
          }
        : { json: personalStatisticsFixture() },
    );
  });
  await page.goto("/me?section=statistics");
  await expect(page.getByRole("alert")).toContainText(
    "통계를 불러오지 못했습니다",
  );
  fail = false;
  await page.getByRole("button", { name: "통계 다시 불러오기" }).click();
  await expect(
    page.getByRole("heading", { name: "내 탐사 통계" }),
  ).toBeVisible();
  expect(methods.every((m) => m === "GET")).toBe(true);
  fail = true;
  await page.getByRole("button", { name: "통계 새로고침" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("0.7개/제출", { exact: true })).toHaveCount(0);
});
