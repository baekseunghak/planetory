import { test, expect } from "@playwright/test";
test("unapproved policy cannot offer an execution control", async ({
  page,
}) => {
  await page.route("**/api/v1/me/withdrawal-policy", (r) =>
    r.fulfill({
      json: { available: false, reason: "탈퇴 정책을 준비하고 있습니다." },
    }),
  );
  await page.goto("/settings/withdrawal");
  await expect(page.getByRole("status")).toContainText("준비");
  await expect(page.getByRole("button", { name: "탈퇴 신청" })).toHaveCount(0);
});
test("lost confirmation response is recovered by read-only receipt, never repeats the destructive request", async ({
  page,
}) => {
  let confirmations = 0;
  await page.route(
    "**/api/v1/me/withdrawal-requests/test-request/confirm",
    async (r) => {
      confirmations++;
      await r.fetch();
      await r.abort();
    },
  );
  await page.goto("/settings/withdrawal");
  const submit = page.getByRole("button", { name: "탈퇴 신청" });
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("textbox", { name: "확인을 위해" }).fill("탈퇴");
  await submit.click();
  await expect(page.getByRole("alert")).toContainText(
    "결과를 확인하지 못했습니다",
  );
  await expect(submit).toBeDisabled();
  await page.getByRole("link", { name: "탈퇴 처리 상태 확인" }).click();
  await expect(
    page.getByRole("heading", { name: "탈퇴가 완료되었습니다" }),
  ).toBeVisible();
  expect(confirmations).toBe(1);
  await page.goto("/sky");
  await expect(page).toHaveURL(/\/login/);
});
test("session expiry does not cancel a slower receipt status read", async ({
  page,
}) => {
  let receiptStarted!: () => void,
    sessionExpired!: () => void;
  const receiptPending = new Promise<void>((resolve) => (receiptStarted = resolve));
  const expired = new Promise<void>((resolve) => (sessionExpired = resolve));
  await page.route("**/api/v1/withdrawal-requests/receipt-after-logout", async (route) => {
    receiptStarted();
    await expired;
    await route.fulfill({
      json: {
        requestId: "receipt-after-logout",
        status: "COMPLETED",
        message: "탈퇴 처리가 완료되었습니다.",
        effectiveAt: "2026-09-23T00:00:00Z",
      },
    });
  });
  await page.route("**/api/v1/me", async (route) => {
    await receiptPending;
    await route.fulfill({
      status: 401,
      json: { code: "UNAUTHENTICATED", message: "세션 종료" },
    });
    sessionExpired();
  });
  await page.goto("/withdrawal/status/receipt-after-logout");
  await expect(
    page.getByRole("heading", { name: "탈퇴가 완료되었습니다" }),
  ).toBeVisible();
});
