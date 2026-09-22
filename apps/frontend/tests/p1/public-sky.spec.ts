import { test, expect } from "@playwright/test";
import { project, exampleStar } from "../../dev/sky-reference/reference.mjs";
test("public canvas selects a stored star and focuses owned planets without personal actions", async ({
  page,
}) => {
  await page.goto("/members/u-211/sky");
  const canvas = page.locator(".galaxy-scene canvas");
  await expect(canvas).toHaveAttribute("data-rendered-stars", "1000");
  const box = (await canvas.boundingBox())!,
    camera = JSON.parse((await canvas.getAttribute("data-camera"))!);
  const point = project(exampleStar(0), camera, box.width, box.height);
  await canvas.click({ position: { x: point.x, y: point.y } });
  const detail = page.getByRole("complementary", { name: "공개 별 상세" });
  await expect(detail).toContainText("공개 행성 2개");
  await detail.getByRole("button", { name: "행성 1", exact: true }).click();
  await expect(detail).toContainText("3.37일");
  await page.screenshot({ path: "test-results/p1/public-planet.png" });
  await detail.getByRole("button", { name: "별지도", exact: false }).click();
  await expect(detail).toHaveCount(0);
  expect(JSON.parse((await canvas.getAttribute("data-camera"))!)).toEqual(
    camera,
  );
});
test("public galaxy loads all owned stars and shows only visitor actions", async ({
  page,
}) => {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) urls.push(r.url());
  });
  await page.goto("/members/u-211/sky");
  await expect(
    page.getByRole("heading", { name: "공개 탐사자의 은하" }),
  ).toBeVisible();
  await expect(page.locator(".galaxy-scene canvas")).toHaveAttribute(
    "data-rendered-stars",
    "1000",
  );
  await page.getByRole("button", { name: "별 목록 보기", exact: true }).click();
  await expect(page.locator(".public-star-list")).toContainText("전체 1,000개");
  await page.getByRole("button", { name: /TIC 900000001 / }).click();
  const detail = page.getByRole("complementary", { name: "공개 별 상세" });
  await expect(detail).toContainText("공개 행성 2개");
  await detail.getByRole("button", { name: "행성 2", exact: true }).click();
  await expect(detail).toContainText("정보 없음");
  await expect(
    page.getByRole("link", { name: /분석 시작|분석 결과/ }),
  ).toHaveCount(0);
  expect(urls.some((url) => /\/me\/(stars|sky|quests)/.test(url))).toBe(false);
  await page.screenshot({ path: "test-results/p1/public-visit.png" });
});
test("public zero planets uses visibility wording in tooltip, keyboard option and detail", async ({ page }) => {
  await page.route("**/api/v1/members/u-211/sky/tiles?*", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.stars = body.stars.map((star: object) => ({...star, planetCount: 0, progressStage: "completed", completedWithoutPlanets: true}));
    await route.fulfill({response, json: body});
  });
  await page.route("**/api/v1/members/u-211/stars/*", async route => {
    const response = await route.fetch();
    await route.fulfill({response, json: {...await response.json(), planets: {count: 0, items: []}}});
  });
  await page.goto("/members/u-211/sky");
  const canvas = page.locator(".galaxy-scene canvas");
  await expect(canvas).toHaveAttribute("data-rendered-stars", "1000");
  await canvas.focus();
  await canvas.press("]");
  await expect(page.getByRole("tooltip")).toContainText("현재 공개할 행성이 없습니다");
  await expect(page.getByRole("option")).toContainText("현재 공개할 행성이 없습니다");
  await expect(page.getByRole("tooltip")).not.toContainText("내 행성 없이 완료");
  await canvas.press("Enter");
  const detail = page.getByRole("complementary", {name: "공개 별 상세"});
  await expect(detail).toContainText("공개 행성 0개");
  await expect(detail).toContainText("개인 탐사 결과와 다를 수 있습니다");
});

test("permission revoked or disconnected clears rendered owner data; late data stays retired", async ({
  page,
}) => {
  await page.goto("/members/u-211/sky");
  await expect(page.locator(".galaxy-scene canvas")).toHaveAttribute(
    "data-rendered-stars",
    "1000",
  );
  await page.route("**/api/v1/members/u-211/sky", (route) =>
    route.fulfill({
      status: 404,
      json: {
        code: "PUBLIC_SKY_NOT_AVAILABLE",
        message: "현재 공개하지 않은 은하입니다.",
      },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("현재 이 은하를 볼 수 없습니다.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".galaxy-scene canvas")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "공개 탐사자의 은하" }),
  ).toHaveCount(0);
});
test("private direct link never renders a galaxy; own visit redirects to own sky", async ({
  page,
}) => {
  await page.goto("/members/private/sky");
  await expect(
    page.getByText("현재 이 은하를 볼 수 없습니다.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".galaxy-scene canvas")).toHaveCount(0);
  await page.goto("/members/u-209/sky");
  await expect(page).toHaveURL(/\/sky$/);
});
