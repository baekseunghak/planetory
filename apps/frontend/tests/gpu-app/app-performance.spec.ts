import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  periodCurveFixture,
  periodogramFixtureResponse,
} from "../../dev/periodogram-fixtures";
import { installFoldMetrics } from "../performance/fold-metrics";
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    max: sorted.at(-1) ?? null,
  };
};
for (const size of [17281, 100000, 300000])
  test(`actual React input comparison ${size}`, async ({
    page,
    browser,
  }, info) => {
    // DevTools hook activates expensive development profiling of large props.
    // Keep it out of this latency comparison; no React commit count is claimed.
    await page.addInitScript(installFoldMetrics, { reactCommits: false });
    const curve = periodCurveFixture(),
      source = curve.segments[0];
    curve.segments = [
      {
        ...source,
        nPoints: size,
        binMinutes: (120 * 1440) / (size - 1),
        flux: Array.from(
          { length: size },
          (_, i) => source.flux[i % source.nPoints],
        ),
      },
    ];
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      url.pathname = url.pathname.replace(/^\/api/, "");
      if (url.pathname === "/v1/me")
        return route.fulfill({
          json: {
            memberId: "gpu-test",
            nickname: "성능 검사",
            onboardingDone: true,
            tutorialCompleted: false,
          },
        });
      if (url.pathname.endsWith("/curves"))
        return route.fulfill({ json: curve });
      const response = periodogramFixtureResponse(url);
      return response
        ? route.fulfill({ status: response.status, json: response.body })
        : route.fulfill({ status: 404 });
    });
    await page.goto("/analysis/259377024");
    await page
      .getByRole("button", { name: "1위 봉우리 선택", exact: true })
      .click();
    const panel = page.getByTestId("fold-panel"),
      plot = page.getByRole("group", { name: "접힌 곡선 그래프", exact: true });
    await expect(panel).toHaveAttribute("data-fold-ready", "true");
    await expect(plot).toHaveAttribute("data-point-count", String(size));
    const reports = [];
    let renderer = "";
    for (const round of [1, 2])
      for (const mode of round === 1
        ? ["canvas", "webgl"]
        : ["webgl", "canvas"]) {
        await page
          .getByRole("combobox", { name: "개발용 접기 렌더러" })
          .selectOption(mode);
        await expect(page.getByTestId("fold-renderer-status")).toHaveText(
          mode === "webgl"
            ? "WebGL로 표시하고 있습니다."
            : "Canvas로 표시하고 있습니다.",
        );
        if (mode === "webgl") {
          renderer = await plot
            .locator("canvas")
            .evaluate((canvas: HTMLCanvasElement) => {
              const gl = canvas.getContext("webgl2")!,
                ext = gl.getExtension("WEBGL_debug_renderer_info");
              return String(
                gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
              );
            });
          expect(renderer).not.toMatch(
            /swiftshader|software|llvmpipe|basic render/i,
          );
        }
        for (const zoom of [1, 32]) {
          await plot.focus();
          await plot.press("Home");
          if (zoom === 32) for (let i = 0; i < 5; i++) await plot.press("+");
          await page.waitForTimeout(250);
          await page.evaluate(async () => {
            window.foldMetrics.reset();
            const buttons = [...document.querySelectorAll("button")];
            const increase = buttons.find(
                (b) => b.textContent === "한 간격 늘리기",
              )!,
              decrease = buttons.find(
                (b) => b.textContent === "한 간격 줄이기",
              )!;
            for (let i = 0; i < 40; i++) {
              (i % 2 ? decrease : increase).click();
              await new Promise((resolve) => setTimeout(resolve, 16));
            }
          });
          await expect(panel).toHaveAttribute("data-fold-ready", "true");
          await expect(page.getByTestId("fold-result")).toHaveAttribute(
            "data-period",
            (await page
              .getByTestId("selected-period")
              .getAttribute("data-period"))!,
          );
          const m = await page.evaluate(() => {
            const { reset: _, ...values } = window.foldMetrics;
            window.foldMetrics.active = false;
            return values;
          });
          expect(m.inputs).toBe(40);
          expect(m.inputToDrawMs.length).toBeGreaterThan(0);
          expect(Math.max(...m.positions) - Math.min(...m.positions)).toBe(0);
          const report = {
            round,
            mode,
            zoom,
            inputs: m.inputs,
            draws: mode === "webgl" ? m.gpuDraws : m.draws.length,
            inputToDOM: stats(m.inputToDrawMs),
            timer: stats(m.timerGaps),
            longTasks: stats(m.longTasks),
          };
          reports.push(report);
          console.log("GPU_APP", size, JSON.stringify(report));
        }
        await page.evaluate(() => window.foldMetrics.reset());
        await page.waitForTimeout(1000);
        expect(
          await page.evaluate(
            () => window.foldMetrics.gpuDraws + window.foldMetrics.draws.length,
          ),
        ).toBe(0);
        await page.evaluate(() => (window.foldMetrics.active = false));
      }
    const path = info.outputPath(`app-${size}.json`);
    await writeFile(
      path,
      JSON.stringify(
        {
          size,
          browser: browser.version(),
          renderer,
          build:
            "Production React; test-only development feature gates enabled; not deployable",
          viewport: page.viewportSize(),
          reports,
        },
        null,
        2,
      ),
    );
    await info.attach(`app-${size}.json`, {
      path,
      contentType: "application/json",
    });
  });
