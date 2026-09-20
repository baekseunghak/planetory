import { test, expect, type Page, type Locator } from "@playwright/test";
async function enter(input: Locator, value: string) {
  await input.fill(value);
  if (test.info().project.name === "firefox") {
    // Same native-edit workaround as the post/profile suites: BiDi fill alone
    // updates React's value tracker without a user input event (Playwright 1.63).
    await input.press("End");
    await input.press("Space");
    await input.press("Backspace");
  }
}
const rows = (page: Page) => page.locator(".community-feed > li");
const query = (page: Page) =>
  page.getByRole("searchbox", { name: "검색어", exact: true });
const search = async (page: Page, value: string) => {
  await enter(query(page), value);
  await query(page).press("Enter");
  await expect(
    page.getByRole("region", { name: "게시글 목록" }),
  ).toHaveAttribute("aria-busy", "false");
};
test.beforeEach(async ({ request }) => {
  await request.post("/api/dev-search-217/reset");
});

test("keyboard search sends all AND conditions; literal symbols and ASCII case match", async ({
  page,
}) => {
  await page.goto("/community?board=STAR");
  await page
    .getByText("상세 조건 · 작성자, TIC, 태그", { exact: true })
    .click();
  await enter(page.getByLabel("작성자 닉네임"), "oRbIt");
  await enter(page.getByLabel("TIC 번호"), "259377017");
  await page.getByLabel("글 태그").selectOption("QUESTION");
  const request = page.waitForRequest(
    (r) =>
      r.url().includes("community/feed?") &&
      new URL(r.url()).searchParams.has("q"),
  );
  await search(page, "  10%_ 감소 + a&b  ");
  const params = new URL((await request).url()).searchParams;
  expect(Object.fromEntries(params)).toEqual({
    q: "10%_ 감소 + a&b",
    searchIn: "TITLE_BODY",
    author: "oRbIt",
    ticId: "259377017",
    board: "STAR",
    tag: "QUESTION",
    size: "20",
  });
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("TOI-270");
  await page.getByRole("link", { name: "자유 게시판", exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText(/검색 조건에 맞는 글이 없습니다/)).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBe("10%_ 감소 + a&b");
});

test("title/body scopes, internal spaces, comments exclusion and official summary", async ({
  page,
}) => {
  await page.goto("/community");
  await page.getByLabel("검색 범위").selectOption("BODY");
  await search(page, "두  공백");
  await expect(rows(page)).toHaveCount(1);
  await page.getByLabel("검색 범위").selectOption("TITLE");
  await search(page, "두  공백");
  await expect(rows(page)).toHaveCount(0);
  await page.getByLabel("검색 범위").selectOption("TITLE_BODY");
  await search(page, "함께 확인해 주셔서 감사합니다");
  await expect(rows(page)).toHaveCount(0);
  await page.getByLabel("검색 범위").selectOption("BODY");
  await search(page, "공식 요약");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("SYSTEM");
  await page
    .getByText("상세 조건 · 작성자, TIC, 태그", { exact: true })
    .click();
  await page.getByLabel("글 태그").selectOption("DISCUSSION");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
});

test("current nickname exact match; old nickname and partial name are excluded", async ({
  page,
  request,
}) => {
  await page.goto("/community?author=orb");
  await expect(rows(page)).toHaveCount(0);
  await enter(page.getByLabel("작성자 닉네임"), "Orbit");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await request.post("/api/dev-search-217/nickname?value=NewOrbit");
  await page.reload();
  await expect(rows(page)).toHaveCount(0);
  await enter(page.getByLabel("작성자 닉네임"), "neworbit");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("NewOrbit");
});

test("search cursor resets on filters and reload restores query", async ({
  page,
}) => {
  await page.goto("/community?q=빛&searchIn=BODY");
  await expect(rows(page)).toHaveCount(20);
  await page.getByRole("link", { name: "다음 페이지" }).click();
  await expect(rows(page)).toHaveCount(20);
  expect(new URL(page.url()).searchParams.get("cursor")).toBeTruthy();
  await page.getByRole("link", { name: "자유 게시판", exact: true }).click();
  await expect(rows(page)).toHaveCount(14);
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
  await page.reload();
  await expect(query(page)).toHaveValue("빛");
  await expect(page.getByLabel("검색 범위")).toHaveValue("BODY");
  await expect(rows(page)).toHaveCount(14);
  await page.getByRole("link", { name: "조건 초기화" }).click();
  await expect(query(page)).toHaveValue("");
  expect(new URL(page.url()).search).toBe("");
});

for (const browserBack of [false, true])
  test(`detail return restores query, cursor and scroll (${browserBack ? "browser" : "link"}) after fresh GET`, async ({
    page,
  }) => {
    await page.goto("/community?q=빛");
    await page.getByRole("link", { name: "다음 페이지" }).click();
    await expect(rows(page)).toHaveCount(20);
    const current = page.url();
    const target = page.locator(".community-feed h2 a").nth(9);
    await target.scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(500);
    const position = await page.evaluate(() => window.scrollY);
    await target.click();
    await expect(page.getByRole("link", { name: "이전 화면" })).toBeVisible();
    const refreshed = page.waitForResponse((r) =>
      r.url().includes("community/feed?"),
    );
    if (browserBack) await page.goBack();
    else await page.getByRole("link", { name: "이전 화면" }).click();
    await refreshed;
    await expect(page).toHaveURL(current);
    await expect(rows(page)).toHaveCount(20);
    await expect
      .poll(async () =>
        Math.abs((await page.evaluate(() => window.scrollY)) - position),
      )
      .toBeLessThan(5);
  });

test("100 unicode characters accepted; 101 and whitespace refused without request", async ({
  page,
}) => {
  await page.goto("/community");
  await expect(rows(page)).toHaveCount(20);
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("community/feed?")) calls.push(r.url());
  });
  await enter(query(page), "⭐".repeat(101));
  await query(page).press("Enter");
  await expect(page.locator(".community-search-error")).toBeFocused();
  expect(calls).toHaveLength(0);
  await enter(query(page), "   ");
  await query(page).press("Enter");
  await expect(page.locator(".community-search-error")).toBeVisible();
  expect(calls).toHaveLength(0);
  await search(page, "⭐".repeat(100));
  await expect(rows(page)).toHaveCount(0);
  expect(calls.length).toBeGreaterThan(0);
});

