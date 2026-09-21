import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.route("**/v1/me", async (route) => {
    const response = await route.fetch(),
      row = await response.json();
    await route.fulfill({ json: { ...row, starListVisibility: "PUBLIC" } });
  });
});
test("saves with CSRF and reads persisted PRIVATE after reload; guide never writes onboarding", async ({
  page,
}) => {
  await page.goto("/settings");
  const sent = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/me/settings"),
  );
  await page.getByRole("switch", { name: "내 별 목록 공개" }).click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ starListVisibility: "PRIVATE" });
  expect(request.headers()["x-csrf-token"]).toBeTruthy();
  await expect(
    page.getByText("공개 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  await page.unroute("**/v1/me");
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "내 별 목록 공개" }),
  ).not.toBeChecked();
  const writes: string[] = [];
  page.on("request", (r) => {
    if (!["GET", "HEAD"].includes(r.method())) writes.push(r.url());
  });
  await page.getByRole("button", { name: "사용법 다시 보기" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(writes).toEqual([]);
});
test("lost response rechecks current server value once without repeating PATCH", async ({
  page,
}) => {
  await page.goto("/settings");
  let writes = 0;
  await page.route("**/v1/me/settings", async (route) => {
    writes++;
    await route.fetch();
    await page.unroute("**/v1/me");
    await route.abort("failed");
  });
  await page.getByRole("switch", { name: "내 별 목록 공개" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "현재 설정이 선택한 값과 일치" }),
  ).toBeVisible();
  expect(writes).toBe(1);
});
test("rejected write restores authoritative switch and reports failure", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.route("**/v1/me/settings", (route) =>
    route.fulfill({
      status: 400,
      json: { code: "VALIDATION_FAILED", message: "확인" },
    }),
  );
  await page.getByRole("switch", { name: "내 별 목록 공개" }).click();
  await expect(page.getByRole("alert")).toContainText("저장되지 않았습니다");
  await expect(
    page.getByText("현재 설정: 공개", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "내 별 목록 공개" }),
  ).toBeChecked();
});
test("missing visibility is an error, not an inferred PUBLIC setting", async ({
  page,
}) => {
  await page.route("**/v1/me", async (route) => {
    const response = await route.fetch(),
      row = await response.json();
    delete row.starListVisibility;
    await route.fulfill({ json: row });
  });
  await page.goto("/settings");
  await expect(page.getByRole("alert")).toContainText(
    "설정을 불러오지 못했습니다",
  );
  await expect(
    page.getByRole("switch", { name: "내 별 목록 공개" }),
  ).toHaveCount(0);
});
test("pending save disables repeated toggles", async ({ page }) => {
  await page.goto("/settings");
  let release!: () => void,
    writes = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/v1/me/settings", async (route) => {
    writes++;
    await gate;
    await route.continue();
  });
  const toggle = page.getByRole("switch", { name: "내 별 목록 공개" });
  await toggle.click();
  await expect(toggle).toBeDisabled();
  release();
  await expect(
    page.getByText("공개 설정을 저장했습니다.", { exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
});
test("unknown outcome with failed verification disables save until explicit read", async ({
  page,
}) => {
  await page.goto("/settings");
  let writes = 0;
  await page.route("**/v1/me/settings", async (route) => {
    writes++;
    await page.route("**/v1/me", (r) =>
      r.fulfill({ status: 503, json: { code: "DEPENDENCY_UNAVAILABLE" } }),
    );
    await route.abort("failed");
  });
  await page.getByRole("switch", { name: "내 별 목록 공개" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "저장 여부를 확인할 수 없습니다",
  );
  await expect(
    page.getByRole("switch", { name: "내 별 목록 공개" }),
  ).toHaveCount(0);
  await page.unroute("**/v1/me");
  await page.getByRole("button", { name: "설정 다시 확인" }).click();
  await expect(page.getByText(/현재 설정: (공개|비공개)/)).toBeVisible();
  expect(writes).toBe(1);
});
test("401 during saving removes private settings and returns to login", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.route("**/v1/me/settings", (route) =>
    route.fulfill({ status: 401, json: { code: "UNAUTHORIZED" } }),
  );
  await page.getByRole("switch", { name: "내 별 목록 공개" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole("heading", { name: "설정", exact: true }),
  ).toHaveCount(0);
});
