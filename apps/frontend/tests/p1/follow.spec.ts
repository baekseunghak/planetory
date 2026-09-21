import { test, expect } from "@playwright/test";
test("follow/unfollow uses HTTP and profile counters are server-derived", async ({
  page,
}) => {
  await page.goto("/members/u-211");
  const button = page.getByRole("button", { name: "팔로우", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    page.getByRole("button", { name: "팔로잉", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("팔로우 요약")).toContainText("팔로워 1");
  await page.getByRole("button", { name: "팔로잉", exact: true }).click();
  await expect(button).toBeEnabled();
  await expect(page.getByLabel("팔로우 요약")).toContainText("팔로워 0");
});
test("unknown write outcome blocks another mutation until explicit read", async ({
  page,
}) => {
  await page.goto("/members/u-210");
  let puts = 0;
  await page.route("**/api/v1/me/following/members/u-210", async (route) => {
    if (route.request().method() === "PUT") {
      puts++;
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole("button", { name: "팔로우", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("저장 여부가 불명확");
  await expect(
    page.getByRole("button", { name: "팔로우", exact: true }),
  ).toBeDisabled();
  expect(puts).toBe(1);
  await page.getByRole("button", { name: "상태 다시 확인" }).click();
  await expect(
    page.getByRole("button", { name: "팔로우", exact: true }),
  ).toBeEnabled();
});
test("member and star subscriptions share one feed item, keep origin and management separate", async ({
  page,
}) => {
  await page.goto("/members/u-211");
  await page.getByRole("button", { name: "팔로우", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "팔로잉", exact: true }),
  ).toBeEnabled();
  await page.goto("/community/stars/259377017");
  await page.getByRole("button", { name: "관심 별 등록" }).click();
  await expect(
    page.getByRole("button", { name: "관심 별 해제" }),
  ).toBeEnabled();
  await page.goto("/community/following");
  await expect(page.locator(".community-feed>li")).toHaveCount(1);
  await expect(page.locator(".follow-reason")).toHaveText(
    "팔로우한 탐사자 · 관심 별의 소식",
  );
  await page.locator(".community-feed h2 a").click();
  await expect(page).toHaveURL(/returnTo=%2Fcommunity%2Ffollowing/);
  await page.goto("/me/following?tab=stars");
  await expect(page.locator(".follow-list")).toContainText("TOI-270");
  await page.getByRole("button", { name: "관심 별 해제" }).click();
  await expect(page.locator(".follow-list li")).toHaveCount(0);
});
