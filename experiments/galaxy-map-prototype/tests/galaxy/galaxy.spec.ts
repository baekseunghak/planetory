import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
const errors: string[] = [];
test.beforeEach(({ page }) => {
  page.on("pageerror", (e) => errors.push(e.message));
});
test.afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});
async function login(page: Page) {
  await page.goto("/login");
  await page.getByRole("link", { name: "SSAFY로 시작하기" }).click();
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered",
    "50000",
    { timeout: 45000 },
  );
  await expect(page.locator(".star-detail")).toContainText("TOI-270");
}
test("50,000 unique stars, original cookie isolation and complete detail panel", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "planetory_fixture",
      value: "original-session-sentinel",
      domain: "127.0.0.1",
      path: "/api",
    },
  ]);
  await login(page);
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "planetory_fixture")?.value).toBe(
    "original-session-sentinel",
  );
  expect(
    cookies.find((c) => c.name === "planetory_galaxy_fixture"),
  ).toBeTruthy();
  const data = await (await page.request.get("/api/map/galaxy")).json();
  expect(data.count).toBe(50000);
  expect(new Set(data.stars.map((s: { id: string }) => s.id)).size).toBe(50000);
  await expect(page.locator(".star-detail")).toContainText("관측 회차");
  await expect(page.locator(".star-detail")).toContainText("밝기 등급");
  await expect(page.locator(".star-detail .grade-info")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "분석 계속", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".galaxy-orbits .orbit-planet")).toHaveCount(2);
  await page.screenshot({ path: "test-results/galaxy/01-overview.png" });
});
test("rotation, pan, zoom, reset and an arbitrary particle selection remain aligned", async ({
  page,
}) => {
  await login(page);
  const point = page.locator('[data-star-id="259377017"]');
  const before = await point.boundingBox();
  await page.mouse.move(700, 650);
  await page.mouse.down();
  await page.mouse.move(940, 730, { steps: 16 });
  await page.mouse.up();
  const after = await point.boundingBox();
  expect(
    Math.hypot(after!.x - before!.x, after!.y - before!.y),
  ).toBeGreaterThan(30);
  await page.screenshot({ path: "test-results/galaxy/04-rotated.png" });
  await point.click();
  await expect(page.locator(".star-detail")).toContainText("TIC 259377017");
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  await expect
    .poll(async () => {
      const b = await point.boundingBox();
      return Math.abs(b!.x - before!.x) + Math.abs(b!.y - before!.y);
    })
    .toBeLessThan(2);
  await page.getByRole("button", { name: "이동 모드", exact: true }).click();
  await page.mouse.move(650, 720);
  await page.mouse.down();
  await page.mouse.move(730, 760, { steps: 8 });
  await page.mouse.up();
  const panned = await point.boundingBox();
  expect(panned!.x - before!.x).toBeCloseTo(80, 0);
  expect(panned!.y - before!.y).toBeCloseTo(40, 0);
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  await page.mouse.move(830, 520);
  await page.mouse.wheel(0, -630);
  await expect(page.locator(".map-tools")).not.toContainText("100.0%");
  await page.screenshot({ path: "test-results/galaxy/02-closeup.png" });
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  await page.getByRole("button", { name: "별 선택 해제", exact: true }).click();
  await page.mouse.move(650, 460);
  const hover = page.locator(".star-hit.hovered");
  await expect(hover).toBeVisible();
  const id = await hover.getAttribute("data-star-id");
  await hover.click();
  await expect(page.locator(".star-detail")).toContainText("TIC " + id);
  await page.mouse.click(800, 990);
  await expect(page.locator(".star-detail")).toHaveCount(0);
});
test("search, analysis, results, community and camera restoration", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "별 검색과 목록" }).click();
  await page.getByPlaceholder("TIC ID", { exact: true }).fill("910000777");
  await expect(page.locator(".map-list-item")).toHaveCount(1);
  await page.locator(".map-list-item").click();
  await expect(page.locator(".star-detail")).toContainText("TIC 910000777");
  const camera = await page.locator("canvas").getAttribute("data-camera");
  await page.locator('.star-detail a[href="/analysis/910000777"]').click();
  await expect(page).toHaveURL(/\/analysis\/910000777/);
  await expect(page.getByLabel("반복 주기 (일)")).toBeVisible();
  await page.goBack();
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered",
    "50000",
  );
  await expect(page.locator("canvas")).toHaveAttribute("data-camera", camera!);
  await page.getByRole("link", { name: "스레드", exact: true }).click();
  await expect(page).toHaveURL(/\/community\/stars\/910000777/);
  await page.goto("/sky?star=259377017");
  await expect(
    page.getByRole("link", { name: "결과", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "결과", exact: true }).click();
  await expect(page).toHaveURL(/\/results\/259377017/);
});
test("resize, keyboard, WebGL loss and malformed API recovery", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(page.locator(".star-detail")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const box = await page.locator(".star-detail").boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(1024);
  const selectedBox = await page
    .locator('[data-star-id="259377017"]')
    .boundingBox();
  expect(selectedBox!.x + selectedBox!.width).toBeLessThan(box!.x);
  await page.screenshot({ path: "test-results/galaxy/03-1024px.png" });
  await page.locator(".sky-surface").focus();
  await page.keyboard.press("+");
  await expect(page.locator(".map-tools")).toContainText("125.0%");
  await page.keyboard.press("Home");
  await expect(page.locator(".map-tools")).toContainText("100.0%");
  await page.evaluate(() => {
    const gl = document.querySelector("canvas")!.getContext("webgl")!;
    gl.getExtension("WEBGL_lose_context")!.loseContext();
  });
  await expect(
    page.getByRole("heading", { name: "별 목록 · WebGL 대체" }),
  ).toBeVisible();
  await page.route("**/api/map/galaxy", (r) =>
    r.fulfill({ json: { nodes: [] } }),
  );
  await page.reload();
  await expect(
    page.getByRole("alert").filter({ hasText: "은하 데이터 형식" }),
  ).toBeVisible();
  await page.unroute("**/api/map/galaxy");
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered",
    "50000",
  );
});
test("report actual 50k overview frame timing without claiming SRS acceptance", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  const metrics = await page.evaluate(async () => {
    const gl = document.querySelector("canvas")!.getContext("webgl")!,
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : "unavailable";
    const frames: number[] = [];
    let last = 0,
      start = 0;
    await new Promise<void>((resolve) => {
      const step = (time: number) => {
        if (!start) start = time;
        if (last) frames.push(time - last);
        last = time;
        if (time - start >= 5000) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    frames.sort((a, b) => a - b);
    return {
      renderer,
      samples: frames.length,
      p95: frames[Math.floor(frames.length * 0.95)],
      worst: frames.at(-1),
      drawCalls: document.querySelector("canvas")!.dataset.drawCalls,
      rendered: document.querySelector("canvas")!.dataset.rendered,
      viewport: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
    };
  });
  fs.mkdirSync("test-results/galaxy", { recursive: true });
  fs.writeFileSync(
    "test-results/galaxy/observation.json",
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        scope: "50k overview observation only; not SRS AT-71 acceptance",
        ...metrics,
      },
      null,
      2,
    ),
  );
  expect(Number(metrics.rendered)).toBe(50000);
  expect(metrics.samples).toBeGreaterThan(30);
});

