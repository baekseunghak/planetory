import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
async function loaded(page: Page) {
  await expect(page.getByTestId("sky-loaded")).toBeVisible();
  await expect(
    page.getByText("주변 별을 불러오고 있습니다.", { exact: true }),
  ).toHaveCount(0);
}
test.beforeEach(async ({ request }) => {
  await request.post("/api/dev-sky-203/reset");
});
test("initial camera loads 2501 individual stars through pages; every declared level uses the same contract", async ({
  page,
}) => {
  const urls: string[] = [],
    errors: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/sky/tiles?")) urls.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/sky");
  await expect(page.getByTestId("sky-loaded")).toContainText("별 2501개");
  await loaded(page);
  await expect(page.getByTestId("sky-total")).toHaveText("2,501");
  await expect(page.getByLabel("배율 단계").locator("option")).toHaveCount(3);
  expect(urls.some((u) => new URL(u).searchParams.has("cursor"))).toBe(true);
  for (const level of ["1", "2", "0"]) {
    await page.getByLabel("배율 단계").selectOption(level);
    await loaded(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "30도 회전", exact: true }).click();
  await page.getByRole("button", { name: "기울기 전환", exact: true }).click();
  await loaded(page);
  for (const u of urls) {
    const q = new URL(u).searchParams;
    expect(q.has("keys")).toBe(false);
    expect(q.get("limit")).toBe("1000");
    for (const k of ["w", "h"]) {
      expect(Number(q.get(k))).toBeGreaterThan(0);
      expect(Number(q.get(k))).toBeLessThanOrEqual(512 * 64);
    }
  }
  expect(errors).toEqual([]);
  await expect(page.getByText(/서버 군집/)).toHaveCount(0);
});
test("middle page failure keeps the first 1000 stars and selected TIC; retry resumes only failed cursor", async ({
  page,
}) => {
  await page.goto("/sky");
  await expect(page.getByTestId("sky-loaded")).toContainText("별 2501개");
  await page.getByLabel("적재된 별 선택").selectOption("900000001");
  const camera = await page.getByTestId("sky-camera").textContent();
  await page.getByText("개발 응답 시나리오", { exact: true }).click();
  await page
    .getByRole("button", { name: "일부 영역 실패", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "불러온 영역은 유지합니다",
  );
  await expect(page.getByTestId("sky-loaded")).toContainText("별 1000개");
  await expect(page.getByTestId("sky-page-progress")).toContainText(
    "1000/2501",
  );
  const retryUrls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/sky/tiles?")) retryUrls.push(r.url());
  });
  await page
    .getByRole("button", { name: "서버 응답 복구", exact: true })
    .click();
  await page
    .getByRole("button", { name: "실패 영역 다시 불러오기", exact: true })
    .click();
  await expect(page.getByTestId("sky-loaded")).toContainText("별 2501개");
  await loaded(page);
  expect(retryUrls.length).toBe(2);
  expect(retryUrls.every((u) => new URL(u).searchParams.has("cursor"))).toBe(
    true,
  );
  await expect(page.getByLabel("적재된 별 선택")).toHaveValue("900000001");
  await expect(page.getByTestId("sky-camera")).toHaveText(camera!);
});
async function allStars(request: APIRequestContext) {
  const meta = await (await request.get("/api/v1/me/sky")).json();
  let cursor: string | null = null;
  const stars: any[] = [];
  do {
    const q = new URLSearchParams({
      level: "0",
      x: "-2048",
      y: "-2048",
      w: "4096",
      h: "4096",
      version: meta.version,
      limit: "2000",
      ...(cursor ? { cursor } : {}),
    });
    const page = await (await request.get("/api/v1/me/sky/tiles?" + q)).json();
    stars.push(...page.stars);
    cursor = page.nextCursor;
  } while (cursor);
  return stars;
}
test("new discovery preserves stored coordinates, ordinal, camera and selected TIC", async ({
  page,
  request,
}) => {
  const before = await allStars(request);
  await page.goto("/sky");
  await expect(page.getByTestId("sky-loaded")).toContainText("별 2501개");
  await page.getByLabel("적재된 별 선택").selectOption("900000008");
  const camera = await page.getByTestId("sky-camera").textContent();
  await page.getByText("개발 응답 시나리오", { exact: true }).click();
  await page.getByRole("button", { name: "새 발견 응답", exact: true }).click();
  await expect(page.getByTestId("sky-total")).toHaveText("2,502");
  await loaded(page);
  await expect(page.getByLabel("적재된 별 선택")).toHaveValue("900000008");
  await expect(page.getByTestId("sky-camera")).toHaveText(camera!);
  const after = await allStars(request);
  for (let i = 0; i < before.length; i++) expect(after[i]).toEqual(before[i]);
  expect(after.length).toBe(2502);
});
test("metadata failure and obsolete cluster payload show errors, not an empty galaxy", async ({
  page,
}) => {
  let obsolete = false;
  await page.route("**/api/v1/me/sky", async (route) => {
    if (!obsolete)
      return route.fulfill({
        status: 503,
        json: { code: "DEPENDENCY_UNAVAILABLE", message: "메타 조회 실패" },
      });
    const response = await route.fetch();
    const meta = await response.json();
    delete meta.representation;
    meta.overview = [];
    await route.fulfill({ json: meta });
  });
  await page.goto("/sky");
  await expect(page.getByRole("alert")).toContainText("메타 조회 실패");
  await expect(
    page.getByText("아직 열린 별이 없습니다.", { exact: true }),
  ).toHaveCount(0);
  obsolete = true;
  await page
    .getByRole("button", { name: "다시 불러오기", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("individual-stars");
});
test("truncated final page is reported as contract failure with prior pages preserved", async ({
  page,
}) => {
  await page.route("**/api/v1/me/sky/tiles?**", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    if (body.nextCursor === null) body.stars = body.stars.slice(0, -1);
    await route.fulfill({ json: body });
  });
  await page.goto("/sky");
  await expect(page.getByRole("alert")).toContainText(
    "불러온 영역은 유지합니다",
  );
  await expect(page.getByTestId("sky-loaded")).toContainText("별 2000개");
  await expect(page.getByTestId("sky-page-progress")).toContainText(
    "2000/2501",
  );
  await expect(
    page.getByText("현재 범위에는 표시할 별이 없습니다.", { exact: true }),
  ).toHaveCount(0);
});
test("bbox/limit/cursor errors and a minimal version-change response obey the fixture HTTP contract", async ({
  request,
}) => {
  const meta = await (await request.get("/api/v1/me/sky")).json();
  const q = new URLSearchParams({
    level: "0",
    x: "-2048",
    y: "-2048",
    w: "4096",
    h: "4096",
    version: meta.version,
    limit: "1",
  });
  const first = await (await request.get("/api/v1/me/sky/tiles?" + q)).json();
  expect(first.stars.length).toBe(1);
  expect(first.rangeStarCount).toBe(2501);
  q.set("cursor", first.nextCursor);
  for (const [key, value] of [
    ["limit", "0"],
    ["limit", "2001"],
    ["w", String(512 * 64 + 1)],
    ["level", "99"],
    ["x", "-1024"],
    ["cursor", "wrong"],
  ]) {
    const bad = new URLSearchParams(q);
    bad.set(key, value);
    expect((await request.get("/api/v1/me/sky/tiles?" + bad)).status()).toBe(
      400,
    );
  }
  await request.post("/api/dev-sky-203/change");
  const changed = await (await request.get("/api/v1/me/sky/tiles?" + q)).json();
  expect(changed.versionChanged).toBe(true);
  expect(changed.stars).toEqual([]);
  expect(changed.nextCursor).toBeNull();
  expect(changed.bounds).toBeUndefined();
});
test("401 during a refresh removes personal map data", async ({ page }) => {
  await page.goto("/sky");
  await expect(page.getByTestId("sky-loaded")).toContainText("별 2501개");
  await page.route("**/api/v1/me/sky", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "UNAUTHORIZED", message: "로그인이 필요합니다" },
    }),
  );
  await page
    .getByRole("button", { name: "지도 다시 확인", exact: true })
    .click();
  await expect(page.getByTestId("sky-loaded")).toHaveCount(0);
  await expect(page.getByLabel("적재된 별 선택")).toHaveCount(0);
});
test("moving to a truly empty viewport retains the selected ID without asserting deletion", async ({
  page,
}) => {
  await page.goto("/sky");
  await expect(page.getByTestId("sky-loaded")).toContainText("별 2501개");
  await page.getByLabel("적재된 별 선택").selectOption("900000001");
  await page.getByLabel("배율 단계").selectOption("2");
  for (let i = 0; i < 5; i++)
    await page
      .getByRole("button", { name: "오른쪽 영역", exact: true })
      .click();
  await loaded(page);
  await expect(
    page.getByText("현재 범위에는 표시할 별이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("적재된 별 선택")).toHaveValue("900000001");
  await expect(
    page.getByText(/개별 자료가 현재 범위에 적재되지/),
  ).toBeVisible();
});
