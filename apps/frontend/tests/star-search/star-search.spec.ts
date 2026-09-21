import { test, expect } from "@playwright/test";
test.beforeEach(async ({ request, page }) => {
  await request.post("/api/dev-galaxy-204/reset?count=1000");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sky");
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered-stars",
    "1000",
  );
  await page.getByText("내 별 찾기", { exact: true }).click();
});
test("late locate is discarded after changing filters", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/v1/me/sky/locate?*", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page
    .getByRole("list", { name: "별 검색 결과" })
    .getByRole("button")
    .first()
    .click();
  await expect(page.locator(".star-search [role=status]")).toHaveText(
    "별 위치를 확인하고 있습니다.",
  );
  await page
    .getByRole("combobox", { name: "등급", exact: true })
    .selectOption("SSS");
  await page.getByRole("button", { name: "별 검색", exact: true }).click();
  release();
  await expect(page.locator(".star-search [role=status]")).toHaveText(
    "조건에 맞는 별이 없습니다.",
  );
  await expect(
    page.getByRole("complementary", { name: "별 상세" }),
  ).toHaveCount(0);
});
test("failed search clears prior results and supports retry", async ({
  page,
}) => {
  await page.route("**/v1/me/stars?*", (route) =>
    route.fulfill({ status: 503, json: { code: "DEPENDENCY_UNAVAILABLE" } }),
  );
  await page.getByRole("button", { name: "별 검색", exact: true }).click();
  await expect(page.locator(".star-search [role=alert]")).toContainText(
    "불러오지 못했습니다",
  );
  await expect(
    page.getByRole("list", { name: "별 검색 결과" }).getByRole("button"),
  ).toHaveCount(0);
  await page.unroute("**/v1/me/stars?*");
  await page.getByRole("button", { name: "검색 다시 불러오기" }).click();
  await expect(
    page.getByRole("list", { name: "별 검색 결과" }).getByRole("button"),
  ).toHaveCount(20);
});
test("filters through HTTP, locates using server scale, and preserves query when detail closes", async ({
  page,
}) => {
  await page
    .getByRole("combobox", { name: "등급", exact: true })
    .selectOption("A");
  const sent = page.waitForRequest(
    (r) => r.url().includes("/me/stars?") && r.url().includes("grade=A"),
  );
  await page.getByRole("button", { name: "별 검색", exact: true }).click();
  await sent;
  await expect(
    page.getByRole("list", { name: "별 검색 결과" }).getByRole("button"),
  ).toHaveCount(2);
  const selected = page.waitForRequest((r) =>
    r.url().includes("/sky/locate?ticId="),
  );
  await page
    .getByRole("list", { name: "별 검색 결과" })
    .getByRole("button")
    .first()
    .click();
  await selected;
  await expect(
    page.getByRole("complementary", { name: "별 상세" }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        JSON.parse((await page.locator("canvas").getAttribute("data-camera"))!)
          .zoom,
    )
    .toBe(1);
  await page.getByRole("button", { name: "은하로 돌아가기" }).click();
  await expect(page).toHaveURL(/filterGrade=A/);
  await expect(
    page.getByRole("list", { name: "별 검색 결과" }).getByRole("button"),
  ).toHaveCount(2);
});
test("TIC validation and empty results do not expose undiscovered stars", async ({
  page,
}) => {
  await page.getByLabel("TIC 번호", { exact: true }).fill("-1");
  await page.getByRole("button", { name: "별 검색", exact: true }).click();
  await expect(page.locator(".star-search [role=alert]")).toContainText(
    "TIC 번호",
  );
  await page.getByLabel("TIC 번호", { exact: true }).fill("999999999999");
  await page.getByRole("button", { name: "별 검색", exact: true }).click();
  await expect(page.locator(".star-search [role=status]")).toHaveText(
    "조건에 맞는 별이 없습니다.",
  );
  await expect(
    page.getByRole("list", { name: "별 검색 결과" }).getByRole("button"),
  ).toHaveCount(0);
});

test("invalid filter URL shows an error without issuing an unfiltered lookup", async ({
  page,
}) => {
  const searches: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/me/stars?"))
      searches.push(request.url());
  });
  await page.goto("/sky?filterTic=9223372036854775808");
  await page.getByText("내 별 찾기", { exact: true }).click();
  await expect(page.locator(".star-search [role=alert]")).toContainText(
    "TIC 번호",
  );
  await expect(
    page.getByRole("list", { name: "별 검색 결과" }).getByRole("button"),
  ).toHaveCount(0);
  expect(searches).toEqual([]);
});
test("403 locate keeps overview and does not select a star", async ({
  page,
}) => {
  await page.route("**/v1/me/sky/locate?*", (r) =>
    r.fulfill({ status: 403, json: { code: "STAR_LOCKED" } }),
  );
  await page
    .getByRole("list", { name: "별 검색 결과" })
    .getByRole("button")
    .first()
    .click();
  await expect(page.locator(".star-search [role=alert]")).toContainText(
    "접근할 수 없는 별",
  );
  await expect(
    page.getByRole("complementary", { name: "별 상세" }),
  ).toHaveCount(0);
});
test("new filters reset cursor and browser back restores filters", async ({
  page,
}) => {
  await page.getByRole("button", { name: "다음 검색 결과" }).click();
  await expect(
    page.getByRole("button", { name: "이전 검색 결과" }),
  ).toBeEnabled();
  await page
    .getByRole("combobox", { name: "등급", exact: true })
    .selectOption("SSS");
  await page.getByRole("button", { name: "별 검색", exact: true }).click();
  await expect(page.locator(".star-search [role=status]")).toHaveText(
    "조건에 맞는 별이 없습니다.",
  );
  await expect(
    page.getByRole("button", { name: "이전 검색 결과" }),
  ).toBeDisabled();
  await page.goBack();
  await expect(
    page.getByRole("combobox", { name: "등급", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("list", { name: "별 검색 결과" }).getByRole("button"),
  ).toHaveCount(20);
});
test("search still selects details in WebGL fallback", async ({ page }) => {
  await page.getByRole("button", { name: "별 목록으로 선택하기" }).click();
  await page
    .getByRole("list", { name: "별 검색 결과" })
    .getByRole("button")
    .first()
    .click();
  await expect(
    page.getByRole("complementary", { name: "별 상세" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "별 목록으로 돌아가기" }).click();
  await expect(
    page.getByRole("heading", { name: "발견한 별 목록" }),
  ).toBeVisible();
});
