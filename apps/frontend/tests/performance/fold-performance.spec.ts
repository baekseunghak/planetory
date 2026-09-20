import { expect, test } from "@playwright/test";
import { cpus, totalmem } from "node:os";
import {
  periodCurveFixture,
  periodogramFixtureResponse,
} from "../../dev/periodogram-fixtures";
import { installFoldMetrics } from "./fold-metrics";

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95:
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ??
      0,
    max: sorted.at(-1) ?? 0,
  };
}
for (const size of [17_281, 100_000, 300_000]) {
  test(`fold performance with ${size} points`, async ({
    page,
    browser,
  }, testInfo) => {
    await page.addInitScript(installFoldMetrics);
    await page.route("**/assets/fold.worker-*.js", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      await route.fulfill({
        response,
        body:
          source +
          `
const handle = self.onmessage;
self.onmessage = event => {
 const start = performance.now(); handle(event);
 if(event.data.type === 'fold') self.postMessage({type:'test-fold-duration', ms:performance.now()-start});
};`,
      });
    });
    const curve = periodCurveFixture();
    const original = curve.segments[0];
    if (size !== original.nPoints) {
      // Repeated synthetic brightness at a finer cadence in the same 120-day interval.
      curve.segments = [
        {
          ...original,
          nPoints: size,
          binMinutes: (120 * 1440) / (size - 1),
          flux: Array.from(
            { length: size },
            (_, i) => original.flux[i % original.nPoints],
          ),
        },
      ];
    }
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      url.pathname = url.pathname.replace(/^\/api/, "");
      if (url.pathname === "/v1/me")
        return route.fulfill({
          json: {
            memberId: "perf",
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
    const panel = page.getByTestId("fold-panel");
    await expect(panel).toHaveAttribute("data-fold-ready", "true");
    const plot = page.getByRole("group", {
      name: "접힌 곡선 그래프",
      exact: true,
    });
    await expect(plot).toHaveAttribute("data-point-count", String(size));
    const samples = [];
    for (const zoom of [1, 32]) {
      if (zoom === 32) {
        await plot.focus();
        for (let i = 0; i < 5; i++) await plot.press("+");
      }
      // Warm-up + each measured scenario uses the actual application's event handlers.
      await page.waitForTimeout(200);
      await page.evaluate(async () => {
        window.foldMetrics.reset();
        const buttons = [...document.querySelectorAll("button")];
        const increase = buttons.find(
          (b) => b.textContent === "한 간격 늘리기",
        )!;
        const decrease = buttons.find(
          (b) => b.textContent === "한 간격 줄이기",
        )!;
        for (let i = 0; i < 40; i++) {
          (i % 2 === 0 ? increase : decrease).click();
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
      });
      await expect(panel).toHaveAttribute("data-fold-ready", "true");
      const result = await page.evaluate(() => {
        const { reset: _, ...metrics } = window.foldMetrics;
        window.foldMetrics.active = false;
        return metrics;
      });
      expect(result.inputs).toBe(40);
      expect(result.commits).toBeGreaterThan(0);
      expect(result.workerMs.length).toBeGreaterThan(0);
      const selected = await page
        .getByTestId("selected-period")
        .getAttribute("data-period");
      await expect(page.getByTestId("fold-result")).toHaveAttribute(
        "data-period",
        selected!,
      );
      const positionShift =
        Math.max(...result.positions) - Math.min(...result.positions);
      expect(positionShift).toBe(0);
      if (zoom === 1 && size === 100_000)
        await plot.screenshot({ path: testInfo.outputPath("dense-fold.png") });
      samples.push({
        zoom,
        commits: result.commits,
        inputs: result.inputs,
        statusChanges: result.statusChanges,
        workerMs: distribution(result.workerMs),
        drawMs: distribution(result.draws),
        inputToDrawMs: distribution(result.inputToDrawMs),
        timerGapMs: distribution(result.timerGaps),
        longTasksMs: distribution(result.longTasks),
        positionShift,
      });
    }
    await page.evaluate(() => window.foldMetrics.reset());
    await page.waitForTimeout(1000);
    const idle = await page.evaluate(() => ({
      commits: window.foldMetrics.commits,
      draws: window.foldMetrics.draws.length,
    }));
    expect(idle).toEqual({ commits: 0, draws: 0 });
    const report = {
      size,
      sectors: 1,
      binningRevision: original.binningRevision,
      browser: browser.version(),
      cpu: cpus()[0].model,
      logicalCpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      viewport: page.viewportSize(),
      samples,
      idle,
    };
    console.log("FOLD_PERF " + JSON.stringify(report));
    await testInfo.attach(`fold-${size}.json`, {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
  });
}
