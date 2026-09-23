import { test, expect } from "@playwright/test";
test("built hot topics uses authenticated S18, keeps server order and has no fixture fallback", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        memberId: "u-hot-production",
        nickname: "검증",
        onboardingDone: true,
        tutorialCompleted: true,
      },
    }),
  );
  const path = "**/api/v1/community/hot-topics?*";
  await page.route(path, (route) =>
    route.fulfill({
      json: {
        items: [10, 11].map((n, i) => ({
          type: "SIGNAL_THREAD",
          id: String(i + 1),
          ticId: "259377017",
          title: `운영 코드 신호 ${i + 1}`,
          author: { type: "SYSTEM", displayName: "SYSTEM" },
          createdAt: "2026-09-20T00:00:00Z",
          commentCount: 0,
          judgmentSummary: {
            participantCount: n,
            likelyPlanet: n - 6,
            unlikelyPlanet: 3,
            unsure: 3,
          },
        })),
        nextCursor: null,
        hasNext: false,
      },
    }),
  );
  await page.goto("/community/hot-topics");
  await expect(page.locator(".community-feed h2 a")).toHaveText([
    "운영 코드 신호 1",
    "운영 코드 신호 2",
  ]);
  await expect(page.getByTestId("community-fixture-notice")).toHaveCount(0);
  await page.unroute(path);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "서버 연결이 아직 준비되지 않았습니다",
  );
  await expect(page.locator(".community-feed > li")).toHaveCount(0);
});
