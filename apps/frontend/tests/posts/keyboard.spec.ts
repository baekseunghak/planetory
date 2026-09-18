import { test, expect } from "@playwright/test";
test("native keyboard input reaches controlled state and submitted post", async ({
  page,
}) => {
  await page.goto("/posts/new");
  await page.locator("#post-title").pressSequentially("New observation");
  await expect(page.locator("#post-title-help")).toContainText("15 / 100");
  await page.locator("#post-body").pressSequentially("Observed light curve.");
  await page.getByRole("button", { name: "게시하기", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "New observation", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".community-post-body")).toHaveText(
    "Observed light curve.",
  );
});
