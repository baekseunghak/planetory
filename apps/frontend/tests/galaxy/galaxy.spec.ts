import { test, expect, type Page } from "@playwright/test";
const stats = async (page: Page) =>
  JSON.parse((await page.getByTestId("render-stats").textContent()) || "null");
const view = async (page: Page) =>
  JSON.parse((await page.getByTestId("render-view").textContent()) || "{}");
async function start(page: Page, reference = false) {
  await page.goto("/sky" + (reference ? "?reference=1" : ""));
  await expect.poll(async () => (await stats(page))?.stars ?? 0).toBe(1000);
  await page.getByText("204 렌더 검증 도구", { exact: true }).click();
}
test.beforeEach(async ({ request }) => {
  await request.post("/api/dev-galaxy-204/reset?count=1000");
});
test("initial view requests individual pages and renders all 1000 without overview or orbit instances", async ({
  page,
}) => {
  const tiles: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/sky/tiles?")) tiles.push(r.url());
  });
  await start(page);
  const s = await stats(page);
  expect(s.stars).toBe(1000);
  expect(s.bodyDrawCalls).toBe(2);
  expect(s.planets).toBe(0);
  expect(s.orbitStars).toBe(0);
  expect(s.detailedSystems).toBe(0);
  expect(s).not.toHaveProperty("clusters");
  expect(tiles.length).toBeGreaterThan(0);
  await expect(page.getByTestId("sky-total")).toHaveText("1,000");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("1 10 100 1000 reference camera screenshots, rotation and GPU pixel projection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page, true);
  for (const n of [1, 10, 100, 1000]) {
    await page
      .getByRole("button", { name: "별 " + n + "개 계정", exact: true })
      .click();
    await expect(page.getByTestId("sky-total")).toHaveText(n.toLocaleString());
    await page
      .getByRole("button", { name: "원본 카메라", exact: true })
      .click();
    await expect.poll(async () => (await stats(page)).stars).toBe(n);
    await page.getByText("204 렌더 검증 도구", { exact: true }).click();
    await page
      .locator("canvas")
      .screenshot({ path: "test-results/galaxy/reference-" + n + ".png" });
    if (n === 1) {
      // Independent projection from the agreed original camera; actual GPU pixel must be lit.
      const hit = await page.evaluate(() => {
        const gl = document.querySelector("canvas")!.getContext("webgl2")!;
        const x = 760,
          y = 430,
          z = 18,
          yaw = 0.12,
          tilt = 1,
          roll = -0.28,
          scale = Math.min(1440 / 3100, 836 / 2020) * 1.0568820479252328;
        const a = x * Math.cos(yaw) - y * Math.sin(yaw),
          b = x * Math.sin(yaw) + y * Math.cos(yaw);
        const v = b * Math.cos(tilt) - z * Math.sin(tilt),
          u = a * Math.cos(roll) - v * Math.sin(roll),
          t = a * Math.sin(roll) + v * Math.cos(roll);
        const px = Math.round((u - 0.8116955263673162) * scale + 720),
          py = Math.round((t + 104.409147077857) * scale + 836 * 0.46);
        return new Promise<number>((resolve) =>
          requestAnimationFrame(() => {
            const bytes = new Uint8Array(7 * 7 * 4);
            gl.readPixels(
              px - 3,
              836 - py - 3,
              7,
              7,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              bytes,
            );
            resolve(Math.max(...bytes.filter((_, i) => i % 4 !== 3)));
          }),
        );
      });
      expect(hit).toBeGreaterThan(40);
    }
    await page.getByText("204 렌더 검증 도구", { exact: true }).click();
  }
  await page.getByRole("button", { name: "회전", exact: true }).click();
  await expect.poll(async () => (await view(page)).camera.yaw).toBe(0.72);
  await page.getByText("204 렌더 검증 도구", { exact: true }).click();
  await page
    .locator("canvas")
    .screenshot({ path: "test-results/galaxy/reference-rotated.png" });
});
test("every declared level preserves individuals; 2501 paginated stars are not capped", async ({
  page,
}) => {
  await start(page);
  for (let level = 0; level < 3; level++) {
    await page
      .getByRole("button", { name: "LOD " + level, exact: true })
      .click();
    await expect.poll(async () => (await view(page)).level).toBe(level);
    await expect.poll(async () => (await view(page)).pending).toBe(0);
    await expect.poll(async () => (await stats(page)).stars).toBeGreaterThan(0);
    const s = await stats(page);
    expect(s.stars).toBeGreaterThan(0);
    expect(s.planets).toBe(0);
    expect(s.orbitStars).toBe(0);
    expect(s.gpuBuffers).toBe(4);
  }
  await page
    .getByRole("button", { name: "별 2501개 계정", exact: true })
    .click();
  await expect(page.getByTestId("sky-total")).toHaveText("2,501");
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  await expect.poll(async () => (await stats(page)).stars).toBe(2501);
});
test("selected system renders all five planets; idle frames do not repack and return clears all orbits", async ({
  page,
}) => {
  await start(page, true);
  const camera = (await view(page)).camera;
  await page
    .getByRole("button", { name: "선택 별의 내 행성", exact: true })
    .click();
  await expect.poll(async () => (await stats(page)).detailedSystems).toBe(1);
  const before = await stats(page);
  expect(before.planets).toBe(5);
  expect(before.orbitStars).toBe(1);
  await expect
    .poll(async () => (await stats(page)).frameCount)
    .toBeGreaterThan(before.frameCount + 12);
  const after = await stats(page);
  expect(after.packedNodes).toBe(before.packedNodes);
  expect(after.uploadBytes).toBe(before.uploadBytes);
  expect(after.bufferAllocations).toBe(before.bufferAllocations);
  await page.getByText("204 렌더 검증 도구", { exact: true }).click();
  await page
    .locator("canvas")
    .screenshot({ path: "test-results/galaxy/five-planets.png" });
  await page.getByText("204 렌더 검증 도구", { exact: true }).click();
  await page.getByRole("button", { name: "은하로 복귀", exact: true }).click();
  await expect.poll(async () => (await stats(page)).detailedSystems).toBe(0);
  expect((await stats(page)).planets).toBe(0);
  expect((await view(page)).camera).toEqual(camera);
});
test("status changes preserve actual rendered pixels; new discovery preserves camera and stored positions", async ({
  page,
  request,
}) => {
  await start(page);
  const camera = (await view(page)).camera,
    coord = (await (await request.get("/api/v1/me/stars/900000001")).json())
      .unlock.position;
  const before = await page.locator("canvas").screenshot();
  await page
    .getByRole("button", { name: "행성 없는 완료 응답", exact: true })
    .click();
  await expect.poll(async () => (await view(page)).pending).toBe(0);
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/v1/me/stars/900000001")).json()).planets
          .count,
    )
    .toBe(0);
  const after = await page.locator("canvas").screenshot();
  expect(after.equals(before)).toBe(true);
  await page.getByRole("button", { name: "새 발견 응답", exact: true }).click();
  await expect(page.getByTestId("sky-total")).toHaveText("1,001");
  expect((await view(page)).camera).toEqual(camera);
  expect(
    (await (await request.get("/api/v1/me/stars/900000001")).json()).unlock
      .position,
  ).toEqual(coord);
  await page
    .getByRole("button", { name: "선택 별의 내 행성", exact: true })
    .click();
  await expect.poll(async () => (await stats(page)).detailedSystems).toBe(1);
  expect((await stats(page)).planets).toBe(0);
  await expect(page.getByTestId("selected-info")).toHaveText("행성 없이 완료");
});
test("partial page failure retains successful stars and retries without moving the camera", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "별 2501개 계정", exact: true })
    .click();
  await expect.poll(async () => (await stats(page)).stars).toBe(2501);
  const camera = (await view(page)).camera;
  await page
    .getByRole("button", { name: "일부 영역 실패", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "실패 영역 다시 불러오기" }),
  ).toBeVisible();
  expect((await view(page)).stars).toBeGreaterThan(0);
  expect((await view(page)).camera).toEqual(camera);
  await page.getByRole("button", { name: "응답 복구", exact: true }).click();
  await page.getByRole("button", { name: "실패 영역 다시 불러오기" }).click();
  await expect(
    page.getByRole("button", { name: "실패 영역 다시 불러오기" }),
  ).toHaveCount(0);
  await expect.poll(async () => (await stats(page)).stars).toBe(2501);
});
test("context loss restores resources and reduced motion stops selected-system animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await start(page);
  await page
    .getByRole("button", { name: "선택 별의 내 행성", exact: true })
    .click();
  await expect.poll(async () => (await stats(page)).detailedSystems).toBe(1);
  expect((await stats(page)).animatedSeconds).toBe(0);
  await page.evaluate(() => {
    const ext = document
      .querySelector("canvas")!
      .getContext("webgl2")!
      .getExtension("WEBGL_lose_context")!;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), 800);
  });
  await expect(page.getByRole("alert")).toContainText(
    "그래픽 연결이 끊겼습니다",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(async () => (await stats(page)).detailedSystems).toBe(1);
  expect((await stats(page)).gpuBuffers).toBe(4);
});
test("unsupported WebGL at 1024 has explicit recovery, without fake galaxy", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: any[]
    ) {
      if (type === "webgl2") return null;
      return (get as any).call(this, type, ...args);
    } as any;
  });
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/sky");
  await expect(page.getByRole("alert")).toContainText("WebGL 2");
  await expect(
    page.getByRole("button", { name: "그래픽 다시 시작" }),
  ).toBeVisible();
});
test("empty account removes all instances", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "빈 응답", exact: true }).click();
  await expect(page.getByTestId("sky-total")).toHaveText("0");
  await expect.poll(async () => (await stats(page)).stars).toBe(0);
  expect((await stats(page)).planets).toBe(0);
});
test("version refresh invalidates previous selected-system response", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "선택 별의 내 행성", exact: true })
    .click();
  await expect.poll(async () => (await stats(page)).planets).toBe(5);
  await page
    .getByRole("button", { name: "행성 없는 완료 응답", exact: true })
    .click();
  await expect.poll(async () => (await stats(page)).planets).toBe(0);
  expect((await stats(page)).detailedSystems).toBe(0);
});
test("tab hide and resume preserves camera and does not replay or jump the orbit timeline", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "선택 별의 내 행성", exact: true })
    .click();
  await expect.poll(async () => (await stats(page)).detailedSystems).toBe(1);
  const camera = (await view(page)).camera;
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const paused = await stats(page);
  await page.waitForTimeout(400);
  expect((await stats(page)).frameCount).toBe(paused.frameCount);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await stats(page)).frameCount)
    .toBeGreaterThan(paused.frameCount);
  const resumed = await stats(page);
  expect((await view(page)).camera).toEqual(camera);
  expect(resumed.animatedSeconds).toBeGreaterThanOrEqual(
    paused.animatedSeconds,
  );
  expect(resumed.animatedSeconds - paused.animatedSeconds).toBeLessThan(0.3);
});
