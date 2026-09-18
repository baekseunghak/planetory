import { selectPeak, tune } from "../analysis-ui";
import { expect, test } from "@playwright/test";
import { candidatePeaksFixture } from "../../dev/periodogram-fixtures";
import { FINE_TUNE_DIVISIONS } from "../../src/features/analysis/period-selection";

for (const scenario of [
  { zoom: 4, key: "ArrowRight", moves: 1 },
  { zoom: 32, key: "ArrowLeft", moves: 41 },
  { zoom: 32, key: "ArrowRight", moves: 41 },
])
  test(`fine tune preserves Canvas and x${scenario.zoom} phase view after ${scenario.key}, with no API calls`, async ({
    page,
  }) => {
    const calls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) calls.push(request.url());
    });
    await page.goto("/analysis/259377024");
    await expect(page.getByTestId("fold-status")).toContainText("주기를 선택");
    await selectPeak(page, 1);
    const peak = candidatePeaksFixture().peaks[0];
    const result = page.getByTestId("fold-result"),
      plot = page.getByRole("group", { name: "접힌 곡선 그래프", exact: true });
    await expect(result).toHaveAttribute(
      "data-period",
      String(peak.periodDays),
    );
    await expect(plot).toHaveAttribute("data-point-count", "17281");
    const loaded = calls.slice();
    await plot.locator("canvas").evaluate((canvas) => {
      canvas.dataset.retained = "yes";
    });
    const yMin = await plot.getAttribute("data-y-min"),
      yMax = await plot.getAttribute("data-y-max");
    await plot.focus();
    for (let i = 0; i < Math.log2(scenario.zoom); i++) await plot.press("+");
    for (let i = 0; i < scenario.moves; i++) await plot.press(scenario.key);
    await expect(page.getByTestId("fold-zoom")).toHaveText(`×${scenario.zoom}`);
    const viewStart = await plot.getAttribute("data-view-start");
    const viewEnd = await plot.getAttribute("data-view-end");
    await tune(page, "ArrowRight");
    await expect(result).toHaveAttribute(
      "data-period",
      String(peak.periodDays + peak.fineTune.periodStepDays / FINE_TUNE_DIVISIONS),
    );
    await expect(page.getByTestId("fold-zoom")).toHaveText(`×${scenario.zoom}`);
    await expect(plot).toHaveAttribute("data-view-start", viewStart!);
    await expect(plot).toHaveAttribute("data-view-end", viewEnd!);
    await expect(plot.locator("canvas")).toHaveAttribute(
      "data-retained",
      "yes",
    );
    await expect(plot).toHaveAttribute("data-y-min", yMin!);
    await expect(plot).toHaveAttribute("data-y-max", yMax!);
    await selectPeak(page, 2);
    await expect(result).toHaveAttribute(
      "data-period",
      String(candidatePeaksFixture().peaks[1].periodDays),
    );
    await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
    await expect(plot).toHaveAttribute("data-view-start", "-0.5");
    await expect(plot).toHaveAttribute("data-view-end", "1.5");
    expect(calls).toEqual(loaded);
  });

test("pointer zoom preserves its phase, keyboard and double click restore full view, keyboard inspection is available", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  await selectPeak(page, 1);
  const plot = page.getByRole("group", {
    name: "접힌 곡선 그래프",
    exact: true,
  });
  await expect(plot).toBeVisible();
  const rect = (await plot.boundingBox())!;
  const clientX = Math.round(rect.x + rect.width * 0.7);
  const ratio = (clientX - rect.x) / rect.width;
  await plot.dispatchEvent("wheel", {
    deltaY: -100,
    clientX,
  });
  await expect(page.getByTestId("fold-zoom")).toHaveText("×2");
  const low = Number(await plot.getAttribute("data-view-start")),
    high = Number(await plot.getAttribute("data-view-end"));
  expect(low + ratio * (high - low)).toBeCloseTo(-0.5 + ratio * 2, 10);
  await plot.focus();
  for (const level of [4, 8, 16, 32, 32]) {
    await plot.press("+");
    await expect(page.getByTestId("fold-zoom")).toHaveText(`×${level}`);
  }
  await expect(page.getByTestId("fold-zoom")).toHaveText("×32");
  for (const level of [16, 8, 4, 2, 1, 1]) {
    await plot.press("-");
    await expect(page.getByTestId("fold-zoom")).toHaveText(`×${level}`);
  }
  await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
  await plot.press("ArrowDown");
  await expect(page.locator(".fold-inspector")).toContainText("BTJD");
  await plot.press("0");
  await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
  await plot.press("+");
  await plot.dblclick();
  await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
});

