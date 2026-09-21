import { test, expect } from "@playwright/test";
test("notification opens a currently accessible target and marks it read via HTTP", async ({
  page,
}) => {
  await page.goto("/notifications");
  await expect(
    page.getByRole("link", { name: "알림 · 안 읽은 소식 2개", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /지금은 확인할 수 없는 소식/ }),
  ).toBeDisabled();
  const patch = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/v1/me/notifications/n-comment") &&
      r.method() === "PATCH",
  );
  await page.getByRole("button", { name: /탐사 기록에 새 댓글/ }).click();
  await patch;
  await expect(page).toHaveURL(/posts\/p-201\?returnTo=%2Fnotifications/);
  await page.goto("/notifications?filter=unread");
  await expect(page.locator(".notifications-list>li")).toHaveCount(1);
  await page.getByRole("button", { name: "모두 읽음", exact: true }).click();
  await expect(
    page.getByText("읽지 않은 알림이 없습니다.", { exact: true }),
  ).toBeVisible();
});
test("revoked target never navigates and never exposes cached content on refresh", async ({
  page,
}) => {
  await page.route("**/api/v1/me/notifications/n-achievement/target", (r) =>
    r.fulfill({
      json: { notificationId: "n-achievement", available: false, target: null },
    }),
  );
  await page.goto("/notifications");
  await page.getByRole("button", { name: /새로운 성과가 인정/ }).click();
  await expect(page.getByRole("status")).toContainText(
    "지금은 해당 소식을 확인할 수 없습니다.",
  );
  await expect(page).toHaveURL(/\/notifications$/);
});
