import { test, expect } from "@playwright/test";
test("built profile uses HTTP identity, includes guide assets, and does not invent save success", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        memberId: "prod-profile",
        nickname: "운영검사",
        role: "MEMBER",
        onboardingDone: true,
        tutorialCompleted: true,
        starListVisibility: "PUBLIC",
        achievementSummary: {
          discoveredStarCount: 83,
          completedStarCount: 7,
          signalCount: 11,
          byType: { confirmed: 8, unconfirmed: 2, fp: 1 },
          starCountByGrade: { A: 5, S: 1, SS: 1, SSS: 0 },
        },
      },
    }),
  );
  await page.goto("/me");
  await expect(
    page.getByRole("heading", { name: "운영검사", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".profile-summary")).toContainText("83");
  await expect(page.getByTestId("community-fixture-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "사용법 다시 보기" }).click();
  await expect
    .poll(() =>
      page
        .getByRole("dialog")
        .locator("img")
        .evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "닉네임 변경" }).click();
  await page.getByRole("textbox", { name: "새 닉네임" }).fill("저장검사");
  await page.getByRole("button", { name: "닉네임 저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "서버 연결이 아직 준비되지 않았습니다",
  );
  await expect(page.getByRole("textbox", { name: "새 닉네임" })).toHaveValue(
    "저장검사",
  );
});
