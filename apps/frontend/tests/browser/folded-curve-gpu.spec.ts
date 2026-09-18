import { expect, test, type Page } from "@playwright/test";
import { candidatePeaksFixture } from "../../dev/periodogram-fixtures";

const url = "/analysis/259377024?foldRenderer=webgl";
const plot = (page: Page) =>
  page.getByRole("group", { name: "접힌 곡선 그래프", exact: true });
const select = (page: Page) =>
  page.getByRole("combobox", { name: "개발용 접기 렌더러" });
async function open(page: Page) {
  await page.goto(url);
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
}
async function gpu(page: Page) {
  await expect(page.getByTestId("fold-renderer-status")).toHaveText(
    "WebGL로 표시하고 있습니다.",
  );
  await expect(plot(page).locator('canvas[data-renderer="webgl"]')).toHaveCount(
    1,
  );
}
async function snapshot(page: Page) {
  return {
    period: await page.getByTestId("fold-result").getAttribute("data-period"),
    low: await plot(page).getAttribute("data-view-start"),
    high: await plot(page).getAttribute("data-view-end"),
    inspector: await page.locator(".fold-inspector").textContent(),
  };
}
test("GPU integration preserves rapid tuning, view, inspection and releases resources", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = {
      draws: 0,
      uploads: 0,
      created: 0,
      buffers: new Set<WebGLBuffer>(),
    };
    Object.assign(window, { gpuCheck: state });
    const proto = WebGL2RenderingContext.prototype;
    const draw = proto.drawArraysInstanced,
      upload = proto.bufferSubData,
      create = proto.createBuffer,
      remove = proto.deleteBuffer;
    proto.drawArraysInstanced = function (...args) {
      state.draws++;
      return draw.apply(this, args);
    };
    proto.bufferSubData = function (
      this: WebGL2RenderingContext,
      ...args: unknown[]
    ) {
      state.uploads++;
      return Reflect.apply(upload, this, args);
    };
    proto.createBuffer = function () {
      const value = create.call(this);
      if (value) {
        state.buffers.add(value);
        state.created++;
      }
      return value;
    };
    proto.deleteBuffer = function (value) {
      if (value) state.buffers.delete(value);
      return remove.call(this, value);
    };
  });
  await open(page);
  await gpu(page);
  await select(page).selectOption("webgl");
  await gpu(page);
  const canvas = plot(page).locator("canvas");
  await canvas.evaluate(
    (el: HTMLCanvasElement) => (el.dataset.retained = "yes"),
  );
  const read = () =>
    page.evaluate(() => {
      const s = (
        window as unknown as {
          gpuCheck: {
            draws: number;
            uploads: number;
            created: number;
            buffers: Set<unknown>;
          };
        }
      ).gpuCheck;
      return {
        draws: s.draws,
        uploads: s.uploads,
        created: s.created,
        active: s.buffers.size,
      };
    });
  const before = await read();
  await plot(page).focus();
  for (let i = 0; i < 5; i++) await plot(page).press("+");
  await plot(page).press("ArrowRight");
  const original = await snapshot(page);
  // Actual input events, without waiting for each fold to complete.
  for (let i = 0; i < 8; i++)
    await page
      .getByRole("button", {
        name: i % 2 ? "한 간격 줄이기" : "한 간격 늘리기",
      })
      .click();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  expect(
    await page.getByTestId("fold-result").getAttribute("data-period"),
  ).toBe(await page.getByTestId("selected-period").getAttribute("data-period"));
  expect((await snapshot(page)).low).toBe(original.low);
  expect((await snapshot(page)).high).toBe(original.high);
  await expect(canvas).toHaveAttribute("data-retained", "yes");
  const after = await read();
  expect(after.created).toBe(before.created);
  expect(after.active).toBe(2);
  expect(after.uploads).toBeGreaterThan(before.uploads);
  await plot(page).focus();
  await plot(page).press("ArrowDown");
  await expect(page.locator(".fold-inspector")).toContainText("BTJD");
  const selected = await snapshot(page);
  await select(page).selectOption("canvas");
  await expect(canvas).toHaveAttribute("data-renderer", "canvas");
  expect(await snapshot(page)).toEqual(selected);
  expect((await read()).active).toBe(0);
  await select(page).selectOption("webgl");
  await gpu(page);
  expect(await snapshot(page)).toEqual(selected);
  const idle = await read();
  await page.waitForTimeout(1000);
  expect((await read()).draws).toBe(idle.draws);
  const renderer = await canvas.evaluate((el: HTMLCanvasElement) => {
    const gl = el.getContext("webgl2")!;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
  });
  console.log("GPU_INTEGRATION_RENDERER", renderer);
  await select(page).selectOption("canvas");
  expect((await read()).active).toBe(0);
  await select(page).selectOption("webgl");
  await gpu(page);
  await page.getByRole("link", { name: "이전 화면으로", exact: true }).click();
  await expect(plot(page)).toHaveCount(0);
  expect((await read()).active).toBe(0);
});