for (const control of ["wheel", "keyboard"] as const)
  test(`${control} reaches x32 and reverses every step at the minimum desktop width`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 844 });
    await page.goto("/analysis/259377024");
    await selectPeak(page, 1);
    const plot = page.getByRole("group", {
      name: "접힌 곡선 그래프",
      exact: true,
    });
    const toolbar = page.locator(".fold-panel");
    await expect(plot).toBeVisible();
    const rect = (await plot.boundingBox())!;
    const clientX = Math.round(rect.x + rect.width * 0.3);
    const ratio = (clientX - rect.x) / rect.width;
    const anchor = -0.5 + ratio * 2;
    for (const level of [2, 4, 8, 16, 32]) {
      if (control === "wheel")
        await plot.dispatchEvent("wheel", { deltaY: -100, clientX });
      else
        await page
          .getByRole("group", { name: "접힌 곡선 그래프", exact: true })
          .press("+");
      await expect(page.getByTestId("fold-zoom")).toHaveText(`×${level}`);
      if (control === "wheel") {
        const low = Number(await plot.getAttribute("data-view-start"));
        const high = Number(await plot.getAttribute("data-view-end"));
        expect(low + ratio * (high - low)).toBeCloseTo(anchor, 10);
      }
    }
    await expect(page.getByTestId("fold-zoom")).toHaveText("×32");
    if (control === "wheel") {
      await plot.dispatchEvent("wheel", { deltaY: -100, clientX });
      await expect(page.getByTestId("fold-zoom")).toHaveText("×32");
      await plot.dispatchEvent("wheel", {
        deltaY: 100,
        clientX,
        ctrlKey: true,
      });
      await expect(page.getByTestId("fold-zoom")).toHaveText("×32");
    }
    expect(
      await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    for (const level of [16, 8, 4, 2, 1]) {
      if (control === "wheel")
        await plot.dispatchEvent("wheel", { deltaY: 100, clientX });
      else
        await page
          .getByRole("group", { name: "접힌 곡선 그래프", exact: true })
          .press("-");
      await expect(page.getByTestId("fold-zoom")).toHaveText(`×${level}`);
    }
    await expect(plot).toHaveAttribute("data-view-start", "-0.5");
    await expect(plot).toHaveAttribute("data-view-end", "1.5");
    for (let i = 0; i < 5; i++)
      await page
        .getByRole("group", { name: "접힌 곡선 그래프", exact: true })
        .press("+");
    if (control === "wheel") await plot.dblclick();
    else
      await toolbar
        .getByRole("button", { name: "접힌 곡선 전체 보기", exact: true })
        .click();
    await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
  });

test("direct periods fold without enabling deferred fine tuning at the minimum supported width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.goto("/analysis/259377024");
  const pg = page.getByRole("group", { name: "주기도 그래프", exact: true });
  await pg.press("ArrowDown");
  await pg.press("Enter");
  await expect(page.getByTestId("fold-result")).toHaveAttribute(
    "data-period",
    "0.5",
  );
  await expect(
    page.getByRole("slider", { name: "반복 주기 미세 조정" }),
  ).toHaveCount(0);
  const panel = page.getByRole("region", {
    name: "주기로 겹친 밝기 변화",
    exact: true,
  });
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page
    .getByRole("group", { name: "접힌 곡선 그래프", exact: true })
    .press("+");
  await expect(page.getByTestId("fold-zoom")).toHaveText("×2");
});

