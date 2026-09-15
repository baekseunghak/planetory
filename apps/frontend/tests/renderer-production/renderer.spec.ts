import { test, expect } from "@playwright/test";
const metadata = {
  version: "production-contract-test:1",
  starCount: 1,
  bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  tileSize: 512,
  zoomLevels: [0.25, 0.5, 1, 2, 4].map((scale, level) => ({
    level,
    scale,
    clustered: level < 2,
  })),
  centerTicIds: ["001"],
  overview: [
    {
      nodeId: "root",
      x: 0,
      y: 0,
      count: 1,
      counts: { planet: 0, done: 0, new: 1 },
      bounds: { x: -256, y: -256, w: 512, h: 512 },
    },
  ],
  firstVisit: false,
};
test("enabled production build consumes HTTP metadata but has no fixture controls or endpoints", async ({
  page,
  request,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        memberId: "production-test-only",
        nickname: "검증",
        onboardingDone: true,
        tutorialCompleted: true,
      },
    }),
  );
  await page.route("**/api/v1/me/sky", (route) =>
    route.fulfill({ json: metadata }),
  );
  await page.goto("/sky");
  await expect(
    page.getByRole("img", {
      name: "발견한 별과 서버 성운 군집으로 그린 은하 지도",
    }),
  ).toBeVisible();
  await expect(page.getByTestId("sky-total")).toHaveText("1");
  await expect(
    page.getByText("204 렌더 검증 도구", { exact: true }),
  ).toHaveCount(0);
  expect((await request.post("/api/dev-galaxy-204/change")).status()).toBe(503);
  await page.getByText("별과 성운 읽기", { exact: true }).click();
  await expect(
    page.getByText("내 행성 4개 이상", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/renderer-production/enabled-renderer.png",
  });
});
test("expired session removes the private canvas; missing API never creates a galaxy", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        memberId: "production-test-only",
        nickname: "검증",
        onboardingDone: true,
        tutorialCompleted: true,
      },
    }),
  );
  await page.route("**/api/v1/me/sky", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "UNAUTHENTICATED", message: "로그인 필요" },
    }),
  );
  await page.goto("/sky");
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page).toHaveURL(/\/login/);
});
