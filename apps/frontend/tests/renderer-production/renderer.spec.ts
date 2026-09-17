import { test, expect } from "@playwright/test";
const metadata = {
  representation: "individual-stars",
  layoutVersion: "personal-spiral-v1",
  presentationVersion: "personal-galaxy-v1",
  version: "production-contract-test:1",
  starCount: 1,
  bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  tileSize: 512,
  zoomLevels: [{ level: 0, scale: 1 }],
  centerTicIds: ["001"],
  firstVisit: false,
};
test("enabled production build consumes individual HTTP pages but excludes fixture controls and endpoints", async ({
  page,
  request,
}) => {
  await page.route("**/api/v1/me", (r) =>
    r.fulfill({
      json: {
        memberId: "production-test-only",
        nickname: "검증",
        onboardingDone: true,
        tutorialCompleted: true,
      },
    }),
  );
  await page.route("**/api/v1/me/sky", (r) => r.fulfill({ json: metadata }));
  await page.route("**/api/v1/me/sky/tiles?*", (r) => {
    const q = new URL(r.request().url()).searchParams;
    const x = Number(q.get("x")),
      y = Number(q.get("y")),
      w = Number(q.get("w")),
      h = Number(q.get("h"));
    const contains = x <= 0 && x + w > 0 && y <= 0 && y + h > 0;
    return r.fulfill({
      json: {
        representation: "individual-stars",
        version: metadata.version,
        level: 0,
        versionChanged: false,
        bounds: { x, y, w, h },
        rangeStarCount: contains ? 1 : 0,
        nextCursor: null,
        stars: contains
          ? [
              {
                ticId: "001",
                x: 0,
                y: 0,
                depthZ: 0,
                layoutOrdinal: 0,
                planetCount: 0,
                progressStage: "unexplored",
                completedWithoutPlanets: false,
                marker: null,
                reopened: false,
              },
            ]
          : [],
      },
    });
  });
  await page.goto("/sky");
  await expect(
    page.getByRole("img", {
      name: "내가 발견한 개별 별로 이루어진 3D 은하 지도",
    }),
  ).toBeVisible();
  await expect(page.getByTestId("visible-count")).toHaveText("적재 1 · 화면 1");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("204 렌더 검증 도구", { exact: true }),
  ).toHaveCount(0);
  for (const url of [
    "/api/dev-galaxy-204/change",
    "/api/dev-legacy-galaxy-204/dev-galaxy-204/comparison",
  ])
    expect((await request.get(url)).status()).toBe(503);
  await page.getByText("별지도 읽기", { exact: true }).click();
  await expect(
    page.getByText(
      "금빛 중심과 푸른 별빛은 은하를 표현하는 색입니다. 행성 수나 탐색 성과를 뜻하지 않습니다.",
    ),
  ).toBeVisible();
});
test("expired session removes the private canvas and missing API never creates stars", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (r) =>
    r.fulfill({
      json: {
        memberId: "production-test-only",
        nickname: "검증",
        onboardingDone: true,
        tutorialCompleted: true,
      },
    }),
  );
  await page.route("**/api/v1/me/sky", (r) =>
    r.fulfill({
      status: 401,
      json: { code: "UNAUTHENTICATED", message: "로그인 필요" },
    }),
  );
  await page.goto("/sky");
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page).toHaveURL(/\/login/);
});