test("pending fold keeps its last successful graph and can be cancelled/retried", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      override postMessage(message: unknown) {
        if ((message as { type?: string }).type === "fold")
          setTimeout(() => super.postMessage(message), 2000);
        else super.postMessage(message);
      }
    };
  });
  await page.goto("/analysis/259377024");
  await selectPeak(page, 1);
  await expect(page.getByTestId("fold-status")).toContainText("접고 있습니다");
  await expect(page.getByTestId("fold-result")).toBeVisible();
  const old = await page.getByTestId("fold-result").getAttribute("data-period");
  await tune(page, "ArrowRight");
  await expect(page.getByTestId("fold-status")).toContainText("접고 있습니다");
  await expect(page.getByTestId("fold-result")).toHaveAttribute(
    "data-period",
    old!,
  );
  await page.getByRole("button", { name: "접기 취소", exact: true }).click();
  await expect(page.getByTestId("fold-status")).toContainText("취소");
  await expect(page.getByTestId("selected-period")).toHaveAttribute(
    "data-period",
    old!,
  );
  await expect(
    page.getByRole("slider", { name: "반복 주기 미세 조정", exact: true }),
  ).toHaveAttribute("value", old!);
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  await page
    .getByRole("button", { name: "접기 다시 계산", exact: true })
    .click();
  await expect(page.getByTestId("fold-status")).toHaveText(
    "주기를 조정하면 그래프를 갱신합니다. 그래프에는 마지막 계산 완료 결과를 표시합니다.",
  );
  await expect(page.getByTestId("fold-result")).not.toHaveAttribute(
    "data-period",
    old!,
  );
});

test("Worker failure has a clear error and retry action, never a fake empty success", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let first = true;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (first) {
          first = false;
          throw new Error("test worker unavailable");
        }
        super(url, options);
      }
    };
  });
  await page.goto("/analysis/259377024");
  await selectPeak(page, 1);
  await expect(page.getByTestId("fold-status")).toContainText("접기에 실패");
  await expect(page.getByTestId("fold-result")).toHaveCount(0);
  await expect(page.getByTestId("selected-period")).toContainText(
    "선택해 주세요",
  );
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "false",
  );
  await page
    .getByRole("button", { name: "접기 다시 계산", exact: true })
    .click();
  await expect(page.getByTestId("fold-result")).toBeVisible();
});