test("malformed deep link is correctable without silently dropping filters", async ({
  page,
}) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("community/feed?")) calls.push(r.url());
  });
  await page.goto("/community?q=빛&q=별");
  await expect(page.locator(".community-search-error")).toContainText(
    "조건이 겹칩니다",
  );
  expect(calls).toHaveLength(0);
  await search(page, "빛");
  await expect(rows(page)).toHaveCount(20);
});

test("TIC overflow blocks form submission and direct URLs before HTTP; Long max stays exact", async ({
  page,
}) => {
  await page.goto("/community");
  await expect(rows(page)).toHaveCount(20);
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("community/feed?")) calls.push(r.url());
  });
  await page
    .getByText("상세 조건 · 작성자, TIC, 태그", { exact: true })
    .click();
  await enter(page.getByLabel("TIC 번호"), "9223372036854775808");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".community-search-error")).toBeFocused();
  await expect(page.locator(".community-search-error")).toContainText(
    "9223372036854775807",
  );
  expect(calls).toHaveLength(0);
  for (const path of [
    "/community?ticId=9999999999999999999",
    "/community/stars/9223372036854775808",
  ]) {
    await page.goto(path);
    await expect(page.locator(".community-search-error")).toContainText(
      "범위의 정수",
    );
    await expect(
      page.getByRole("region", { name: "게시글 목록" }),
    ).toHaveAttribute("aria-busy", "false");
    expect(calls).toHaveLength(0);
  }
  await page.goto("/community?ticId=9223372036854775807");
  await expect(page.getByText(/검색 조건에 맞는 글이 없습니다/)).toBeVisible();
  expect(calls.length).toBeGreaterThan(0);
  expect(new URL(calls[calls.length - 1]).searchParams.get("ticId")).toBe(
    "9223372036854775807",
  );
});

