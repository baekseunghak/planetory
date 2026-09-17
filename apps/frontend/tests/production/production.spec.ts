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

test("production login uses agreed backend provider paths and has no development OAuth", async ({
  page,
  request,
}) => {
  const destinations: string[] = [];
  await page.route("**/oauth2/authorization/*", (route) => {
    destinations.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: "text/html", body: "Provider entry" });
  });
  for (const [provider, path] of [
    ["SSAFY", "ssafy"],
    ["Google", "google"],
  ]) {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "회원 정보를 확인하지 못했습니다" }),
    ).toBeVisible();
    const login = page.getByRole("button", {
      name: `${provider} 계정으로 로그인`,
      exact: true,
    });
    await expect(login).toBeEnabled();
    await login.click();
    await expect(page).toHaveURL(new RegExp(`/oauth2/authorization/${path}$`));
  }
  expect(destinations).toEqual([
    "/oauth2/authorization/ssafy",
    "/oauth2/authorization/google",
  ]);
  expect(
    (
      await request.get("/api/dev-auth-202/google", { maxRedirects: 0 })
    ).status(),
  ).toBe(503);
});