for (const failure of ["unavailable", "shader", "lost", "module"] as const)
  test(`GPU ${failure} automatically falls back and keeps view and period`, async ({
    page,
  }) => {
    if (failure === "module")
      await page.route("**/dev/FoldGpuSurface.tsx*", (route) => route.abort());
    if (failure === "unavailable")
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          type: string,
          ...args: unknown[]
        ) {
          if (type === "webgl2") return null;
          return Reflect.apply(original, this, [type, ...args]);
        } as typeof original;
      });
    if (failure === "shader")
      await page.addInitScript(() => {
        const original = WebGL2RenderingContext.prototype.getProgramParameter;
        WebGL2RenderingContext.prototype.getProgramParameter = function (
          program,
          pname,
        ) {
          return pname === this.LINK_STATUS
            ? false
            : original.call(this, program, pname);
        };
      });
    await open(page);
    if (failure === "lost") await gpu(page);
    await plot(page).focus();
    await plot(page).press("+");
    await plot(page).press("ArrowRight");
    await plot(page).press("ArrowDown");
    const previous = await snapshot(page);
    if (failure === "lost")
      await plot(page)
        .locator("canvas")
        .evaluate((el: HTMLCanvasElement) => {
          const ext = el
            .getContext("webgl2")!
            .getExtension("WEBGL_lose_context");
          if (!ext) throw Error("Context loss extension unavailable");
          ext.loseContext();
        });
    await expect(page.getByTestId("fold-renderer-status")).toContainText(
      "Canvas로 전환",
    );
    await expect(plot(page).locator("canvas")).toHaveAttribute(
      "data-renderer",
      "canvas",
    );
    expect(await snapshot(page)).toEqual(previous);
    await expect(plot(page)).toBeFocused();
    const visible = await plot(page)
      .locator("canvas")
      .evaluate((el: HTMLCanvasElement) =>
        el
          .getContext("2d")!
          .getImageData(0, 0, el.width, el.height)
          .data.some((v) => v !== 0),
      );
    expect(visible).toBe(true);
    await page.getByRole("button", { name: "한 간격 늘리기" }).click();
    const peak = candidatePeaksFixture().peaks[0];
    await expect(page.getByTestId("fold-result")).toHaveAttribute(
      "data-period",
      String(peak.periodDays + peak.fineTune.periodStepDays),
    );
    await expect(plot(page).locator("canvas")).toHaveAttribute(
      "data-renderer",
      "canvas",
    );
    if (failure === "lost") {
      await select(page).selectOption("canvas");
      await select(page).selectOption("webgl");
      await gpu(page);
    }
  });

test("GPU pending cancellation and retry preserve the last successful view", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      override postMessage(message: unknown) {
        if ((message as { type: string }).type === "fold")
          setTimeout(() => super.postMessage(message), 2000);
        else super.postMessage(message);
      }
    };
  });
  await open(page);
  await gpu(page);
  await plot(page).focus();
  await plot(page).press("+");
  await plot(page).press("ArrowLeft");
  const before = await snapshot(page);
  await page.getByRole("button", { name: "한 간격 늘리기" }).click();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "false",
  );
  await page.getByRole("button", { name: "접기 취소", exact: true }).click();
  expect(await snapshot(page)).toEqual(before);
  await gpu(page);
  await page
    .getByRole("button", { name: "접기 다시 계산", exact: true })
    .click();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  expect((await snapshot(page)).period).not.toBe(before.period);
  expect((await snapshot(page)).low).toBe(before.low);
  await gpu(page);
});

test("GPU resize reuses the canvas; repeated mounting releases contexts", async ({
  page,
}) => {
  await open(page);
  await gpu(page);
  await plot(page)
    .locator("canvas")
    .evaluate((el: HTMLCanvasElement) => (el.dataset.retained = "yes"));
  for (const width of [1024, 1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        plot(page)
          .locator("canvas")
          .evaluate((el: HTMLCanvasElement) =>
            Math.abs(
              el.width - el.getBoundingClientRect().width * devicePixelRatio,
            ),
          ),
      )
      .toBeLessThanOrEqual(1);
    await expect(plot(page).locator("canvas")).toHaveAttribute(
      "data-retained",
      "yes",
    );
  }
  for (let i = 0; i < 8; i++) {
    await select(page).selectOption("canvas");
    await select(page).selectOption("webgl");
    await gpu(page);
  }
  await expect(plot(page).locator("canvas")).toHaveCount(1);
});

test.describe("GPU at DPR 2", () => {
  test.use({ deviceScaleFactor: 2 });
  test("full app sizes its backing canvas and retains view across renderers", async ({
    page,
  }, info) => {
    await open(page);
    await gpu(page);
    await plot(page).focus();
    for (let i = 0; i < 5; i++) await plot(page).press("+");
    await plot(page).press("ArrowLeft");
    await expect
      .poll(() =>
        plot(page)
          .locator("canvas")
          .evaluate((el: HTMLCanvasElement) =>
            Math.abs(el.width - el.getBoundingClientRect().width * 2),
          ),
      )
      .toBeLessThanOrEqual(1);
    const before = await snapshot(page);
    await page.screenshot({
      path: info.outputPath("gpu-dpr2.png"),
      fullPage: true,
    });
    await select(page).selectOption("canvas");
    expect(await snapshot(page)).toEqual(before);
    await expect
      .poll(() =>
        plot(page)
          .locator("canvas")
          .evaluate((el: HTMLCanvasElement) =>
            Math.abs(el.width - el.getBoundingClientRect().width * 2),
          ),
      )
      .toBeLessThanOrEqual(1);
  });
});
