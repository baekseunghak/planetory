import { test, expect, type Page } from "@playwright/test";
import { project, exampleStar } from "../../dev/sky-reference/reference.mjs";
import { stablePhase } from "../../src/features/sky-renderer/model";
const canvas = (page: Page) => page.locator(".galaxy-scene canvas");
const camera = async (page: Page) =>
  JSON.parse((await canvas(page).getAttribute("data-camera"))!);
const panel = (page: Page) =>
  page.getByRole("complementary", { name: "별 상세" });
async function ready(page: Page) {
  await page.goto("/sky");
  await expect(canvas(page)).toHaveAttribute("data-rendered-stars", "1000");
}
async function select(page: Page, seq = 1) {
  await page.locator(`.galaxy-marker[data-marker="${seq}"]`).click();
  await expect(
    panel(page).getByRole("link", { name: /분석 시작/ }),
  ).toBeVisible();
  await expect.poll(async () => (await camera(page)).zoom).toBe(4);
}
test.beforeEach(async ({ request, page }) => {
  await request.post("/api/dev-galaxy-204/reset?count=1000");
  await page.emulateMedia({ reducedMotion: "reduce" });
});
test("same canvas focuses all five owned planets, reads values, and exactly restores the rotated camera", async ({
  page,
}) => {
  await ready(page);
  const originalCanvas = await canvas(page).elementHandle();
  await canvas(page).focus();
  await canvas(page).press("Shift+ArrowRight");
  await canvas(page).press("ArrowLeft");
  await canvas(page).press("+");
  const before = await camera(page);
  await select(page);
  expect(await originalCanvas!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "5");
  await expect(panel(page)).toContainText("내 행성 5개");
  await expect(panel(page)).toContainText("인정된 성과 1건");
  await page.screenshot({
    path: "test-results/detail/206-system.png",
    fullPage: true,
  });
  await panel(page)
    .getByRole("button", { name: "행성 1 fixture-204-p-0", exact: true })
    .click();
  await expect(canvas(page)).toHaveAttribute(
    "data-focused-planet",
    "fixture-204-p-0",
  );
  await expect(page.locator(".planet-information")).toContainText("정보 없음");
  await expect(page.locator(".planet-information")).toContainText("0 ppm (0%)");
  await panel(page)
    .getByRole("button", { name: "행성 2 fixture-204-p-1", exact: true })
    .click();
  await expect(page.locator(".planet-information")).toContainText("5.25일");
  await expect(page.locator(".planet-information")).toContainText(
    "400 ppm (0.04%)",
  );
  await page.screenshot({
    path: "test-results/detail/206-planet.png",
    fullPage: true,
  });
  await panel(page)
    .getByRole("button", { name: "별 전체 보기", exact: true })
    .click();
  await expect(canvas(page)).toHaveAttribute("data-focused-planet", "");
  await panel(page).getByRole("button", { name: "은하로 돌아가기" }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(await camera(page)).toEqual(before);
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "0");
});
test("canvas planet hit matches candidate; empty sky deselects and restores, keyboard list works", async ({
  page,
}) => {
  await ready(page);
  const before = await camera(page);
  await select(page);
  const box = (await canvas(page).boundingBox())!,
    center = project(exampleStar(0), await camera(page), box.width, box.height);
  const phase = stablePhase("fixture-204-p-0"),
    r = 35 + (Math.min(box.width, box.height) * 0.34) / 6;
  await page.mouse.click(
    box.x + center.x + Math.cos(phase) * r,
    box.y + center.y + Math.sin(phase) * r * 0.48,
  );
  await expect(canvas(page)).toHaveAttribute(
    "data-focused-planet",
    "fixture-204-p-0",
  );
  await page.mouse.click(box.x + 15, box.y + 160);
  await expect(panel(page)).toHaveCount(0);
  expect(await camera(page)).toEqual(before);
  await page.getByText("별 목록으로 선택하기", { exact: true }).click();
  await expect(
    page.locator('.discovered-rows button[data-tic-id="900000002"]'),
  ).toHaveCount(1);
  const choice = page.locator(
    '.discovered-rows button[data-tic-id="900000002"]',
  );
  await choice.focus();
  await choice.press("Enter");
  await expect(panel(page)).toContainText("아직 표시할 내 행성이 없어요");
  await panel(page).getByRole("heading", { level: 2 }).press("Escape");
  await expect(choice).toBeFocused();
});
test("actions use server flags, routes preserve TIC and return refetches detail/quests/tiles/meta", async ({
  page,
}) => {
  const counts = { meta: 0, tiles: 0, quests: 0, detail: 0 };
  page.on("request", (req) => {
    const p = new URL(req.url()).pathname;
    if (p === "/api/v1/me/sky") counts.meta++;
    if (p.endsWith("/tiles")) counts.tiles++;
    if (p.endsWith("/quests")) counts.quests++;
    if (p.endsWith("/stars/900000001")) counts.detail++;
  });
  await ready(page);
  await select(page);
  await expect(
    panel(page).getByRole("button", { name: "분석 결과 보기" }),
  ).toBeDisabled();
  const before = { ...counts };
  await panel(page)
    .getByRole("link", { name: /분석 시작/ })
    .click();
  await expect(page).toHaveURL(/\/analysis\/900000001\?returnTo=/);
  await expect(
    page.getByRole("heading", { name: "분석 · TIC 900000001", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "← 이전 화면", exact: true }).click();
  await expect(panel(page)).toContainText("내 행성 5개");
  for (const key of Object.keys(counts) as (keyof typeof counts)[])
    expect(counts[key]).toBeGreaterThan(before[key]);
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    const response = await route.fetch(),
      json = await response.json();
    json.actions = {
      analysis: "review",
      resultAvailable: true,
      boardOpen: false,
      threadCount: 0,
    };
    await route.fulfill({ json });
  });
  await page.reload();
  await expect(
    panel(page).getByRole("link", { name: /분석 다시 보기/ }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "별 게시판 잠김" }),
  ).toBeDisabled();
  await panel(page).getByRole("link", { name: "분석 결과 보기" }).click();
  await expect(page).toHaveURL(/\/results\/900000001\?returnTo=/);
});
test("locked, delayed, stale A and failed responses never masquerade as an empty owned list", async ({
  page,
}) => {
  let finishA: (() => void) | undefined;
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    const response = await route.fetch();
    await new Promise<void>((r) => {
      finishA = r;
    });
    await route.fulfill({ response }).catch(() => {});
  });
  await ready(page);
  await page.locator('.galaxy-marker[data-marker="1"]').click();
  await expect(panel(page)).toContainText("불러오고 있습니다");
  await expect(panel(page)).not.toContainText("아직 표시할 내 행성");
  await page.getByText("별 목록으로 선택하기", { exact: true }).click();
  await expect(
    page.locator('.discovered-rows button[data-tic-id="900000002"]'),
  ).toHaveCount(1);
  await page
    .locator('.discovered-rows button[data-tic-id="900000002"]')
    .click();
  await expect(panel(page)).toContainText("아직 표시할 내 행성이 없어요");
  finishA?.();
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText(
    "TIC 900000002",
  );
  await page.goto("/sky?star=999999999");
  await expect(panel(page)).toContainText("아직 발견하지 않은 별이에요");
  await expect(
    panel(page).getByRole("link", { name: /분석 시작/ }),
  ).toHaveCount(0);
  await panel(page).getByRole("button", { name: "은하로 돌아가기" }).click();
  await page.unroute("**/api/v1/me/stars/900000001");
});
test("malformed count/duplicates fail closed and retry loads valid detail; null catalogue stays unknown", async ({
  page,
}) => {
  let bad = "count";
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    const response = await route.fetch(),
      json = await response.json();
    if (bad === "count") json.planets.count = 6;
    if (bad === "duplicate") json.planets.items[1] = json.planets.items[0];
    json.progress.currentCurveStep = null;
    await route.fulfill({ json });
  });
  await page.goto("/sky?star=900000001");
  await expect(panel(page).getByRole("alert")).toBeVisible();
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "0");
  bad = "duplicate";
  await panel(page)
    .getByRole("button", { name: "별 정보 다시 불러오기" })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("중복");
  bad = "none";
  await panel(page)
    .getByRole("button", { name: "별 정보 다시 불러오기" })
    .click();
  await expect(panel(page)).toContainText("내 행성 5개");
  await panel(page).getByText("관측·발견 정보", { exact: true }).click();
  await expect(page.locator(".star-observations")).toContainText("정보 없음");
});
test("version mismatch refreshes once and never renders stale planets", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    reads++;
    const response = await route.fetch(),
      json = await response.json();
    json.version = "stale-detail";
    await route.fulfill({ json });
  });
  await page.goto("/sky?star=900000001");
  await expect(panel(page).getByRole("alert")).toBeVisible();
  // StrictMode may dispatch an initial request before aborting its mount probe.
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(reads).toBeLessThanOrEqual(3);
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "0");
});
test("1024px docking never overlaps canvas and WebGL failure keeps detail, planets and analysis accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      options?: unknown,
    ) {
      return type === "webgl2"
        ? null
        : original.call(this, type as "2d", options);
    } as typeof original;
  });
  await page.goto("/sky?star=900000001");
  await expect(panel(page)).toContainText("내 행성 5개");
  await expect(
    page.getByRole("heading", { name: "발견한 별 목록" }),
  ).toBeVisible();
  const c = (await page.locator(".discovered-stars").boundingBox())!,
    p = (await panel(page).boundingBox())!;
  expect(p.x + p.width).toBeLessThanOrEqual(c.x + 1);
  await panel(page)
    .getByRole("button", { name: "행성 5 fixture-204-p-4", exact: true })
    .click();
  await expect(page.locator(".planet-information")).toContainText(
    "fixture-204-p-4",
  );
  await panel(page)
    .getByRole("link", { name: /분석 시작/ })
    .click();
  await expect(page).toHaveURL(/\/analysis\/900000001/);
});

