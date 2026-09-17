import { test, expect, type Page } from "@playwright/test";
import { project, exampleStar } from "../../dev/sky-reference/reference.mjs";
import { stablePhase } from "../../src/features/sky-renderer/model";
const camera = async (p: Page) =>
  JSON.parse((await p.locator("canvas").getAttribute("data-camera"))!);
async function start(page: Page) {
  await page.goto("/sky");
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered-stars",
    "1000",
  );
  await expect(page.locator(".galaxy-marker:not([hidden])")).toHaveCount(6);
}
async function point(page: Page, index: number) {
  const box = (await page.locator("canvas").boundingBox())!;
  const pos = project(
    exampleStar(index),
    await camera(page),
    box.width,
    box.height,
  );
  return { x: box.x + pos.x, y: box.y + pos.y };
}
test.beforeEach(async ({ request }) => {
  await request.post("/api/dev-galaxy-204/reset?count=1000");
});
test("high zoom keeps anchor hit and pooled DOM; cancelled drag does not resume after focus returns", async ({
  page,
}) => {
  await start(page);
  const canvas = page.locator("canvas"),
    pos = await point(page, 0);
  await page.mouse.move(pos.x, pos.y);
  for (let i = 0; i < 15; i++) {
    const before = (await camera(page)).zoom;
    await page.mouse.wheel(0, -500);
    await expect
      .poll(async () => (await camera(page)).zoom)
      .toBeGreaterThan(before);
    if (i === 3) {
      const actual = await point(page, 0);
      await page.mouse.move(actual.x, actual.y);
      await expect(page.getByRole("tooltip")).toContainText("900000001");
      await page.mouse.click(actual.x, actual.y);
      await expect.poll(async () => (await camera(page)).zoom).toBe(4);
    }
  }
  await expect
    .poll(async () => (await camera(page)).zoom)
    .toBeGreaterThan(1000);
  await expect(page.getByTestId("selection-summary")).toContainText(
    "900000001",
  );
  await canvas.focus();
  await canvas.press("Escape");
  await canvas.press("Home");
  await expect(page.locator(".galaxy-marker:not([hidden])")).toHaveCount(6);
  await expect(page.getByTestId("marker-pool")).toHaveAttribute(
    "data-pool-size",
    "6",
  );
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 160);
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const before = await camera(page);
  await page.mouse.move(box.x + 90, box.y + 190);
  await page.mouse.up();
  expect(await camera(page)).toEqual(before);
});
test("rotation drag, shift/right/mode pan and pointer-anchored wheel preserve selection and update bbox", async ({
  page,
}) => {
  const boxes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/sky/tiles?")) boxes.push(r.url());
  });
  await start(page);
  const initial = await camera(page);
  const box = (await page.locator("canvas").boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 170);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 190, { steps: 8 });
  await page.mouse.up();
  expect((await camera(page)).yaw).toBeGreaterThan(initial.yaw);
  await expect(page.getByTestId("selection-summary")).toHaveCount(0);
  const rotated = await camera(page);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 210, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const moved = await camera(page);
  expect(moved.x).not.toBe(rotated.x);
  expect(moved.yaw).toBe(rotated.yaw);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + 245, box.y + 220, { steps: 3 });
  await page.mouse.up({ button: "right" });
  expect((await camera(page)).x).not.toBe(moved.x);
  await page.getByRole("button", { name: "이동 모드", exact: true }).click();
  const before = await camera(page);
  await page.mouse.move(box.x + 120, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 200, { steps: 4 });
  await page.mouse.up();
  expect((await camera(page)).yaw).toBe(before.yaw);
  await page.mouse.wheel(0, -300);
  await expect
    .poll(async () => (await camera(page)).zoom)
    .toBeGreaterThan(before.zoom);
  await page.mouse.wheel(0, -500);
  await page.mouse.wheel(0, -500);
  await expect.poll(() => new Set(boxes).size).toBeGreaterThan(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("GPU projected star hover/click matches TIC after rotation and 1024px resize; no invisible cluster hit", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 1024, height: 850 });
  const canvas = page.locator("canvas");
  await canvas.focus();
  await canvas.press("Shift+ArrowRight");
  const pos = await point(page, 0);
  await page.mouse.move(pos.x, pos.y);
  await expect(page.getByRole("tooltip")).toContainText("TIC 900000001");
  await page.mouse.click(pos.x, pos.y);
  await expect(page.getByTestId("selection-summary")).toContainText(
    "900000001",
  );
  await expect(canvas).toHaveAttribute("data-rendered-planets", "5");
  await page.getByRole("button", { name: "은하로 돌아가기" }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + 160);
  await expect(page.getByTestId("selection-summary")).toHaveCount(0);
});
test("keyboard navigation, selection, pan, zoom limits and full view keep focus without traps", async ({
  page,
}) => {
  await start(page);
  const canvas = page.locator("canvas");
  await canvas.focus();
  await canvas.press("]");
  await expect(page.getByRole("tooltip")).toBeVisible();
  await canvas.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "별 상세" }),
  ).toBeVisible();
  await expect.poll(async () => (await camera(page)).zoom).toBe(4);
  const id = await page.getByTestId("selection-summary").textContent();
  await canvas.press("ArrowRight");
  await canvas.press("+");
  await expect(canvas).toBeFocused();
  await expect(page.getByTestId("selection-summary")).toHaveText(id!);
  await canvas.press("Home");
  await expect
    .poll(async () => (await camera(page)).zoom)
    .toBeLessThanOrEqual(1.5);
  await canvas.press("Escape");
  await expect(page.getByTestId("selection-summary")).toHaveCount(0);
  await canvas.press("Tab");
  await expect(canvas).not.toBeFocused();
});
test("completion and allowed skip stay hidden after reload/reopen, challenge and star records survive; marker nodes recycle", async ({
  page,
  request,
}) => {
  await start(page);
  const pool = page.getByTestId("marker-pool");
  await expect(pool).toHaveAttribute("data-pool-size", "6");
  await page
    .locator('.galaxy-marker[data-marker="1"]')
    .evaluate((el) => ((el as HTMLElement).dataset.reuseProof = "original"));
  await page.locator("canvas").focus();
  await page.locator("canvas").press("ArrowRight");
  await expect(page.locator('.galaxy-marker[data-marker="1"]')).toHaveAttribute(
    "data-reuse-proof",
    "original",
  );
  await request.post("/api/dev-galaxy-204/complete-tutorial?seq=1");
  await request.post(
    "/api/dev-galaxy-204/complete-tutorial?seq=2&reason=skipped",
  );
  await page.reload();
  await expect(page.locator('.galaxy-marker[data-marker="3"]')).toBeVisible();
  await expect(
    page.locator('.galaxy-marker[data-marker="1"]:visible'),
  ).toHaveCount(0);
  await expect(
    page.locator('.galaxy-marker[data-marker="2"]:visible'),
  ).toHaveCount(0);
  await expect(page.locator('.galaxy-marker[data-marker="!"]')).toBeVisible();
  await expect(page.getByTestId("sky-total")).toHaveText("1,000");
  await request.post("/api/dev-galaxy-204/reopen-tutorial?seq=1");
  await page.reload();
  await expect(page.locator('.galaxy-marker[data-marker="3"]')).toBeVisible();
  await expect(
    page.locator('.galaxy-marker[data-marker="1"]:visible'),
  ).toHaveCount(0);
});
test("unknown/failed quest state hides all badges, retry loads state without changing stars", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/v1/me/quests", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "DEPENDENCY_UNAVAILABLE",
            message: "temporary",
          }),
        })
      : route.continue(),
  );
  await page.goto("/sky");
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered-stars",
    "1000",
  );
  await expect(
    page.getByRole("button", { name: "번호 다시 확인" }),
  ).toBeVisible();
  await expect(page.locator(".galaxy-marker:not([hidden])")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "번호 다시 확인" }).click();
  await expect(page.locator(".galaxy-marker:not([hidden])")).toHaveCount(6);
});