test("wide zoom keeps the pointed star aligned and survives distant pan, rotation and reload", async ({
  page,
}) => {
  await login(page);
  const canvas = page.locator("canvas");
  const camera = async () =>
    JSON.parse((await canvas.getAttribute("data-camera"))!);
  const wheel = async (delta: number) => {
    const before = await camera();
    const expected = Math.max(
      0.001,
      Math.min(10000, before.zoom * Math.exp(-delta * 0.0012)),
    );
    await page.mouse.wheel(0, delta);
    await expect
      .poll(async () => (await camera()).zoom)
      .toBeCloseTo(expected, 7);
  };
  const point = page.locator('[data-star-id="259377017"]');
  const initial = (await point.boundingBox())!;
  const anchor = {
    x: initial.x + initial.width / 2,
    y: initial.y + initial.height / 2,
  };
  await page.mouse.move(anchor.x, anchor.y);
  for (let i = 0; i < 4; i++) await wheel(-2400);
  await expect(
    page.getByRole("button", { name: "확대", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("현재 배율")).toHaveText("10,000×");
  const enlarged = (await point.boundingBox())!;
  expect(
    Math.hypot(enlarged.x - initial.x, enlarged.y - initial.y),
  ).toBeLessThan(1);
  // Check the GPU point itself, not only the DOM marker at the mathematical position.
  const pixel = await page.evaluate(
    (anchor) =>
      new Promise<{ color: number[]; error: number }>((resolve) => {
        requestAnimationFrame(() => {
          const c = document.querySelector("canvas")!;
          const r = c.getBoundingClientRect();
          const gl = c.getContext("webgl")!;
          const color = new Uint8Array(4);
          gl.readPixels(
            Math.floor(((anchor.x - r.left) * c.width) / r.width),
            Math.floor(((r.bottom - anchor.y) * c.height) / r.height),
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            color,
          );
          resolve({ color: [...color], error: gl.getError() });
        });
      }),
    anchor,
  );
  expect(pixel.error).toBe(0);
  expect(Math.max(...pixel.color.slice(0, 3))).toBeGreaterThan(30);
  await page.screenshot({ path: "test-results/galaxy/05-extreme-closeup.png" });
  const near = await camera();
  await wheel(-2400);
  expect(await camera()).toEqual(near);
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  await expect.poll(async () => (await camera()).zoom).toBe(1);
  await page.mouse.move(650, 650);
  for (let i = 0; i < 3; i++) await wheel(2400);
  await expect(
    page.getByRole("button", { name: "축소", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("현재 배율")).toHaveText("0.1%");
  await expect(
    page.locator(".star-hit,.galaxy-orbits,.galaxy-connector"),
  ).toHaveCount(0);
  await page.screenshot({ path: "test-results/galaxy/06-distant-galaxy.png" });
  const distant = await camera();
  expect(Math.abs(distant.x)).toBeGreaterThan(20000);
  await wheel(2400);
  expect(await camera()).toEqual(distant);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(750, 690, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await camera()).x).not.toBe(distant.x);
  const panned = await camera();
  await page.mouse.down();
  await page.mouse.move(830, 710, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await camera()).yaw).not.toBe(panned.yaw);
  const rotated = await camera();
  expect(rotated.x).toBe(panned.x);
  expect(rotated.y).toBe(panned.y);
  expect(Object.values(rotated).every(Number.isFinite)).toBe(true);
  await page.reload();
  await expect(canvas).toHaveAttribute("data-rendered", "50000");
  await expect.poll(camera).toEqual(rotated);
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  await expect(page.getByLabel("현재 배율")).toHaveText("100.0%");
  await expect(point).toBeVisible();
  await point.click();
  await expect(page.locator(".star-detail")).toContainText("TIC 259377017");
});