test("loading, server failure, retry and no result have distinct states", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/community/feed?**", async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "검색 서버 연결 실패" },
    });
  });
  await page.goto("/community?q=빛");
  await expect(page.getByText("이야기를 찾고 있습니다…")).toBeVisible();
  release();
  await expect(page.getByText("목록을 불러오지 못했습니다.")).toBeVisible();
  await expect(page.getByText(/검색 조건에 맞는 글이 없습니다/)).toHaveCount(0);
  await page.unroute("**/api/v1/community/feed?**");
  await page.getByRole("button", { name: /다시/ }).click();
  await expect(rows(page)).toHaveCount(20);
});

test("condition-bound old cursor rejected; first page link keeps search", async ({
  page,
  request,
}) => {
  const data = await (
    await request.get("/api/v1/community/feed?q=빛&size=20")
  ).json();
  await page.goto(
    "/community?q=TOI&cursor=" + encodeURIComponent(data.nextCursor),
  );
  await expect(page.getByText("목록을 불러오지 못했습니다.")).toBeVisible();
  await page
    .getByRole("link", { name: "조건을 유지하고 처음 페이지로" })
    .click();
  await expect(rows(page)).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get("q")).toBe("TOI");
});

test("hidden, deleted and withdrawn parent are absent from feed and direct paths", async ({
  page,
  request,
}) => {
  for (const path of [
    "posts/p-223",
    "posts/p-224",
    "signal-threads/st-302",
    "signal-threads/st-302/analyses",
    "comments?parentType=SIGNAL_THREAD&parentId=st-302",
  ])
    expect((await request.get("/api/v1/" + path)).status()).toBe(404);
  await page.goto("/community?q=TOI");
  await expect(rows(page)).toHaveCount(2);
  await page.locator(".community-feed h2 a").first().click();
  await request.post("/api/dev-search-217/hide?id=p-201");
  await page.getByRole("link", { name: "이전 화면" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "TOI-270 · 10%_ 감소 + A&B" }),
  ).toHaveCount(0);
  const denied = page.waitForResponse(
    (r) => r.url().includes("/api/v1/posts/p-201") && r.status() === 404,
  );
  await page.goto("/posts/p-201");
  await denied;
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "TOI-270 · 10%_ 감소 + A&B" }),
  ).toHaveCount(0);
  await expect(page.getByRole("region", { name: "게시글" })).toHaveCount(0);
});

test("star board keeps the route TIC through search, refresh and reset", async ({
  page,
}) => {
  await page.goto("/community/stars/259377017?q=TOI");
  await expect(rows(page)).toHaveCount(1);
  await page
    .getByText("상세 조건 · 작성자, TIC, 태그", { exact: true })
    .click();
  await expect(page.getByLabel("TIC 번호")).toHaveAttribute("readonly", "");
  await page.getByRole("link", { name: "조건 초기화" }).click();
  await expect(rows(page)).toHaveCount(20);
  expect(new URL(page.url()).pathname).toBe("/community/stars/259377017");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "TIC 259377017", exact: true }),
  ).toBeVisible();
});

test("slow previous search cannot overwrite the latest result", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/community/feed?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") !== "slow")
      return route.continue();
    await gate;
    await route
      .fulfill({ json: { items: [], nextCursor: null, hasNext: false } })
      .catch(() => {});
  });
  await page.goto("/community");
  await expect(rows(page)).toHaveCount(20);
  await enter(query(page), "slow");
  await query(page).press("Enter");
  await expect(page.getByText("이야기를 찾고 있습니다…")).toBeVisible();
  await search(page, "10%_");
  await expect(rows(page)).toHaveCount(1);
  release();
  await expect(rows(page).first()).toContainText("TOI-270");
  expect(new URL(page.url()).searchParams.get("q")).toBe("10%_");
});

test("server order is retained and desktop search controls fit without horizontal scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/community?q=빛");
  await expect(rows(page)).toHaveCount(20);
  await expect(rows(page).first()).toContainText("TOI-270");
  const ids = await page
    .locator(".community-feed h2 a")
    .evaluateAll((links) =>
      links.map((link) =>
        new URL((link as HTMLAnchorElement).href).pathname.split("/").pop(),
      ),
    );
  expect(ids.slice(1)).toEqual([...ids.slice(1)].sort().reverse());
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
