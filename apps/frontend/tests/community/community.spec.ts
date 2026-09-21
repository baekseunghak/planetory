import { test, expect } from "@playwright/test";

test("all/star/free boards send explicit scopes and distinguish post/SYSTEM", async ({
  page,
}) => {
  await page.goto("/community");
  await expect(
    page.getByRole("heading", { name: "탐사 이야기" }),
  ).toBeVisible();
  await expect(page.locator(".community-feed > li")).toHaveCount(20);
  await expect(
    page.getByText("공식 신호 스레드 · SYSTEM", { exact: true }),
  ).toHaveCount(2);
  const free = page.waitForResponse(
    (r) =>
      r.url().includes("/community/feed?") &&
      new URL(r.url()).searchParams.get("board") === "FREE",
  );
  await page
    .getByRole("navigation", { name: "게시판 종류" })
    .getByRole("link", { name: "자유 게시판", exact: true })
    .click();
  await free;
  await expect(page.locator(".community-feed > li")).toHaveCount(8);
  await expect(page.locator(".community-official")).toHaveCount(0);
  await page.getByRole("link", { name: "별 게시판", exact: true }).click();
  await expect(page.locator(".community-feed > li")).toHaveCount(18);
  await page
    .getByRole("link", { name: "TIC 259377017", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "TIC 259377017", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".community-feed > li")).toHaveCount(18);
});

test("cursor page → post → return/reload/back preserves list context", async ({
  page,
}) => {
  await page.goto("/community");
  await page
    .getByRole("navigation", { name: "게시글 페이지" })
    .getByRole("link", { name: "다음 페이지" })
    .click();
  await expect(page.locator(".community-feed > li")).toHaveCount(6);
  const second = page.url();
  const title = await page.locator(".community-feed h2 a").first().innerText();
  await page.locator(".community-feed h2 a").first().click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "이전 화면" }).click();
  await expect(page).toHaveURL(second);
  await expect(page.locator(".community-feed > li")).toHaveCount(6);
  await page.getByRole("link", { name: "이전 페이지", exact: true }).click();
  await expect(page.locator(".community-feed > li")).toHaveCount(20);
  await page.goBack();
  await expect(page.locator(".community-feed > li")).toHaveCount(6);
});

