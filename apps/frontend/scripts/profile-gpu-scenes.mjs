// Diagnostic windows only: these GPU queries are not acceptance frame samples.
import { chromium, firefox } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const [label, channel = "chrome", dprText = "1"] = process.argv.slice(2);
if (!label || !/^[a-z0-9-]+$/.test(label))
  throw Error("Use a new result label");
const folder = `performance-results/${label}-${channel}-gpu-dpr${dprText}`;
await mkdir(folder, { recursive: false });
const browser = await (channel === "firefox" ? firefox : chromium).launch({
  headless: false,
  channel: channel === "firefox" ? "moz-firefox" : channel,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: Number(dprText),
});
const result = {
  date: new Date().toISOString(),
  channel,
  browserVersion: browser.version(),
  scenarios: [],
};
const origin = "http://127.0.0.1:58360";
try {
  await page.request.post(origin + "/api/dev-galaxy-204/reset?count=100000");
  for (const selected of [false, true]) {
    await page.goto(origin + (selected ? "/sky?star=900000003" : "/sky"));
    await page.waitForFunction(
      () => window.__planetoryBenchmark?.settled(),
      undefined,
      { timeout: 180000 },
    );
    const canvas = page.getByRole("listbox", {
      name: "내가 발견한 개별 별로 이루어진 3D 은하 지도",
    });
    await canvas.focus();
    if (!selected) await page.keyboard.press("Home");
    else
      await page.waitForFunction(
        () => window.__planetoryBenchmark.info().metrics?.planets === 32,
      );
    await page.waitForTimeout(1500);
    for (const moving of [false, true]) {
      await page.bringToFront();
      const before = await page.evaluate(() =>
        window.__planetoryBenchmark.info(),
      );
      await page.evaluate(() => window.__planetoryBenchmark.beginGpu());
      const end = Date.now() + 3000;
      let i = 0;
      while (Date.now() < end) {
        if (moving)
          await page.keyboard.press(i++ % 12 < 6 ? "ArrowRight" : "ArrowLeft");
        await page.waitForTimeout(40);
      }
      const timing = await page.evaluate(() =>
        window.__planetoryBenchmark.endGpu(),
      );
      const ms = [...timing.ms].sort((a, b) => a - b);
      const after = await page.evaluate(() => ({
        ...window.__planetoryBenchmark.info(),
        visibility: document.visibilityState,
      }));
      const scenario = {
        name: `${selected ? "selected-32" : "overview"}-${moving ? "pan" : "idle"}`,
        before,
        after,
        ...timing,
        p95: ms[Math.ceil(ms.length * 0.95) - 1] ?? null,
        worst: ms.at(-1) ?? null,
      };
      result.scenarios.push(scenario);
      console.log(
        JSON.stringify({
          name: scenario.name,
          supported: timing.supported,
          disjoint: timing.disjoint,
          samples: ms.length,
          p95: scenario.p95,
          worst: scenario.worst,
        }),
      );
    }
  }
} catch (error) {
  result.failure = String(error);
  process.exitCode = 1;
} finally {
  await writeFile(`${folder}/gpu.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
