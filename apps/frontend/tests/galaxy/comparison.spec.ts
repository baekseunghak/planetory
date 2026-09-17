import { test, expect, type Page } from "@playwright/test";
async function stats(page: Page, side: string) {
  return JSON.parse(
    (await page.getByTestId(`stats-${side}`).textContent()) || "null",
  );
}
test.beforeEach(async ({ request }) => {
  await request.post(
    "/api/dev-legacy-galaxy-204/dev-galaxy-204/reset?count=1000",
  );
});
test("comparison uses one unchanged source snapshot for individual stars and current clusters", async ({
  page,
  request,
}) => {
  const before = await (
    await request.get("/api/dev-legacy-galaxy-204/v1/me/sky")
  ).json();
  const snapshot = await (
    await request.get("/api/dev-legacy-galaxy-204/dev-galaxy-204/comparison")
  ).json();
  expect(snapshot.stars).toHaveLength(1000);
  expect(snapshot.meta.version).toBe(before.version);
  expect(snapshot.levels[0].clusters).toEqual(before.overview);
  expect(
    snapshot.levels[0].clusters.reduce(
      (n: number, c: { count: number }) => n + c.count,
      0,
    ),
  ).toBe(1000);
  const calls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/dev-legacy-galaxy-204/"))
      calls.push(r.url());
  });
  await page.goto("/dev/galaxy-comparison");
  await expect
    .poll(async () => (await stats(page, "individual"))?.stars)
    .toBe(1000);
  await expect
    .poll(async () => (await stats(page, "grouped"))?.clusters)
    .toBe(32);
  expect((await stats(page, "individual")).clusters).toBe(0);
  expect((await stats(page, "grouped")).stars).toBe(0);
  expect(
    calls.every((url) =>
      url.endsWith("/api/dev-legacy-galaxy-204/dev-galaxy-204/comparison"),
    ),
  ).toBe(true);
  expect(
    await (await request.get("/api/dev-legacy-galaxy-204/v1/me/sky")).json(),
  ).toMatchObject({
    version: before.version,
    starCount: 1000,
  });
  await page.screenshot({
    path: "test-results/galaxy/comparison-side-by-side.png",
    fullPage: true,
  });
});
test("wheel drag and keyboard update both canvases together, reset and full-size views work", async ({
  page,
}) => {
  await page.goto("/dev/galaxy-comparison");
  await expect
    .poll(async () => (await stats(page, "individual"))?.stars)
    .toBe(1000);
  const left = page.getByTestId("panel-individual").locator("canvas"),
    right = page.getByTestId("panel-grouped").locator("canvas");
  expect(await left.getAttribute("data-view")).toBe(
    await right.getAttribute("data-view"),
  );
  const original = await left.getAttribute("data-view");
  await left.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("+");
  await expect(left).not.toHaveAttribute("data-view", original!);
  expect(await left.getAttribute("data-view")).toBe(
    await right.getAttribute("data-view"),
  );
  const box = (await left.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 35,
    box.y + box.height / 2 + 18,
    { steps: 4 },
  );
  await page.mouse.up();
  expect(await left.getAttribute("data-view")).toBe(
    await right.getAttribute("data-view"),
  );
  await page.mouse.wheel(0, -180);
  await expect(page.getByTestId("comparison-zoom")).not.toHaveText("1.2×");
  await page.getByRole("button", { name: "처음 시점", exact: true }).click();
  await expect(page.getByTestId("comparison-zoom")).toHaveText("1.0×");
  await page
    .getByRole("button", { name: "군집 없음 크게", exact: true })
    .click();
  await expect(page.locator("canvas")).toHaveCount(1);
  await page.getByRole("button", { name: "나란히", exact: true }).click();
  await expect(page.locator("canvas")).toHaveCount(2);
  expect(await left.getAttribute("data-view")).toBe(
    await right.getAttribute("data-view"),
  );
  await page.setViewportSize({ width: 900, height: 800 });
  await expect
    .poll(async () => Math.round((await left.boundingBox())!.width))
    .toBe(860);
  await expect
    .poll(async () =>
      Math.round(
        JSON.parse((await left.getAttribute("data-view"))!).size.width,
      ),
    )
    .toBe(860);
});
test("automatic LOD can resolve into individual stars, while fixed groups stay grouped", async ({
  page,
}) => {
  await page.goto("/dev/galaxy-comparison");
  await expect
    .poll(async () => (await stats(page, "grouped"))?.clusters)
    .toBe(32);
  await page.getByRole("slider", { name: "공통 확대 배율" }).fill("40");
  await expect
    .poll(async () => (await stats(page, "grouped"))?.stars)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await stats(page, "grouped"))?.clusters)
    .toBe(0);
  expect((await stats(page, "individual")).stars).toBe(
    (await stats(page, "grouped")).stars,
  );
  await page
    .getByRole("combobox", { name: "오른쪽 표현" })
    .selectOption("fixed");
  await expect
    .poll(async () => (await stats(page, "grouped"))?.clusters)
    .toBeGreaterThan(0);
  expect((await stats(page, "grouped")).stars).toBe(0);
  await page.getByRole("button", { name: "처음 시점", exact: true }).click();
  await page.getByRole("checkbox", { name: "궤도 함께 보기" }).check();
  await expect
    .poll(async () => (await stats(page, "individual"))?.orbitStars)
    .toBe(500);
  expect((await stats(page, "grouped")).orbitStars).toBe(0);
});
test("snapshot errors are recoverable without manufacturing a comparison", async ({
  page,
}) => {
  await page.route(
    "**/api/dev-legacy-galaxy-204/dev-galaxy-204/comparison",
    (route) => route.fulfill({ status: 503, json: { message: "unavailable" } }),
  );
  await page.goto("/dev/galaxy-comparison");
  await expect(page.getByRole("alert")).toContainText("503");
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.unroute("**/api/dev-legacy-galaxy-204/dev-galaxy-204/comparison");
  await page
    .getByRole("button", { name: "다시 불러오기", exact: true })
    .click();
  await expect
    .poll(async () => (await stats(page, "individual"))?.stars)
    .toBe(1000);
});
