import { test, expect, type Page } from "@playwright/test";

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function capture(page: Page, name: string) {
  await page.screenshot({
    path: test.info().outputPath(name + ".png"),
    fullPage: false,
  });
}
test("5000-star viewport, collapsed quests and keyboard return preserve an unobstructed galaxy", async ({
  page,
}) => {
  await page.goto("/sky");
  const canvas = page.locator(".galaxy-scene canvas");
  await expect(canvas).toHaveAttribute("data-rendered-stars", "5000");
  const frame = await canvas.boundingBox();
  expect(frame?.y).toBe(64);
  expect(frame?.height).toBe(836);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    900,
  );
  const toggle = page.getByRole("button", { name: "퀘스트", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.locator(".quest-tutorial summary").click();
  await page.locator(".quest-tutorial button").first().click();
  await expect(
    page.getByRole("complementary", { name: "별 상세" }),
  ).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "은하로 돌아가기" }).click();
  await expect(toggle).toBeFocused();
  const notice = page.getByRole("button", { name: "새 챌린지 안내 닫기" });
  if (await notice.isVisible()) await notice.click();
  await noOverflow(page);
  await capture(page, "01-sky-5000");
});
test("star and own planets keep a separate dock at desktop minimum width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/sky?star=900000001");
  const panel = page.getByRole("complementary", { name: "별 상세" });
  await expect(panel).toContainText("내 행성 5개");
  await expect(page.locator(".galaxy-scene canvas")).toHaveAttribute(
    "data-rendered-planets",
    "5",
  );
  const dock = await panel.boundingBox(),
    canvas = await page.locator(".galaxy-scene canvas").boundingBox();
  expect(dock!.x + dock!.width).toBeLessThanOrEqual(canvas!.x);
  expect(canvas!.height).toBe(836);
  expect(dock!.height).toBe(836);
  const viewSwitch = await page.locator(".sky-view-switch").boundingBox();
  expect(viewSwitch!.x).toBeGreaterThanOrEqual(canvas!.x);
  await page.locator(".planet-list button").first().click();
  await expect(page.locator(".galaxy-scene canvas")).not.toHaveAttribute(
    "data-focused-planet",
    "",
  );
  await noOverflow(page);
  await capture(page, "02-own-planet-1024");
});
test("profile uses real authenticated sky reads and does not show a private preview on another member", async ({
  page,
}) => {
  const reads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/me/sky/tiles")) reads.push(r.url());
  });
  await page.goto("/me");
  const preview = page.getByRole("region", { name: "나의 밤하늘 미리보기" });
  await expect(preview).toContainText("5,000개의 별");
  await expect(preview.getByRole("status")).toHaveCount(0);
  expect(reads.length).toBeGreaterThan(0);
  await expect(
    page.getByRole("heading", { name: "마이페이지", exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await capture(page, "03-profile");
  await page.goto("/members/u-210");
  await expect(preview).toHaveCount(0);
  await expect(page.locator(".galaxy-artwork")).toHaveCount(0);
});
test("community sidebar is separate from results; details retain the same reading layout", async ({
  page,
}) => {
  await page.goto("/community");
  await expect(page.locator(".community-feed > li").first()).toBeVisible();
  await expect(page.locator(".hot-topic-preview-item")).toHaveCount(3);
  const main = await page.locator(".community-main").boundingBox(),
    aside = await page.locator(".community-aside").boundingBox();
  expect(main!.x + main!.width).toBeLessThan(aside!.x);
  await expect(page.locator(".my-sky-preview")).toContainText("5,000개의 별");
  await noOverflow(page);
  await capture(page, "04-community");
  await page.locator(".community-feed h2 a").first().click();
  await expect(page.locator(".community-detail-main")).toBeVisible();
  await noOverflow(page);
  await capture(page, "05-post");
});
test("guide keeps keyboard dismissal and focus; minimum-width pages and mobile gate survive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/me");
  const open = page.getByRole("button", {
    name: "사용법 다시 보기",
    exact: true,
  });
  await open.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog
      .getByRole("navigation", { name: "사용법 안내 단계" })
      .getByRole("button"),
  ).toHaveCount(5);
  await noOverflow(page);
  await capture(page, "06-guide-1024");
  await dialog.press("Escape");
  await expect(open).toBeFocused();
  await page.goto("/community");
  await expect(page.locator(".community-feed > li").first()).toBeVisible();
  await noOverflow(page);
  await page.setViewportSize({ width: 767, height: 900 });
  await expect(page.locator(".desktop-notice")).toBeVisible();
  await expect(page.locator(".community-feed")).toHaveCount(0);
});
test("login artwork is decorative, with no private sky requests or private counts", async ({
  page,
}) => {
  const reads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/me/sky")) reads.push(r.url());
  });
  await page.route("**/api/v1/me", (r) =>
    r.fulfill({ status: 401, json: { code: "UNAUTHENTICATED" } }),
  );
  await page.goto("/login");
  await expect(page.locator(".auth-galaxy canvas")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "나의 발견으로 채워지는 밤하늘" }),
  ).toBeVisible();
  await expect(page.locator(".galaxy-scene")).toHaveCount(0);
  const intro = await page.locator(".auth-intro").boundingBox();
  const form = await page.locator(".auth-content").boundingBox();
  expect(form!.x).toBe(intro!.x);
  expect(form!.y).toBeGreaterThanOrEqual(intro!.y + intro!.height);
  expect(reads).toEqual([]);
  await noOverflow(page);
  await capture(page, "07-login");
});