for (const operation of ["fine-tune", "reselect"] as const)
  test(`${operation} failure restores period, source, number and view; retry reapplies failed input`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      let count = 0;
      window.Worker = class extends NativeWorker {
        override postMessage(message: unknown) {
          const job = message as {
            type: string;
            dataId: string;
            revision: number;
          };
          if (job.type === "fold" && ++count === 2) {
            setTimeout(
              () =>
                this.dispatchEvent(
                  new MessageEvent("message", {
                    data: {
                      type: "fold-error",
                      dataId: job.dataId,
                      revision: job.revision,
                      error: "test fold failed",
                    },
                  }),
                ),
              1200,
            );
          } else super.postMessage(message);
        }
      };
    });
    await page.goto("/analysis/259377024");
    const selected = page.getByTestId("selected-period");
    const result = page.getByTestId("fold-result");
    const status = page.getByTestId("fold-status");
    const panel = page.getByTestId("fold-panel");
    const plot = page.getByRole("group", {
      name: "접힌 곡선 그래프",
      exact: true,
    });
    const number = page.getByRole("slider", {
      name: "반복 주기 미세 조정",
      exact: true,
    });
    await selectPeak(page, 1);
    await expect(panel).toHaveAttribute("data-fold-ready", "true");
    const original = await result.getAttribute("data-period");
    const sliderValue = await page
      .getByRole("slider", { name: "반복 주기 미세 조정" })
      .inputValue();
    await plot.focus();
    for (let i = 0; i < 5; i++) await plot.press("+");
    await plot.press("ArrowLeft");
    const start = await plot.getAttribute("data-view-start");
    const end = await plot.getAttribute("data-view-end");
    if (operation === "fine-tune") await tune(page, "ArrowRight");
    else await selectPeak(page, 2);
    const attempted = await selected.getAttribute("data-period");
    const attemptRevision = Number(
      await selected.getAttribute("data-revision"),
    );
    await expect(panel).toHaveAttribute("data-fold-ready", "false");
    await expect(status).toContainText("마지막 계산 완료 결과");
    await expect(result).toHaveAttribute("data-period", original!);
    // View-only actions remain available; failure restores the pre-edit snapshot.
    await plot.focus();
    await plot.press("-");
    await expect(page.getByTestId("fold-zoom")).toHaveText("×16");
    await expect(status).toContainText("접기에 실패");
    await expect(status).toContainText("복구했습니다");
    await expect(selected).toHaveAttribute("data-period", original!);
    await expect(selected).toHaveAttribute("data-source", "3600");
    await expect(number).toHaveAttribute("value", original!);
    await expect(
      page.getByRole("slider", { name: "반복 주기 미세 조정" }),
    ).toHaveValue(sliderValue);
    await expect(result).toHaveAttribute("data-period", original!);
    await expect(plot).toHaveAttribute("data-view-start", start!);
    await expect(plot).toHaveAttribute("data-view-end", end!);
    await expect(page.getByTestId("fold-zoom")).toHaveText("×32");
    await expect(panel).toHaveAttribute("data-fold-ready", "true");
    await page
      .getByRole("button", { name: "접기 다시 계산", exact: true })
      .click();
    await expect(result).toHaveAttribute("data-period", attempted!);
    await expect(selected).toHaveAttribute("data-period", attempted!);
    await expect(number).toHaveAttribute("value", attempted!);
    expect(
      Number(await selected.getAttribute("data-revision")),
    ).toBeGreaterThan(attemptRevision);
    await expect(page.getByTestId("fold-zoom")).toHaveText(
      operation === "reselect" ? "×1" : "×32",
    );
    await expect(panel).toHaveAttribute("data-fold-ready", "true");
  });

test("watchdog restores a stalled refold and permits explicit retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let count = 0;
    window.Worker = class extends NativeWorker {
      override postMessage(message: unknown) {
        if ((message as { type: string }).type === "fold" && ++count === 2)
          return;
        super.postMessage(message);
      }
    };
  });
  await page.goto("/analysis/259377024");
  await selectPeak(page, 1);
  const result = page.getByTestId("fold-result");
  await expect(result).toBeVisible();
  const original = await result.getAttribute("data-period");
  await page.clock.install();
  await tune(page, "ArrowRight");
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "false",
  );
  await page.clock.runFor(100);
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId("fold-status")).toContainText("접기에 실패");
  await expect(page.getByTestId("selected-period")).toHaveAttribute(
    "data-period",
    original!,
  );
  await expect(result).toHaveAttribute("data-period", original!);
  await page
    .getByRole("button", { name: "접기 다시 계산", exact: true })
    .click();
  await expect(result).not.toHaveAttribute("data-period", original!);
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
});

