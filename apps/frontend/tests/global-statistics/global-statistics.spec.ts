import { test, expect } from "@playwright/test";
import {
  globalStatisticsFixture,
  unavailableGlobalStatistics,
} from "../fixtures/global-statistics";

test("global source values, eight weeks, keyboard links and 1024px layout", async ({
  page,
}) => {
  await page.route("**/api/v1/statistics", (r) =>
    r.fulfill({ json: globalStatisticsFixture() }),
  );
  await page.goto("/statistics");
  await expect(
    page.getByRole("heading", { name: "전체 탐사 통계", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("66.7%").first()).toBeVisible();
  const weeks = page.getByRole("region", { name: "8주 제출 추이" });
  await expect(weeks.getByRole("row")).toHaveCount(9);
  await expect(weeks).toContainText("진행 중 · 기준 시각까지");
  await expect(
    page.getByText(/후보별 최신 AI 시도를 확인할 원천/),
  ).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await weeks.focus();
  await expect(weeks).toBeFocused();
  await page.screenshot({
    path: "test-results/global-statistics-1024.png",
    fullPage: true,
  });
  const link = page.getByRole("link", { name: "TIC 259377024", exact: true });
  await expect(link).toHaveAttribute("href", "/community/stars/259377024");
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/community\/stars\/259377024$/);
});

test("expired authentication removes global statistics", async ({ page }) => {
  let expired = false;
  await page.route("**/api/v1/statistics", (r) =>
    r.fulfill(
      expired
        ? { status: 401, json: { code: "UNAUTHORIZED", message: "expired" } }
        : { json: globalStatisticsFixture() },
    ),
  );
  await page.goto("/statistics");
  await expect(page.getByText("30개", { exact: true })).toBeVisible();
  expired = true;
  await page.getByRole("button", { name: "통계 새로고침" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("30개", { exact: true })).toHaveCount(0);
});
test("stale keeps original timestamps and counts", async ({ page }) => {
  const f = globalStatisticsFixture();
  f.global.status = "STALE";
  f.global.reason = "REFRESH_DELAYED";
  await page.route("**/api/v1/statistics", (r) => r.fulfill({ json: f }));
  await page.goto("/statistics");
  await expect(page.getByRole("status")).toContainText("갱신 지연");
  await expect(page.locator("time").first()).toHaveAttribute(
    "datetime",
    f.global.asOf,
  );
  await expect(page.getByText("30개", { exact: true })).toBeVisible();
});
test("unavailable is not zero; a later empty success has explicit zero and no sample", async ({
  page,
}) => {
  let ready = false;
  await page.route("**/api/v1/statistics", (r) =>
    r.fulfill({
      json: ready
        ? globalStatisticsFixture(true)
        : unavailableGlobalStatistics(),
    }),
  );
  await page.goto("/statistics");
  await expect(page.getByRole("status")).toContainText("통계 준비 중");
  await expect(page.locator("time")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  ready = true;
  await page.getByRole("button", { name: "통계 새로고침" }).click();
  await expect(page.getByText("0개", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("표본 없음 (분모 0)").first()).toBeVisible();
  await expect(page.getByText("집계할 공개 원글이 없습니다.")).toBeVisible();
});
test("failure retries using only GET, and clears successful data on subsequent failure", async ({
  page,
}) => {
  let fail = true;
  const methods: string[] = [];
  await page.route("**/api/v1/statistics", (r) => {
    methods.push(r.request().method());
    expect(new URL(r.request().url()).search).toBe("");
    return r.fulfill(
      fail
        ? {
            status: 503,
            json: { code: "DEPENDENCY_UNAVAILABLE", message: "unavailable" },
          }
        : { json: globalStatisticsFixture() },
    );
  });
  await page.goto("/statistics");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert").getByRole("button")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "통계 다시 불러오기" }).click();
  await expect(page.getByText("30개", { exact: true })).toBeVisible();
  fail = true;
  await page.getByRole("button", { name: "통계 새로고침" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("30개", { exact: true })).toHaveCount(0);
  expect(methods.every((m) => m === "GET")).toBe(true);
});
test("loading can be left and malformed data never appears as a successful zero", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/statistics", async (r) => {
    await gate;
    await r.fulfill({ json: globalStatisticsFixture() }).catch(() => {});
  });
  await page.goto("/statistics");
  await expect(page.getByRole("status")).toContainText("불러오고");
  await page.goto("/me");
  release();
  await expect(
    page.getByRole("heading", { name: "전체 탐사 통계" }),
  ).toHaveCount(0);
  await page.unroute("**/api/v1/statistics");
  await page.route("**/api/v1/statistics", (r) =>
    r.fulfill({ json: { global: { status: "READY" } } }),
  );
  await page.goto("/statistics");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});
