import { test, expect, type Page } from "@playwright/test";
const root = "/community/hot-topics";
const control = "/api/dev-hot-topics-218";
const apiPath = "**/api/v1/community/hot-topics?*";
const rows = (page: Page) => page.locator(".community-feed > li");
const ids = [
  "9007199254741000",
  "9007199254741001",
  "9007199254741002",
  "9007199254741003",
  "9007199254741004",
];
const refresh = (page: Page) =>
  page.getByRole("button", { name: "최신 목록 확인" }).click();
test.beforeEach(async ({ request }) => {
  await request.post(control + "/reset");
});

test("community entry uses S18 only; server ties, old threads and three judgments remain visible", async ({
  page,
}) => {
  await page.goto("/community?q=빛");
  await expect(rows(page)).toHaveCount(20);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/community/")) requests.push(r.url());
  });
  await page.getByRole("link", { name: "핫 토픽", exact: true }).click();
  await expect(rows(page)).toHaveCount(20);
  expect(
    requests.every((url) => new URL(url).pathname.endsWith("/hot-topics")),
  ).toBe(true);
  expect(Object.fromEntries(new URL(requests[0]).searchParams)).toEqual({
    size: "20",
  });
  const links = page.locator(".community-feed h2 a");
  for (const [i, id] of [ids[2], ids[1], ids[0]].entries())
    await expect(links.nth(i)).toHaveAttribute(
      "href",
      `/signal-threads/${id}?returnTo=%2Fcommunity%2Fhot-topics`,
    );
  await expect(rows(page).nth(2)).toContainText("오래된 관측");
  await expect(rows(page).first()).toContainText("공개 분석 참여자 11명");
  await expect(rows(page).first()).toContainText(
    "행성 같음 5명 · 아닌 것 같음 3명 · 모르겠음 3명",
  );
  await expect(page.locator(".community-official")).toHaveCount(20);
  await page.getByText("핫 토픽은 어떻게 선정되나요?", { exact: true }).click();
  await expect(page.locator(".hot-topic-guide")).toContainText(
    "기간 제한 없이",
  );
  await expect(page.locator(".hot-topic-guide")).toContainText(
    "일반 글·댓글·동의·비동의 수는 선정에 사용하지 않습니다",
  );
  await expect(page.locator(".hot-topic-guide")).toContainText(
    "행성일 확률이나 성과 점수가 아닙니다",
  );
  await page.getByRole("link", { name: "다음 페이지" }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).last()).toContainText("열 번째 탐사자");
  await expect(rows(page).last()).toContainText(
    "행성 같음 4명 · 아닌 것 같음 3명 · 모르겠음 3명",
  );
  await expect(page.locator("main")).not.toContainText("아직 아홉 명");
});

test("detail and both return paths preserve cursor, reload and scroll; no private history links", async ({
  page,
}) => {
  await page.goto(root);
  await expect(rows(page)).toHaveCount(20);
  const item = page.locator(".community-feed h2 a").nth(10);
  await item.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(500);
  await item.click();
  await expect(
    page.getByRole("region", { name: "공개 판단 요약" }),
  ).toBeVisible();
  await expect(
    page.locator(".community-detail a[href^='/history']"),
  ).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole("link", { name: "이전 화면" }).click();
  await expect(rows(page)).toHaveCount(20);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(500);
  await page.getByRole("link", { name: "다음 페이지" }).click();
  await expect(rows(page)).toHaveCount(3);
  const second = page.url();
  await page.locator(".community-feed h2 a").last().click();
  await expect(
    page.getByRole("heading", { name: "참여자 10명" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(second);
  await expect(rows(page)).toHaveCount(3);
  await page.reload();
  await expect(rows(page)).toHaveCount(3);
  await expect(page).toHaveURL(second);
  await page.getByRole("link", { name: "처음 페이지", exact: true }).click();
  await expect(rows(page)).toHaveCount(20);
});

test("9→10→11→9→10 responses remove/re-enter; judgment changes and comments never create participants", async ({
  page,
  request,
}) => {
  await page.goto(root);
  await expect(rows(page)).toHaveCount(20);
  const title = "아직 아홉 명이 살펴본 신호";
  await expect(page.getByRole("link", { name: title })).toHaveCount(0);
  for (const [a, b, c] of [
    [4, 3, 3],
    [5, 3, 3],
    [3, 3, 3],
    [0, 0, 10],
  ]) {
    await request.post(
      `${control}/summary?id=${ids[4]}&likelyPlanet=${a}&unlikelyPlanet=${b}&unsure=${c}`,
    );
    await refresh(page);
    await expect(
      page.getByRole("region", { name: "핫 토픽 목록" }),
    ).toHaveAttribute("aria-busy", "false");
    // At N=10 the target has a higher ID than the other oldest boundary row,
    // but is on page two. Check the complete cursor result via the real UI.
    if (a + b + c === 10)
      await page.getByRole("link", { name: "다음 페이지" }).click();
    if (a + b + c >= 10)
      await expect(page.getByRole("link", { name: title })).toBeVisible();
    else await expect(page.getByRole("link", { name: title })).toHaveCount(0);
    if (new URL(page.url()).search)
      await page
        .getByRole("link", { name: "처음 페이지", exact: true })
        .click();
    await expect(rows(page)).toHaveCount(20);
  }
  await request.post(`${control}/comments?id=${ids[2]}`);
  await refresh(page);
  await expect(rows(page).first()).toContainText("토론 9,999개");
  await expect(rows(page).first()).toContainText("공개 분석 참여자 11명");
});

test("hidden parent disappears on return, direct entry blocks children, restored parent re-enters", async ({
  page,
  request,
}) => {
  await page.goto(root);
  await page.locator(".community-feed h2 a").first().click();
  await expect(
    page.getByRole("heading", { name: "참여자 11명" }),
  ).toBeVisible();
  await request.post(`${control}/hide?id=${ids[2]}`);
  await page.getByRole("link", { name: "이전 화면" }).click();
  await expect(rows(page).first()).toContainText("같은 신호");
  await expect(
    page.getByRole("link", { name: "주기가 짧은 밝기 감소를 함께 살펴봐요" }),
  ).toHaveCount(0);
  const children: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(ids[2]) && /\/analyses|\/comments\?/.test(r.url()))
      children.push(r.url());
  });
  await page.goto(
    `/signal-threads/${ids[2]}?returnTo=%2Fcommunity%2Fhot-topics`,
  );
  await expect(page.getByRole("alert")).toContainText(
    "자료를 찾을 수 없거나 볼 수 없습니다",
  );
  await expect(page.locator(".community-summary")).toHaveCount(0);
  expect(children).toEqual([]);
  await request.post(`${control}/restore?id=${ids[2]}`);
  await page.getByRole("link", { name: "이전 화면" }).click();
  await expect(rows(page).first()).toContainText("주기가 짧은 밝기 감소");
});

