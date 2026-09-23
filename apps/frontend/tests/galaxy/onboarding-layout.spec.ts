import { test, expect } from "@playwright/test";

for (const width of [1280, 1024]) {
  test(`first-visit guide preserves sky canvas during failure and closure at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 768 });
    let done = true;
    let fail = true;
    await page.route("**/api/v1/auth/csrf", (route) =>
      route.fulfill({
        json: {
          headerName: "X-CSRF-TOKEN",
          token: "onboarding-layout-fixture",
        },
      }),
    );
    await page.route("**/api/v1/me", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), onboardingDone: done },
      });
    });
    await page.route("**/api/v1/me/onboarding", (route) =>
      route.fulfill(
        fail
          ? {
              status: 503,
              json: { code: "DEPENDENCY_UNAVAILABLE", message: "unavailable" },
            }
          : { json: { onboardingDone: true } },
      ),
    );
    await page.goto("/sky");
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible();
    const baseline = await canvas.boundingBox();
    const height = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    done = false;
    await page.reload();
    const guide = page.getByRole("complementary", {
      name: "첫 방문 분석 안내",
    });
    await expect(guide).toBeVisible();
    await expect(canvas).toBeVisible();
    expect(await canvas.boundingBox()).toEqual(baseline);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBe(height);
    await guide.getByRole("button", { name: "안내 닫기" }).click();
    await expect(guide.getByRole("alert")).toBeVisible();
    expect(await canvas.boundingBox()).toEqual(baseline);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBe(height);
    const box = await guide.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      width === 1280 ? 800 : 768,
    );
    fail = false;
    const retry = guide.getByRole("button", { name: "안내 완료 다시 저장" });
    await expect(retry).toBeEnabled();
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(guide).toHaveCount(0);
    expect(await canvas.boundingBox()).toEqual(baseline);
    await expect(page.locator("#main-content")).toBeFocused();
  });
}
