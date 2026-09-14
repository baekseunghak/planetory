import { test, expect, type Page } from "@playwright/test";
async function loaded(page: Page) {
  await expect(page.getByTestId("sky-loaded")).toBeVisible();
  await expect(
    page.getByText("주변 별을 불러오고 있습니다.", { exact: true }),
  ).toHaveCount(0);
}
test.beforeEach(async ({ request }) => {
  await request.post("/api/dev-sky-203/recover");
});

test("metadata overview avoids tiles, then six declared levels load a bounded subset", async ({
  page,
  request,
}) => {
  const total = (await (await request.get("/api/v1/me/sky")).json()).starCount;
  const urls: string[] = [],
    errors: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/sky/tiles?")) urls.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/sky");
  await loaded(page);
  await expect(page.getByTestId("sky-total")).toHaveText(String(total));
  await expect(page.getByTestId("sky-loaded")).toContainText(
    "별 0개 · 서버 군집 8개",
  );
  expect(urls).toEqual([]);
  await expect(page.getByLabel("배율 단계").locator("option")).toHaveCount(6);
  await page.getByLabel("배율 단계").selectOption("2");
  await expect(
    page.getByLabel("적재된 별 선택").locator("option"),
  ).not.toHaveCount(1);
  await loaded(page);
  const count =
    (await page.getByLabel("적재된 별 선택").locator("option").count()) - 1;
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(total);
  await page.getByRole("button", { name: "30도 회전", exact: true }).click();
  await page.getByRole("button", { name: "기울기 전환", exact: true }).click();
  await loaded(page);
  expect(urls.length).toBeGreaterThan(0);
  for (const value of urls) {
    const q = new URL(value).searchParams;
    expect([...q.keys()].sort()).toEqual([
      "h",
      "level",
      "version",
      "w",
      "x",
      "y",
    ]);
    for (const field of ["x", "y", "w", "h"])
      expect(Number.isFinite(Number(q.get(field)))).toBe(true);
    expect(Number(q.get("w"))).toBeLessThanOrEqual(512 * 64);
    expect(Number(q.get("h"))).toBeLessThanOrEqual(512 * 64);
  }
  expect(errors).toEqual([]);
});

