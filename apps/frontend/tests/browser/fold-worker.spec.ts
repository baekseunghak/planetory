import { expect, test } from "@playwright/test";

test("real module Worker folds all points, transfers results and reuses cached input", async ({
  page,
}) => {
  await page.goto("/sky");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/features/analysis/fold-client.ts";
    const { FoldClient } = await import(/* @vite-ignore */ modulePath);
    const times = new Float64Array([95, 96, 99, 100, 101, 104]);
    const client = new FoldClient(
      { dataId: "browser-test", reference: 100, times },
      { timeoutMs: 5000 },
    );
    try {
      const first = await client.request(4);
      const replaced = client.request(2),
        latest = client.request(8);
      const skipped = await replaced;
      const second = await latest;
      return {
        first: Array.from(first.phases),
        second: Array.from(second.phases),
        skipped,
        source: Array.from(times),
        oldCurrent: client.isCurrent(first),
        latestCurrent: client.isCurrent(second),
      };
    } finally {
      client.dispose();
    }
  });
  expect(result).toEqual({
    first: [0.75, 0, 0.75, 0, 0.25, 0],
    second: [0.375, 0.5, 0.875, 0, 0.125, 0.5],
    skipped: null,
    source: [95, 96, 99, 100, 101, 104],
    oldCurrent: false,
    latestCurrent: true,
  });
});
