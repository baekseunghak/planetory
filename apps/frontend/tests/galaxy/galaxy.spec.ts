import { test, expect, type Page } from "@playwright/test";
const stats = async (page: Page) =>
  JSON.parse((await page.getByTestId("render-stats").textContent()) || "null");
const view = async (page: Page) =>
  JSON.parse((await page.getByTestId("render-view").textContent()) || "{}");
async function start(page: Page) {
  await page.goto("/sky");
  await expect
    .poll(async () => (await stats(page))?.frameCount ?? 0)
    .toBeGreaterThan(0);
  await page.getByText("204 렌더 검증 도구", { exact: true }).click();
}
test.beforeEach(async ({ request }) => {
  await request.post("/api/dev-galaxy-204/reset?count=1000");
});
test("overview draws only official clusters, keeps metadata total and makes no initial tile request", async ({
  page,
}) => {
  const tiles: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/sky/tiles?")) tiles.push(r.url());
  });
  await start(page);
  const s = await stats(page);
  expect(s.stars).toBe(0);
  expect(s.clusters).toBeGreaterThan(0);
  expect(s.clusters).toBeLessThanOrEqual(80);
  expect(s.bodyDrawCalls).toBe(1);
  expect(tiles).toEqual([]);
  await expect(page.getByTestId("sky-total")).toHaveText("1,000");
  await page
    .locator("canvas")
    .screenshot({ path: "test-results/galaxy/overview.png" });
});
test("six LOD inputs, rotation and replacement obey budgets and reuse GPU objects", async ({
  page,
}) => {
  await start(page);
  for (let level = 0; level < 6; level++) {
    await page
      .getByRole("button", { name: `LOD ${level}`, exact: true })
      .click();
    await expect
      .poll(async () => {
        const s = await stats(page);
        return s && s.stars <= 400 && s.orbitStars <= 60 && s.clusters <= 80;
      })
      .toBe(true);
  }
  await expect.poll(async () => (await stats(page)).stars).toBeGreaterThan(0);
  const before = await stats(page);
  await page.getByRole("button", { name: "회전", exact: true }).click();
  await page.getByRole("button", { name: "오른쪽 영역", exact: true }).click();
  await expect.poll(async () => (await view(page)).camera.x).toBe(350);
  const after = await stats(page);
  expect(after.gpuBuffers).toBe(before.gpuBuffers);
  expect(after.bodyDrawCalls).toBeLessThanOrEqual(2);
  expect(after.orbitDrawCalls).toBeLessThanOrEqual(1);
  await page
    .locator("canvas")
    .screenshot({ path: "test-results/galaxy/individual-stars.png" });
});
test("over-budget LOD requests a coarser server level instead of trimming stars", async ({
  page,
}) => {
  await start(page);
  await page
    .getByRole("button", { name: "예산 초과 영역", exact: true })
    .click();
  await expect.poll(async () => (await view(page)).level).toBeLessThan(3);
  await expect
    .poll(async () => (await stats(page)).clusters)
    .toBeGreaterThan(0);
  expect((await stats(page)).stars).toBe(0);
});
test("selected system renders all five planets and idle frames do not repack/reupload nodes", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "별 1개 계정", exact: true }).click();
  await expect(page.getByTestId("sky-total")).toHaveText("1");
  await page
    .getByRole("button", { name: "선택 별의 내 행성", exact: true })
    .click();
  await expect.poll(async () => (await stats(page)).detailedSystems).toBe(1);
  const before = await stats(page);
  expect(before.planets).toBe(5);
  expect(before.stars).toBe(1);
  expect(before.orbitStars).toBe(1);
  await expect
    .poll(async () => (await stats(page)).frameCount)
    .toBeGreaterThan(before.frameCount + 12);
  const after = await stats(page);
  expect(after.packedNodes).toBe(before.packedNodes);
  expect(after.uploadBytes).toBe(before.uploadBytes);
  expect(after.bufferAllocations).toBe(before.bufferAllocations);
  await page
    .locator("canvas")
    .screenshot({ path: "test-results/galaxy/five-planets.png" });
});
test("new discovery and completedWithoutPlanets replace buffers while preserving camera/coordinates", async ({
  page,
  request,
}) => {
  await start(page);
  await page.getByRole("button", { name: "별 10개 계정", exact: true }).click();
  await expect(page.getByTestId("sky-total")).toHaveText("10");
  await page.getByRole("button", { name: "LOD 4", exact: true }).click();
  await expect.poll(async () => (await stats(page)).stars).toBeGreaterThan(0);
  const before = (await view(page)).camera,
    coord = (await (await request.get("/api/v1/me/stars/259377017")).json())
      .unlock.position;
  await page.getByRole("button", { name: "새 발견 응답", exact: true }).click();
  await expect(page.getByTestId("sky-total")).toHaveText("11");
  expect((await view(page)).camera).toEqual(before);
  expect(
    (await (await request.get("/api/v1/me/stars/259377017")).json()).unlock
      .position,
  ).toEqual(coord);
  await page
    .getByRole("button", { name: "행성 없는 완료 응답", exact: true })
    .click();
  await page
    .getByRole("button", { name: "선택 별의 내 행성", exact: true })
    .click();
  await expect.poll(async () => (await stats(page)).detailedSystems).toBe(1);
  await page.getByText("별과 성운 읽기", { exact: true }).click();
  await expect(
    page.getByText("표시할 내 행성 없이 탐색 완료", { exact: true }),
  ).toBeVisible();
});
test("partial network failure retains successful areas and supports explicit retry", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "LOD 0", exact: true }).click();
  await expect
    .poll(async () => (await stats(page)).clusters)
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "일부 영역 실패", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "실패 영역 다시 불러오기" }),
  ).toBeVisible();
  expect((await stats(page)).clusters).toBeGreaterThan(0);
  await page.getByRole("button", { name: "응답 복구", exact: true }).click();
  await page.getByRole("button", { name: "실패 영역 다시 불러오기" }).click();
  await expect(
    page.getByRole("button", { name: "실패 영역 다시 불러오기" }),
  ).toHaveCount(0);
});
test("context loss restores GPU resources and reduced motion stops selected-system animation", async ({
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
    const gl = document.querySelector("canvas")!.getContext("webgl2")!;
    const ext = gl.getExtension("WEBGL_lose_context")!;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), 800);
  });
  await expect(page.getByRole("alert")).toContainText(
    "그래픽 연결이 끊겼습니다",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(async () => (await stats(page)).detailedSystems).toBe(1);
  expect((await stats(page)).gpuBuffers).toBe(5);
});
test("unsupported WebGL at 1024 viewport has an explicit recovery state", async ({
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
test("empty account clears existing GPU instances and displays the empty state", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "빈 응답", exact: true }).click();
  await expect(page.getByTestId("sky-total")).toHaveText("0");
  await expect
    .poll(async () => (await stats(page)).stars + (await stats(page)).clusters)
    .toBe(0);
  await expect(
    page.getByText("아직 열린 별이 없습니다.", { exact: true }),
  ).toBeVisible();
});
