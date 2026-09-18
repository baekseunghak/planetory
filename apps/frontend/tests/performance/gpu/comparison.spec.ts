import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { cpus, totalmem, platform, release } from "node:os";
import type {} from "./harness";
const path = "/tests/performance/gpu/index.html";
test("GPU point coordinates, DPR and explicit Canvas fallback", async ({
  page,
}, info) => {
  await page.goto(path);
  await expect(page.getByRole("status")).toHaveText("측정 준비 완료");
  for (const dpr of [1, 2]) {
    const result = await page.evaluate(
      (d) => window.gpuExperiment.validate(d),
      dpr,
    );
    expect(result.checked).toBeGreaterThan(8);
    expect(result.fallback).toBe(true);
    expect(result.lossDetected).toBe(true);
    console.log("GPU_VALIDATION " + JSON.stringify(result));
    await writeFile(
      info.outputPath(`validation-${dpr}.json`),
      JSON.stringify(result, null, 2),
    );
    await info.attach(`validation-${dpr}.json`, {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
  }
});
for (const size of [100000, 300000])
  test(`Canvas versus WebGL ${size}`, async ({ page, browser }, info) => {
    await page.goto(path);
    await expect(page.getByRole("status")).toHaveText("측정 준비 완료");
    const reports = [];
    for (const round of [1, 2]) {
      for (const scenario of [
        "refold-full",
        "refold-zoom",
        "pan",
        "zoom",
      ] as const) {
        for (const mode of ((size === 100000) === (round === 1)
          ? ["canvas", "webgl"]
          : ["webgl", "canvas"]) as ("canvas" | "webgl")[]) {
          const report = await page.evaluate(
            ({ mode, size, scenario }) =>
              window.gpuExperiment.run(mode, size, scenario),
            { mode, size, scenario },
          );
          expect(report.frames).toBe(40);
          expect(report.precisionMaxPx).toBeLessThan(0.01);
          if (mode === "webgl")
            expect(
              report.gpu?.software,
              "Hardware benchmark must not silently use a software GPU",
            ).toBe(false);
          reports.push({ round, ...report });
          console.log(
            "GPU_PERF " +
              JSON.stringify({
                round,
                mode,
                size,
                scenario,
                cpu: report.cpuSubmitMs,
                gpu: report.gpuDrawMs,
                frame: report.nextFrameMs,
                timer: report.timerGapMs,
                longTasks: report.longTasksMs,
              }),
          );
          if (scenario === "refold-full" && round === 1)
            await page
              .locator("canvas")
              .screenshot({ path: info.outputPath(`${mode}-${size}.png`) });
        }
      }
    }
    const resultPath = info.outputPath(`comparison-${size}.json`);
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          browser: browser.version(),
          platform: platform(),
          osRelease: release(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          totalMemoryBytes: totalmem(),
          headless: true,
          launchArgs: ["--use-angle=d3d11"],
          reports,
        },
        null,
        2,
      ),
    );
    await info.attach(`comparison-${size}.json`, {
      path: resultPath,
      contentType: "application/json",
    });
  });