test("session expiration removes an in-flight private detail and late data cannot restore it", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    const response = await route.fetch();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response }).catch(() => {});
  });
  await page.route("**/api/v1/me/stars/900000002", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "UNAUTHENTICATED", message: "세션이 만료되었습니다." },
    }),
  );
  await ready(page);
  await page.locator('.galaxy-marker[data-marker="1"]').click();
  await expect(panel(page)).toContainText("불러오고 있습니다");
  await page.getByText("별 목록으로 선택하기", { exact: true }).click();
  await expect(
    page.locator('.discovered-rows button[data-tic-id="900000002"]'),
  ).toHaveCount(1);
  await page
    .locator('.discovered-rows button[data-tic-id="900000002"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  release?.();
  await expect(panel(page)).toHaveCount(0);
  await expect(canvas(page)).toHaveCount(0);
});

test("successful change notification refreshes metadata, pages, quests and selected detail without awarding client achievements", async ({
  page,
  request,
}) => {
  let questReads = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.endsWith("/quests")) questReads++;
  });
  await ready(page);
  await select(page);
  const before = await camera(page),
    questsBefore = questReads;
  const response = await request.post("/api/dev-galaxy-204/status"),
    change = await response.json();
  await page.evaluate(async (change) => {
    const modulePath = "/src/features/sky-data/events.ts";
    const { publishSkyChange } = await import(modulePath);
    publishSkyChange("galaxy-fixture-204-member", change);
  }, change);
  await expect(panel(page)).toContainText("아직 표시할 내 행성이 없어요");
  await expect(panel(page)).toContainText("인정된 성과 0건");
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "0");
  expect(questReads).toBeGreaterThan(questsBefore);
  expect(await camera(page)).toEqual(before);
});
