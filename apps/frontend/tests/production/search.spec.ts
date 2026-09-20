import { test, expect } from "@playwright/test";
test("built search passes literal filters to real API path without fixture fallback", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        memberId: "u-search",
        nickname: "검증",
        onboardingDone: true,
        tutorialCompleted: true,
      },
    }),
  );
  await page.route("**/api/v1/community/feed?**", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null, hasNext: false } }),
  );
  await page.goto(
    "/community?author=Orbit&board=STAR&tag=QUESTION&ticId=259377017",
  );
  await page
    .getByRole("searchbox", { name: "검색어", exact: true })
    .fill("10%_");
  const request = page.waitForRequest(
    (r) =>
      r.url().includes("community/feed?") &&
      new URL(r.url()).searchParams.get("q") === "10%_",
  );
  await page.getByRole("button", { name: "검색", exact: true }).click();
  expect(
    Object.fromEntries(new URL((await request).url()).searchParams),
  ).toEqual({
    q: "10%_",
    searchIn: "TITLE_BODY",
    author: "Orbit",
    ticId: "259377017",
    board: "STAR",
    tag: "QUESTION",
    size: "20",
  });
  await expect(page.getByText(/검색 조건에 맞는 글이 없습니다/)).toBeVisible();
  await expect(page.getByTestId("community-fixture-notice")).toHaveCount(0);
  await page.unroute("**/api/v1/community/feed?**");
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "서버 연결이 아직 준비되지 않았습니다",
  );
  await expect(page.locator(".community-feed > li")).toHaveCount(0);
});
