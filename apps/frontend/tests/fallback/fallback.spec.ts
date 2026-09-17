import { test, expect, type Page } from "@playwright/test";
const rows = (p: Page) => p.locator(".discovered-rows button");
const panel = (p: Page) => p.getByRole("complementary", { name: "별 상세" });
const listHeading = (p: Page) =>
  p.getByRole("heading", { name: "발견한 별 목록" });
const cam = async (p: Page) =>
  JSON.parse((await p.locator("canvas").getAttribute("data-camera"))!);
async function list(p: Page) {
  await p.goto("/sky");
  await p.getByRole("button", { name: "별 목록으로 선택하기" }).click();
  await expect(rows(p)).toHaveCount(20);
}
async function noWebGL(p: Page) {
  await p.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      return type.startsWith("webgl")
        ? null
        : get.call(this, type as "2d", ...args);
    } as typeof get;
  });
}
test.beforeEach(async ({ request, page }) => {
  await request.post("/api/dev-galaxy-204/reset?count=1000");
  await page.emulateMedia({ reducedMotion: "reduce" });
});
test("creation failure: new unsubmitted tutorial is listed, locked TICs hidden, same detail and analysis accessible", async ({
  request,
  page,
}) => {
  await request.post("/api/dev-galaxy-204/reset?count=1");
  await noWebGL(page);
  await page.goto("/sky");
  await expect(listHeading(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await page.locator(".fallback-quests summary").click();
  await expect(page.locator(".fallback-quests")).toContainText(
    "튜토리얼 2 · 잠김",
  );
  await expect(page.locator(".discovered-stars")).not.toContainText(
    "900000002",
  );
  await expect(
    page.getByRole("button", { name: "3D 지도 보기" }),
  ).toBeDisabled();
  await rows(page).focus();
  await rows(page).press("Enter");
  await expect(panel(page)).toContainText("내 행성 0개");
  await expect(
    panel(page).getByRole("button", { name: "분석 결과 보기" }),
  ).toBeDisabled();
  await expect(panel(page)).toContainText("아직 표시할 내 행성이 없어요");
  await panel(page)
    .getByRole("link", { name: /분석 시작/ })
    .click();
  await expect(page).toHaveURL(/\/analysis\/900000001\?returnTo=/);
});
test("independent discovered cursor pages, previous page, offscreen selection and keyboard focus return", async ({
  page,
}) => {
  const urls: URL[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/v1/me/stars") urls.push(u);
  });
  await list(page);
  await expect(listHeading(page)).toBeFocused();
  await page.getByRole("button", { name: "다음 별 목록" }).click();
  await expect(rows(page).first()).toContainText("900000021");
  await expect(listHeading(page)).toBeFocused();
  expect(
    urls.every(
      (u) =>
        u.searchParams.get("scope") === "discovered" &&
        u.searchParams.get("sort") === "recent" &&
        u.searchParams.get("size") === "20",
    ),
  ).toBe(true);
  expect(urls.at(-1)!.searchParams.get("cursor")).toBeTruthy();
  await rows(page).first().focus();
  await rows(page).first().press("Enter");
  await expect(panel(page)).toContainText("TIC 900000021");
  await panel(page).getByRole("heading", { level: 2 }).press("Escape");
  await expect(rows(page).first()).toBeFocused();
  await page.getByRole("button", { name: "이전 별 목록" }).click();
  await expect(rows(page).first()).toContainText("900000001");
  expect(urls.at(-1)!.searchParams.has("cursor")).toBe(false);
});
test("real context loss/restoration keeps selection and camera; restoration never steals detail focus", async ({
  page,
}) => {
  await page.goto("/sky");
  const canvas = page.locator("canvas");
  await expect(canvas).toHaveAttribute("data-rendered-stars", "1000");
  await canvas.focus();
  await canvas.press("ArrowLeft");
  await canvas.press("+");
  const before = await cam(page);
  await page.locator('.galaxy-marker[data-marker="1"]').click();
  await expect(panel(page).getByRole("heading", { level: 2 })).toBeFocused();
  const selected = await cam(page);
  const supported = await canvas.evaluate((node) => {
    const gl = (node as HTMLCanvasElement).getContext("webgl2")!;
    const ext = gl.getExtension("WEBGL_lose_context");
    (window as unknown as { restore207: () => void }).restore207 = () =>
      ext!.restoreContext();
    ext?.loseContext();
    return !!ext;
  });
  expect(supported).toBe(true);
  await expect(listHeading(page)).toBeVisible();
  await expect(panel(page)).toContainText("TIC 900000001");
  await expect(panel(page).getByRole("heading", { level: 2 })).toBeFocused();
  await page.evaluate(() =>
    (window as unknown as { restore207: () => void }).restore207(),
  );
  await expect(
    page.getByRole("button", { name: "3D 지도 보기" }),
  ).toBeEnabled();
  await expect(listHeading(page)).toBeVisible();
  await page.getByRole("button", { name: "3D 지도 보기" }).click();
  await expect(canvas).toBeFocused();
  expect(await cam(page)).toEqual(selected);
  await panel(page).getByRole("button", { name: "은하로 돌아가기" }).click();
  expect(await cam(page)).toEqual(before);
});
test("list is independent of tile failures; quest failure does not remove star access", async ({
  page,
}) => {
  await page.route("**/api/v1/me/sky/tiles?*", (r) =>
    r.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "타일 실패" },
    }),
  );
  await page.route("**/api/v1/me/quests", (r) =>
    r.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "퀘스트 실패" },
    }),
  );
  await list(page);
  await page.locator(".fallback-quests summary").click();
  await expect(page.locator(".fallback-quests")).toContainText(
    "별 목록과 상세는 계속 이용",
  );
  await rows(page).nth(1).click();
  await expect(panel(page)).toContainText("TIC 900000002");
  await expect(
    panel(page).getByRole("link", { name: /분석 시작/ }),
  ).toBeVisible();
});
test("empty, list server error, retry, malformed response and repeated cursor never leak stale rows", async ({
  page,
}) => {
  let mode = "error";
  await page.route("**/api/v1/me/stars?*", async (r) => {
    if (mode === "error")
      return r.fulfill({
        status: 503,
        json: { code: "DEPENDENCY_UNAVAILABLE", message: "잠시 기다려 주세요" },
      });
    if (mode === "empty")
      return r.fulfill({
        json: { items: [], nextCursor: null, hasNext: false },
      });
    const response = await r.fetch(),
      value = await response.json();
    if (mode === "malformed") value.items.push(value.items[0]);
    if (
      mode === "loop" &&
      new URL(r.request().url()).searchParams.has("cursor")
    )
      value.nextCursor = new URL(r.request().url()).searchParams.get("cursor");
    return r.fulfill({ json: value });
  });
  await page.goto("/sky");
  await page.getByRole("button", { name: "별 목록으로 선택하기" }).click();
  await expect(page.locator(".discovered-stars")).toContainText(
    "잠시 기다려 주세요",
  );
  mode = "empty";
  await page.getByRole("button", { name: "별 목록 다시 불러오기" }).click();
  await expect(page.locator(".discovered-stars")).toContainText(
    "아직 발견한 별이 없습니다.",
  );
  mode = "malformed";
  await page.getByRole("button", { name: "3D 지도 보기" }).click();
  await page.getByRole("button", { name: "별 목록으로 선택하기" }).click();
  await expect(page.locator(".discovered-stars")).toContainText("응답 형식");
  await expect(rows(page)).toHaveCount(0);
  mode = "loop";
  await page.getByRole("button", { name: "별 목록 다시 불러오기" }).click();
  await expect(rows(page)).toHaveCount(20);
  await page.getByRole("button", { name: "다음 별 목록" }).click();
  await expect(page.locator(".discovered-stars")).toContainText(
    "같은 목록이 반복",
  );
  await expect(rows(page)).toHaveCount(0);
  await page.getByRole("button", { name: "처음 목록부터 확인" }).click();
  await expect(rows(page)).toHaveCount(20);
});
test("keyboard map controls and list switches preserve camera, 1024 layout and visible text states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/sky");
  const canvas = page.locator("canvas");
  await expect(canvas).toHaveAttribute("data-rendered-stars", "1000");
  const initial = await cam(page);
  await canvas.focus();
  await canvas.press("ArrowRight");
  await canvas.press("+");
  const changed = await cam(page);
  expect(changed.x).not.toBe(initial.x);
  expect(changed.zoom).toBeGreaterThan(initial.zoom);
  await page.getByRole("button", { name: "별 목록으로 선택하기" }).focus();
  await page.keyboard.press("Enter");
  await expect(listHeading(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".fallback-quests summary")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(rows(page).first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("heading", { level: 2 })).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await panel(page).getByRole("heading", { level: 2 }).press("Escape");
  await page.getByRole("button", { name: "3D 지도 보기" }).click();
  await expect(canvas).toBeFocused();
  expect(await cam(page)).toEqual(changed);
});
test("401 on list clears the private scene", async ({ page }) => {
  await page.route("**/api/v1/me/stars?*", (r) =>
    r.fulfill({
      status: 401,
      json: { code: "UNAUTHENTICATED", message: "다시 로그인해 주세요" },
    }),
  );
  await page.goto("/sky");
  await page.getByRole("button", { name: "별 목록으로 선택하기" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("list return from analysis keeps view/selection; successful change resets cursor and refreshes rows", async ({
  page,
  request,
}) => {
  const urls: URL[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/v1/me/stars") urls.push(u);
  });
  await list(page);
  await rows(page).first().click();
  await panel(page)
    .getByRole("link", { name: /분석 시작/ })
    .click();
  await page.getByRole("link", { name: "이전 화면으로" }).click();
  await expect(listHeading(page)).toBeVisible();
  await expect(panel(page)).toContainText("TIC 900000001");
  await panel(page)
    .getByRole("button", { name: "별 목록으로 돌아가기" })
    .click();
  await page.getByRole("button", { name: "다음 별 목록" }).click();
  await expect(rows(page).first()).toContainText("900000021");
  const changed = await (
    await request.post("/api/dev-galaxy-204/status")
  ).json();
  await page.evaluate(async (event) => {
    const modulePath = "/src/features/sky-data/events.ts";
    const { publishSkyChange } = await import(modulePath);
    publishSkyChange("galaxy-fixture-204-member", event);
  }, changed);
  await expect(rows(page).first()).toContainText("900000001");
  await expect(rows(page).first()).toContainText("탐색 완료 · 내 행성 0개");
  expect(urls.at(-1)!.searchParams.has("cursor")).toBe(false);
});
test("late first response is discarded after hiding and reopening list; 403 never shows old rows", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  let first = true,
    denied = false;
  await page.route("**/api/v1/me/stars?*", async (r) => {
    if (denied)
      return r.fulfill({
        status: 403,
        json: { code: "FORBIDDEN", message: "접근 불가" },
      });
    const response = await r.fetch(),
      value = await response.json();
    if (first) {
      first = false;
      value.items = [{ ...value.items[0], ticId: "999999991" }];
      value.hasNext = false;
      value.nextCursor = null;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await r.fulfill({ json: value }).catch(() => {});
  });
  await page.goto("/sky");
  await page.getByRole("button", { name: "별 목록으로 선택하기" }).click();
  await expect.poll(() => !!release).toBe(true);
  await expect(page.locator(".discovered-status")).toContainText(
    "불러오고 있습니다",
  );
  await page.getByRole("button", { name: "3D 지도 보기" }).click();
  await page.getByRole("button", { name: "별 목록으로 선택하기" }).click();
  await expect(rows(page)).toHaveCount(20);
  release?.();
  await expect(page.locator(".discovered-rows")).not.toContainText("999999991");
  denied = true;
  await page.getByRole("button", { name: "3D 지도 보기" }).click();
  await page.getByRole("button", { name: "별 목록으로 선택하기" }).click();
  await expect(page.locator(".discovered-stars")).toContainText(
    "이 별 목록에 접근할 수 없습니다",
  );
  await expect(rows(page)).toHaveCount(0);
});
