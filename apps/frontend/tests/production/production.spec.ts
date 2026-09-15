import { test, expect } from "@playwright/test";

test("an unconfigured production preview has no automatic fixture identity", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/v1/me");
  expect(response.status()).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "DEPENDENCY_UNAVAILABLE",
  });
  await page.goto("/sky");
  await expect(page.getByRole("alert")).toContainText(
    "서버 연결이 아직 준비되지 않았습니다",
  );
  await expect(page.getByText("연결 확인 계정", { exact: true })).toHaveCount(
    0,
  );
});
test("the built app retains routes/identity but contains no development page or accounts screen", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        memberId: "production-test-only",
        nickname: "테스트 응답",
        onboardingDone: true,
        tutorialCompleted: false,
      },
    }),
  );
  await page.goto("/analysis/259377017?returnTo=%2Fcommunity%3Fq%3Dtest");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "분석", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("TIC 259377017", { exact: true })).toBeVisible();
  await expect(page.getByText(/개발 전용 테스트 응답입니다/)).toHaveCount(0);
  await page.getByRole("link", { name: "이전 화면으로", exact: true }).click();
  await expect(page).toHaveURL(/\/community\?q=test$/);
  await page.goto("/accounts");
  await expect(
    page.getByRole("heading", { name: "페이지를 찾을 수 없습니다" }),
  ).toBeVisible();
});
