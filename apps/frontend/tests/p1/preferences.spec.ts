import { test, expect } from "@playwright/test";
test("settings is reached through profile; preference patch changes one field and survives reload", async ({
  page,
}) => {
  await page.goto("/me");
  await page
    .locator(".profile-actions")
    .getByRole("link", { name: "설정", exact: true })
    .click();
  const toggle = page.getByRole("switch", { name: "팔로우 소식 알림" });
  await expect(toggle).toBeChecked();
  const sent = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/notification-settings"),
  );
  await toggle.click();
  expect((await sent).postDataJSON()).toEqual({
    preferences: { FOLLOW: false },
  });
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByRole("switch", { name: "내 글의 댓글 알림" }),
  ).toBeChecked();
  await page.getByRole("switch", { name: "내 은하·별 목록 공개" }).click();
  await expect(
    page.getByRole("switch", { name: "내 은하·별 목록 공개" }),
  ).not.toBeChecked();
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "내 은하·별 목록 공개" }),
  ).not.toBeChecked();
});