test("repeated slider updates keep feedback unchanged without a late cancel flash", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  await selectPeak(page, 1);
  const panel = page.getByTestId("fold-panel");
  await expect(panel).toHaveAttribute("data-fold-ready", "true");
  const baseline = await page.getByTestId("fold-status").textContent();
  await page.evaluate(() => {
    const feedback = document.querySelector(".fold-feedback")!;
    const samples: { text: string | null; cancelVisible: boolean }[] = [];
    Object.assign(window, { feedbackSamples: samples });
    new MutationObserver(() => {
      const button = feedback.querySelector("button")!;
      samples.push({
        text: feedback.querySelector("p")!.textContent,
        cancelVisible: getComputedStyle(button).visibility !== "hidden",
      });
    }).observe(feedback, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
  const slider = page.getByRole("slider", { name: "반복 주기 미세 조정" });
  for (let i = 0; i < 8; i++) {
    await slider.press(i % 2 ? "ArrowLeft" : "ArrowRight");
    await expect(panel).toHaveAttribute("data-fold-ready", "true");
  }
  await page.clock.install();
  await page.clock.runFor(1500);
  await expect(page.getByTestId("fold-status")).toHaveText(baseline!);
  await expect(
    page.getByRole("button", { name: "접기 취소", exact: true }),
  ).toHaveCount(0);
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          feedbackSamples: { text: string | null; cancelVisible: boolean }[];
        }
      ).feedbackSamples,
  );
  expect(
    samples.every(
      (sample) => sample.text === baseline && !sample.cancelVisible,
    ),
  ).toBe(true);
});

test("one prolonged pending interval exposes cancel despite new inputs and resets on retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Native = window.Worker;
    let folds = 0;
    window.Worker = class extends Native {
      override postMessage(message: unknown) {
        if ((message as { type: string }).type === "fold" && ++folds > 1)
          return;
        super.postMessage(message);
      }
    };
  });
  await page.goto("/analysis/259377024");
  await selectPeak(page, 1);
  const panel = page.getByTestId("fold-panel");
  await expect(panel).toHaveAttribute("data-fold-ready", "true");
  const baseline = await page.getByTestId("fold-status").textContent();
  const cancel = page.getByRole("button", { name: "접기 취소", exact: true });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await tune(page, "ArrowRight");
  await expect(panel).toHaveAttribute("data-fold-ready", "false");
  await page.clock.runFor(400);
  await tune(page, "ArrowRight");
  await page.clock.runFor(400);
  await expect(page.getByTestId("fold-status")).toHaveText(baseline!);
  await expect(cancel).toHaveCount(0);
  await page.clock.runFor(300);
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.getByTestId("fold-status")).toContainText("취소");
  await expect(panel).toHaveAttribute("data-fold-ready", "true");
  await page
    .getByRole("button", { name: "접기 다시 계산", exact: true })
    .click();
  await expect(panel).toHaveAttribute("data-fold-ready", "false");
  await page.clock.runFor(400);
  await expect(cancel).toHaveCount(0);
  await page.clock.runFor(700);
  await expect(cancel).toBeEnabled();
});

for (const width of [1024, 1440])
  test(`pending and success preserve graph position at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        override postMessage(message: unknown) {
          if ((message as { type: string }).type === "fold")
            setTimeout(() => super.postMessage(message), 300);
          else super.postMessage(message);
        }
      };
    });
    await page.goto("/analysis/259377024");
    await selectPeak(page, 1);
    const panel = page.getByTestId("fold-panel");
    const plot = page.getByRole("group", {
      name: "접힌 곡선 그래프",
      exact: true,
    });
    await expect(panel).toHaveAttribute("data-fold-ready", "true");
    const position = () =>
      plot.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          el.closest(".fold-panel")!.getBoundingClientRect().top,
      );
    const before = await position();
    await tune(page, "ArrowRight");
    await expect(panel).toHaveAttribute("data-fold-ready", "false");
    expect(await position()).toBe(before);
    await expect(
      page.getByRole("button", { name: "접기 취소", exact: true }),
    ).toHaveCount(0);
    await expect(panel).toHaveAttribute("data-fold-ready", "true");
    expect(await position()).toBe(before);
    await expect(
      page.getByRole("button", { name: "접기 취소", exact: true }),
    ).toHaveCount(0);
  });