test("three judgment filters retain server denominator, personal authors, public-only links", async ({
  page,
}) => {
  await page.goto(
    "/signal-threads/st-301?returnTo=%2Fcommunity%3Fboard%3DSTAR",
  );
  await expect(
    page.getByRole("heading", { name: "참여자 15명" }),
  ).toBeVisible();
  await expect(page.locator(".community-analyses > li")).toHaveCount(20);
  await expect(
    page.getByText("현재 판단 집계에 반영", { exact: true }),
  ).toHaveCount(15);
  for (const [label, count] of [
    ["행성 같음", 11],
    ["아닌 것 같음", 7],
    ["모르겠음", 5],
  ] as const) {
    await page
      .getByRole("navigation", { name: "판단 필터" })
      .getByRole("link", { name: label, exact: true })
      .click();
    await expect(page.locator(".community-analyses > li")).toHaveCount(count);
    await expect(
      page.getByRole("heading", { name: "참여자 15명" }),
    ).toBeVisible();
    await expect(page.getByText("8명 · 53.3%", { exact: true })).toBeVisible();
  }
  const analysisLink = page.locator(".community-analysis-title").first();
  await expect(analysisLink).toHaveAttribute("href", /^\/public-analyses\/pa-/);
  expect(
    await page.locator(".community-detail a[href^='/history']").count(),
  ).toBe(0);
  await analysisLink.click();
  await expect(page.getByRole("heading", { name: "공개 분석" })).toBeVisible();
  await page.goBack();
  await expect(
    page
      .getByRole("navigation", { name: "판단 필터" })
      .getByRole("link", { name: "모르겠음", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("analyses/comment page boundaries and filter reset are separate", async ({
  page,
}) => {
  await page.goto("/signal-threads/st-301");
  await page
    .getByRole("navigation", { name: "공개 분석 페이지" })
    .getByRole("link", { name: "다음 페이지" })
    .click();
  await expect(page.locator(".community-analyses > li")).toHaveCount(3);
  await expect(
    page.getByRole("heading", { name: "참여자 15명" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "판단 필터" })
    .getByRole("link", { name: "행성 같음", exact: true })
    .click();
  expect(new URL(page.url()).searchParams.has("analysesCursor")).toBe(false);
  await expect(page.locator(".community-analyses > li")).toHaveCount(11);
  await page.goto("/posts/p-201");
  await expect(page.locator(".community-comments > li")).toHaveCount(20);
  await page
    .getByRole("navigation", { name: "토론 페이지" })
    .getByRole("link", { name: "다음 페이지" })
    .click();
  await expect(page.locator(".community-comments > li")).toHaveCount(2);
  await expect(
    page.getByRole("heading", { name: /반복되는 밝기 감소/ }),
  ).toBeVisible();
});

test("N=0 is an empty public analysis state, never NaN or planet probability", async ({
  page,
}) => {
  await page.goto("/signal-threads/st-302");
  await expect(
    page.getByText("아직 공개된 분석이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "참여자 0명" })).toBeVisible();
  await expect(page.locator(".community-distribution")).toHaveCount(0);
  await expect(
    page.getByText("아직 토론이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("NaN");
});

test("opening a lower feed item starts at the detail heading and browser back restores scroll", async ({
  page,
}) => {
  await page.goto("/community");
  await expect(page.locator(".community-feed > li")).toHaveCount(20);
  const item = page.locator(".community-feed h2 a").nth(10);
  await item.scrollIntoViewIfNeeded();
  const previous = await page.evaluate(() => window.scrollY);
  expect(previous).toBeGreaterThan(500);
  await item.click();
  await expect(page.locator(".community-post-body")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.goBack();
  await expect(page.locator(".community-feed > li")).toHaveCount(20);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(500);
});

test("feed empty/loading/error/retry and invalid cursor recover explicitly", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/v1/community/feed?*", (route) =>
    route.fulfill(
      fail
        ? {
            status: 503,
            json: {
              code: "DEPENDENCY_UNAVAILABLE",
              message: "잠시 기다려 주세요.",
            },
          }
        : { json: { items: [], nextCursor: null, hasNext: false } },
    ),
  );
  await page.goto("/community");
  await expect(page.getByRole("alert")).toContainText("잠시 기다려 주세요.");
  fail = false;
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(
    page.getByText("아직 게시글이 없습니다.", { exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/v1/community/feed?*");
  await page.goto("/community?cursor=wrong");
  await expect(page.getByRole("alert")).toContainText(
    "목록의 처음부터 다시 확인해 주세요.",
  );
  await page
    .getByRole("navigation", { name: "게시판 종류" })
    .getByRole("link", { name: "전체", exact: true })
    .click();
  await expect(page.locator(".community-feed > li")).toHaveCount(20);
});

test("403/404 parent blocks child requests and content", async ({ page }) => {
  const children: string[] = [];
  page.on("request", (request) => {
    if (/\/analyses|\/comments\?/.test(request.url()))
      children.push(request.url());
  });
  for (const status of [403, 404]) {
    await page.route("**/api/v1/signal-threads/st-hidden", (route) =>
      route.fulfill({
        status,
        json: { code: "RESOURCE_NOT_FOUND", message: "볼 수 없습니다." },
      }),
    );
    await page.goto("/signal-threads/st-hidden");
    await expect(page.getByRole("alert")).toContainText(
      status === 403
        ? "접근 권한이 없습니다"
        : "자료를 찾을 수 없거나 볼 수 없습니다",
    );
    await expect(page.locator(".community-summary")).toHaveCount(0);
    await page.unroute("**/api/v1/signal-threads/st-hidden");
  }
  expect(children).toEqual([]);
});

test("child hidden race and partial success clear whole thread; retry rechecks parent", async ({
  page,
}) => {
  let hidden = true;
  await page.route("**/api/v1/comments?*", (route) =>
    hidden
      ? route.fulfill({
          status: 404,
          json: {
            code: "RESOURCE_NOT_FOUND",
            message: "상위 글이 숨겨졌습니다.",
          },
        })
      : route.continue(),
  );
  await page.goto("/signal-threads/st-301");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.locator(
      ".community-summary, .community-analyses, .community-comments",
    ),
  ).toHaveCount(0);
  hidden = false;
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(
    page.getByRole("heading", { name: "참여자 15명" }),
  ).toBeVisible();
});

test("foreground revalidation removes previously visible hidden content", async ({
  page,
}) => {
  await page.goto("/posts/p-201");
  await expect(page.locator(".community-post-body")).toBeVisible();
  await page.route("**/api/v1/posts/p-201", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "RESOURCE_NOT_FOUND", message: "볼 수 없습니다." },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.locator(".community-post-body, .community-comments"),
  ).toHaveCount(0);
});

test("expired child response logs out, clears identity and preserves intended URL", async ({
  page,
}) => {
  await page.route("**/api/v1/signal-threads/st-301/analyses?*", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "AUTH_REQUIRED", message: "로그인 필요" },
    }),
  );
  await page.goto("/signal-threads/st-301");
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다" }),
  ).toBeVisible();
  await expect(page.locator(".community-detail")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "209 검증 계정", exact: true }),
  ).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
    "/signal-threads/st-301",
  );
});

test("slow previous scope cannot replace free board; response fields fail closed", async ({
  page,
}) => {
  let release: () => void = () => {};
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/community/feed?size=20", async (route) => {
    await delay;
    await route.fulfill({ json: { items: undefined } });
  });
  await page.goto("/community");
  await expect(
    page.locator(".community-main").getByRole("status"),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "게시판 종류" })
    .getByRole("link", { name: "자유 게시판", exact: true })
    .click();
  await expect(page.locator(".community-feed > li")).toHaveCount(8);
  release();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.goto("/community");
  await expect(page.getByRole("alert")).toContainText(
    "게시판 응답 형식이 올바르지 않습니다",
  );
});

test("post text is escaped and 1024px layout avoids horizontal overflow", async ({
  page,
}) => {
  await page.route("**/api/v1/posts/p-201", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: { ...body, body: '<img src=x onerror="alert(1)">\n텍스트 본문' },
    });
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/posts/p-201");
  await expect(page.locator(".community-post-body")).toContainText(
    '<img src=x onerror="alert(1)">',
  );
  expect(await page.locator(".community-post-body img").count()).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(page.getByRole("heading", { name: /데스크톱/ })).toBeVisible();
});

test("tab return coalesces visibility and focus, preserves slow reads, and clears private data while hidden", async ({
  page,
}) => {
  let requests = 0,
    hold = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/community/feed?*", async (route) => {
    requests++;
    if (hold) await barrier;
    await route.continue();
  });
  await page.goto("/community");
  await expect(page.locator(".community-feed > li")).toHaveCount(20);
  const initial = requests;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".community-feed > li")).toHaveCount(0);
  hold = true;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => requests).toBe(initial + 1);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(150);
  expect(requests).toBe(initial + 1);
  release();
  await expect(page.locator(".community-feed > li")).toHaveCount(20);
  hold = false;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect.poll(() => requests).toBe(initial + 2);
  await expect(page.locator(".community-feed > li")).toHaveCount(20);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(150);
  expect(requests).toBe(initial + 2);
});