test("challenge comes only from quests and disappears after its round ends", async ({
  page,
}) => {
  let active = true;
  await page.route("**/api/v1/me/quests", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.challenge = active
      ? { ...body.challenge, unlocked: true, ticId: "900000008" }
      : {
          round: null,
          eligible: false,
          unlocked: false,
          ticId: null,
          progressStage: null,
          participantCount: null,
        };
    await route.fulfill({ response, json: body });
  });
  await start(page);
  await expect(
    page.locator('.galaxy-marker[data-marker="!"]:not([hidden])'),
  ).toHaveAttribute("data-tic-id", "900000008");
  active = false;
  await page.reload();
  await expect(
    page.locator('.galaxy-marker[data-marker="1"]:not([hidden])'),
  ).toBeVisible();
  await expect(
    page.locator('.galaxy-marker[data-marker="!"]:not([hidden])'),
  ).toHaveCount(0);
});
test("selected personal planet tooltip uses the rendered orbit position and matching candidate ID", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await start(page);
  await page.locator('.galaxy-marker[data-marker="1"]').click();
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered-planets",
    "5",
  );
  const box = (await page.locator("canvas").boundingBox())!;
  const center = project(
    exampleStar(0),
    await camera(page),
    box.width,
    box.height,
  );
  const id = "fixture-204-p-0";
  const phase = stablePhase(id);
  const radius = 35 + (1 / 6) * Math.min(box.width, box.height) * 0.34;
  const x = box.x + center.x + Math.cos(phase) * radius,
    y = box.y + center.y + Math.sin(phase) * radius * 0.48;
  await page.mouse.move(x, y);
  await expect(page.getByRole("tooltip")).toContainText(id);
  await expect(page.getByRole("tooltip")).toContainText("주기 정보 없음");
  await page.mouse.click(x, y);
  await expect(page.getByTestId("selection-summary")).toContainText(id);
});
test("2501 paginated data preserves selected ID and camera through zoom/page replacement", async ({
  page,
  request,
}) => {
  await request.post("/api/dev-galaxy-204/reset?count=2501");
  await page.goto("/sky");
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered-stars",
    "2501",
  );
  await page.locator('.galaxy-marker[data-marker="1"]').click();
  await expect.poll(async () => (await camera(page)).zoom).toBe(4);
  const box = (await page.locator("canvas").boundingBox())!;
  const p = await point(page, 0);
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, -900);
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(1);
  await expect(page.getByTestId("selection-summary")).toContainText(
    "900000001",
  );
  await page.getByRole("button", { name: "은하로 돌아가기" }).click();
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered-stars",
    "2501",
  );
  await expect(page.getByTestId("selection-summary")).toHaveCount(0);
  expect(box.width).toBeGreaterThan(500);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
