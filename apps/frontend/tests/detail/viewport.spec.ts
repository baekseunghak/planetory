import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request, page }) => {
  await request.post("/api/dev-galaxy-204/reset?count=1000");
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("viewport shrink and full-page capture preserve the same canvas, selected planet and return camera", async ({
  page,
}) => {
  await page.goto("/sky");
  const canvas = page.locator(".galaxy-scene canvas");
  const panel = page.getByRole("complementary", { name: "별 상세" });
  const readCamera = async () =>
    JSON.parse((await canvas.getAttribute("data-camera"))!);
  await expect(canvas).toHaveAttribute("data-rendered-stars", "1000");
  const original = await canvas.elementHandle();
  await canvas.focus();
  await canvas.press("Shift+ArrowRight");
  await canvas.press("ArrowLeft");
  const before = await readCamera();
  await page.locator('.galaxy-marker[data-marker="1"]').click();
  await expect(panel).toContainText("내 행성 5개");
  await expect.poll(async () => (await readCamera()).zoom).toBe(4);
  await panel
    .getByRole("button", { name: "행성 2 fixture-204-p-1", exact: true })
    .click();
  await expect(canvas).toHaveAttribute(
    "data-focused-planet",
    "fixture-204-p-1",
  );
  const focused = await readCamera();

  // Chromium full-page capture can transiently report a 1×1 viewport. A real
  // narrow-window resize must also hide the UI without throwing away its state.
  for (const size of [
    { width: 1, height: 1 },
    { width: 767, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.locator(".desktop-notice")).toBeVisible();
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(canvas).toBeHidden();
    await expect(page.getByRole("link", { name: /분석 시작/ })).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(panel).toContainText("5.25일");
    await expect(canvas).toHaveAttribute(
      "data-focused-planet",
      "fixture-204-p-1",
    );
    expect(await readCamera()).toEqual(focused);
    await page.screenshot({ fullPage: true });
    await expect(panel).toBeVisible();
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  }
  await panel.getByRole("button", { name: "별지도" }).click();
  await expect(panel).toHaveCount(0);
  expect(await readCamera()).toEqual(before);
});

test("initial narrow viewport defers the sky; session expiry still clears a retained hidden sky", async ({
  page,
}) => {
  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto("/sky");
  await expect(page.locator(".desktop-notice")).toBeVisible();
  await expect(page.locator(".galaxy-scene canvas")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".galaxy-scene canvas")).toHaveAttribute(
    "data-rendered-stars",
    "1000",
  );
  await page.locator('.galaxy-marker[data-marker="1"]').click();
  await expect(
    page.getByRole("complementary", { name: "별 상세" }),
  ).toContainText("내 행성 5개");
  await page.setViewportSize({ width: 767, height: 900 });
  await expect(page.locator(".desktop-notice")).toBeVisible();
  await page.route("**/api/v1/me/stars/900000002", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "UNAUTHENTICATED", message: "세션이 만료되었습니다." },
    }),
  );
  await page.evaluate(async () => {
    const modulePath = "/src/api/index.ts";
    const { http } = await import(modulePath);
    await http.request("/v1/me/stars/900000002").catch(() => {});
  });
  await expect(page.locator(".galaxy-scene canvas")).toHaveCount(0);
  await expect(page.locator(".star-detail")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다", exact: true }),
  ).toBeVisible();
});