test("tab return discards old content, checks permissions once and does not keep stale topics", async ({
  page,
  request,
}) => {
  await page.goto(root);
  await expect(rows(page)).toHaveCount(20);
  await request.post(`${control}/hide?id=${ids[2]}`);
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/community/hot-topics?")) requests++;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(rows(page)).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(rows(page)).toHaveCount(20);
  await expect(rows(page).first()).toContainText("같은 신호");
  expect(requests).toBe(1);
});

test("empty/403/503 retry and expired cursor are distinct, stale data is removed", async ({
  page,
  request,
}) => {
  await page.goto(root);
  await expect(rows(page)).toHaveCount(20);
  for (const status of [503, 403]) {
    await request.post(`${control}/fail?status=${status}`);
    await refresh(page);
    await expect(page.getByRole("alert")).toContainText(
      status === 403 ? "접근 권한이 없습니다" : "정보를 불러오지 못했습니다",
    );
    await expect(rows(page)).toHaveCount(0);
    await request.post(control + "/fail?status=0");
    await page.getByRole("button", { name: "다시 불러오기" }).click();
    await expect(rows(page)).toHaveCount(20);
  }
  await page.goto(root + "?cursor=expired");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("link", { name: "핫 토픽 처음 페이지로" }).click();
  await expect(rows(page)).toHaveCount(20);
  await request.post(control + "/empty");
  await refresh(page);
  await expect(page.getByText(/아직 선정된 핫 토픽이 없습니다/)).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("malformed S18 never becomes an empty success or a locally fixed feed", async ({
  page,
}) => {
  await page.route(apiPath, (route) =>
    route.fulfill({
      json: { items: [{ type: "POST" }], nextCursor: null, hasNext: false },
    }),
  );
  await page.goto(root);
  await expect(page.getByRole("alert")).toContainText("응답 형식");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText(/아직 선정된 핫 토픽이 없습니다/)).toHaveCount(0);
  await page.unroute(apiPath);
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(rows(page)).toHaveCount(20);
});

test("delayed request shows loading; navigation cancels it instead of leaking a late list", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const entry = new Promise<void>((r) => {
    entered = r;
  });
  await page.route(apiPath, async (route) => {
    entered();
    await gate;
    await route
      .fulfill({ json: { items: [], nextCursor: null, hasNext: false } })
      .catch(() => {});
  });
  await page.goto(root);
  await entry;
  await expect(page.getByRole("status")).toContainText(
    "핫 토픽을 불러오고 있습니다",
  );
  await expect(
    page.getByRole("button", { name: "최신 목록 확인" }),
  ).toBeDisabled();
  await page
    .getByRole("navigation", { name: "게시판 종류" })
    .getByRole("link", { name: "전체", exact: true })
    .click();
  release();
  await expect(
    page.getByRole("heading", { name: "탐사 이야기" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "핫 토픽 목록" })).toHaveCount(
    0,
  );
  await expect(rows(page)).toHaveCount(20);
});

test("session expiry redirects to login with return path and removes data", async ({
  page,
}) => {
  await page.goto(root);
  await expect(rows(page)).toHaveCount(20);
  await page.route(apiPath, (route) =>
    route.fulfill({
      status: 401,
      json: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." },
    }),
  );
  await refresh(page);
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fcommunity%2Fhot-topics/);
  await expect(rows(page)).toHaveCount(0);
});

test("1024px keyboard access, no overflow, and small-screen notice", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(root);
  await expect(rows(page)).toHaveCount(20);
  const guide = page.locator(".hot-topic-guide summary");
  await guide.focus();
  await guide.press("Enter");
  await expect(page.locator(".hot-topic-guide")).toHaveAttribute("open", "");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1023, height: 768 });
  await expect(
    page.getByRole("heading", { name: "데스크톱에서 이용해 주세요" }),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
});