test("partial failure preserves healthy stars and retries missing cells only", async ({
  page,
}) => {
  await page.goto("/sky");
  await page.getByLabel("배율 단계").selectOption("2");
  await expect(
    page.getByLabel("적재된 별 선택").locator("option"),
  ).not.toHaveCount(1);
  await loaded(page);
  await page.getByText("개발 응답 시나리오", { exact: true }).click();
  await page
    .getByRole("button", { name: "일부 영역 실패", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "불러온 영역은 유지합니다",
  );
  expect(
    await page.getByLabel("적재된 별 선택").locator("option").count(),
  ).toBeGreaterThan(1);
  const failed: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/sky/tiles?")) failed.push(r.url());
  });
  await page
    .getByRole("button", { name: "서버 응답 복구", exact: true })
    .click();
  await page
    .getByRole("button", { name: "실패 영역 다시 불러오기", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await loaded(page);
  expect(failed.length).toBeGreaterThan(0);
  for (const url of failed)
    expect(Number(new URL(url).searchParams.get("x"))).toBeGreaterThanOrEqual(
      512,
    );
});

test("a discovered-star version refresh preserves camera, selected TIC and existing coordinates", async ({
  page,
  request,
}) => {
  await page.goto("/sky");
  await page.getByLabel("배율 단계").selectOption("2");
  await expect(
    page.getByLabel("적재된 별 선택").locator("option"),
  ).not.toHaveCount(1);
  await loaded(page);
  const option = page.getByLabel("적재된 별 선택").locator("option").nth(1),
    id = (await option.getAttribute("value"))!;
  await page.getByLabel("적재된 별 선택").selectOption(id);
  const before = (
    await (
      await request.get(
        "/api/v1/me/sky/tiles?level=2&x=-4096&y=-2048&w=8192&h=4096",
      )
    ).json()
  ).stars;
  const camera = await page.getByTestId("sky-camera").textContent(),
    version = await page.getByTestId("sky-version").textContent(),
    total = Number(await page.getByTestId("sky-total").textContent());
  await page.getByText("개발 응답 시나리오", { exact: true }).click();
  await page.getByRole("button", { name: "새 발견 응답", exact: true }).click();
  await expect(page.getByTestId("sky-total")).toHaveText(String(total + 1));
  await expect(page.getByTestId("sky-version")).not.toHaveText(version!);
  await loaded(page);
  await expect(page.getByTestId("sky-camera")).toHaveText(camera!);
  await expect(page.getByLabel("적재된 별 선택")).toHaveValue(id);
  const after = (
    await (
      await request.get(
        "/api/v1/me/sky/tiles?level=2&x=-4096&y=-2048&w=8192&h=4096",
      )
    ).json()
  ).stars;
  for (const star of before)
    expect(
      after.find((s: { ticId: string }) => s.ticId === star.ticId),
    ).toMatchObject({ x: star.x, y: star.y, depthZ: star.depthZ });
});

test("empty viewport, empty map, metadata failure and malformed tile responses are distinct", async ({
  page,
}) => {
  let broken = true;
  await page.route("**/api/v1/me/sky", async (route) => {
    if (broken)
      await route.fulfill({
        status: 503,
        json: { code: "DEPENDENCY_UNAVAILABLE", message: "메타 조회 실패" },
      });
    else await route.continue();
  });
  await page.goto("/sky");
  await expect(page.getByRole("alert")).toContainText("메타 조회 실패");
  await expect(
    page.getByText("아직 열린 별이 없습니다.", { exact: true }),
  ).toHaveCount(0);
  broken = false;
  await page
    .getByRole("button", { name: "다시 불러오기", exact: true })
    .click();
  await loaded(page);
  let malformed = true;
  await page.route("**/api/v1/me/sky/tiles?*", async (route) => {
    const response = await route.fetch(),
      json = await response.json();
    await route.fulfill({
      json: { ...json, stars: malformed ? undefined : [], clusters: [] },
    });
  });
  await page.getByLabel("배율 단계").selectOption("2");
  await expect(page.getByRole("alert")).toContainText("불러오지 못했습니다");
  await expect(
    page.getByText("현재 범위에는 표시할 별이 없습니다.", { exact: true }),
  ).toHaveCount(0);
  malformed = false;
  await page
    .getByRole("button", { name: "실패 영역 다시 불러오기", exact: true })
    .click();
  await expect(
    page.getByText("현재 범위에는 표시할 별이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("sky-total")).not.toHaveText("0");
  await page.unroute("**/api/v1/me/sky");
  await page.route("**/api/v1/me/sky", async (route) => {
    const response = await route.fetch(),
      json = await response.json();
    await route.fulfill({
      json: { ...json, starCount: 0, overview: [], centerTicIds: [] },
    });
  });
  await page.reload();
  await expect(
    page.getByText("아직 열린 별이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("현재 범위에는 표시할 별이 없습니다.", { exact: true }),
  ).toHaveCount(0);
});

test("tile 401 leaves the private map and does not present a successful empty map", async ({
  page,
}) => {
  await page.goto("/sky");
  await loaded(page);
  await page.route("**/api/v1/me/sky/tiles?*", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "UNAUTHORIZED", message: "로그인이 필요합니다" },
    }),
  );
  await page.getByLabel("배율 단계").selectOption("2");
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByTestId("sky-loaded")).toHaveCount(0);
  await expect(
    page.getByText("아직 열린 별이 없습니다.", { exact: true }),
  ).toHaveCount(0);
});

test("HTTP fixture follows bbox 64x64 contract and rejects legacy tile-key requests", async ({
  request,
}) => {
  const base = "/api/v1/me/sky/tiles?level=2&x=-512&y=-512";
  const success = await request.get(`${base}&w=32768&h=32768&version=old`);
  expect(success.status()).toBe(200);
  expect(await success.json()).toMatchObject({
    versionChanged: true,
    level: 2,
  });
  for (const query of [
    "w=32769&h=512",
    "w=512&h=32769",
    "w=0&h=512",
    "w=512&h=512&keys=0:0",
  ])
    expect((await request.get(`${base}&${query}`)).status()).toBe(400);
});
