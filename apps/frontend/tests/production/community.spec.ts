import { test, expect } from "@playwright/test";

const member = {
  memberId: "u-production-209",
  nickname: "운영 화면 검사",
  onboardingDone: true,
  tutorialCompleted: true,
};
test("built community route calls API, distinguishes empty/error and has no demo data", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) => route.fulfill({ json: member }));
  await page.route("**/api/v1/community/feed?*", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null, hasNext: false } }),
  );
  await page.goto("/community");
  await expect(
    page.getByText("아직 게시글이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("community-fixture-notice")).toHaveCount(0);
  await page.unroute("**/api/v1/community/feed?*");
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "서버 연결이 아직 준비되지 않았습니다.",
  );
  await expect(page.locator(".community-feed > li")).toHaveCount(0);
});

test("built thread uses parent/analyses/comments contracts and handles N=0", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === "/api/v1/me") return route.fulfill({ json: member });
    if (path === "/api/v1/signal-threads/st-1")
      return route.fulfill({
        json: {
          threadId: "st-1",
          ticId: "1",
          candidateId: "c-1",
          title: "배포 코드 공식 스레드",
          author: { type: "SYSTEM", displayName: "SYSTEM" },
          judgmentSummary: {
            participantCount: 0,
            likelyPlanet: 0,
            unlikelyPlanet: 0,
            unsure: 0,
            percentages: null,
            asOf: "2026-09-18T01:00:00Z",
          },
        },
      });
    if (
      ["/api/v1/signal-threads/st-1/analyses", "/api/v1/comments"].includes(
        path,
      )
    )
      return route.fulfill({
        json: { items: [], nextCursor: null, hasNext: false },
      });
    return route.continue();
  });
  await page.goto("/signal-threads/st-1");
  await expect(
    page.getByRole("heading", { name: "배포 코드 공식 스레드" }),
  ).toBeVisible();
  await expect(
    page.getByText("아직 공개된 분석이 없습니다.", { exact: true }),
  ).toBeVisible();
  expect(requests).toContain("/api/v1/signal-threads/st-1/analyses");
  expect(requests).toContain("/api/v1/comments");
  await expect(page.getByTestId("community-fixture-notice")).toHaveCount(0);
});
