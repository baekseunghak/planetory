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

test("production sky consumes metadata without bundling the inspector or fake backend", async ({
  page,
  request,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        memberId: "prod-sky-test",
        nickname: "검증",
        onboardingDone: true,
        tutorialCompleted: true,
      },
    }),
  );
  await page.route("**/api/v1/me/sky", (route) =>
    route.fulfill({
      json: {
        representation: "individual-stars",
        layoutVersion: "personal-spiral-v1",
        presentationVersion: "personal-galaxy-v1",
        version: "prod:1",
        starCount: 1,
        bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
        tileSize: 512,
        zoomLevels: [0.25, 0.5, 1, 2, 4].map((scale, level) => ({
          level,
          scale,
        })),
        centerTicIds: ["001"],
        firstVisit: false,
      },
    }),
  );
  await page.goto("/sky");
  await expect(page.getByTestId("sky-total")).toHaveText("1");
  await expect(
    page.getByText(
      "지도 데이터를 준비했습니다. 지도 시각화 연결을 준비하고 있습니다.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel("배율 단계")).toHaveCount(0);
  await expect(
    page.getByText("개발 응답 시나리오", { exact: true }),
  ).toHaveCount(0);
  expect((await request.post("/api/dev-sky-203/change")).status()).toBe(503);
});
