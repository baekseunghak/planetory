import { expect, test } from "@playwright/test";
import { candidatePeaksFixture } from "../../dev/periodogram-fixtures";

test("period selection folds all points, preserves Canvas and fine-tune zoom, and sends no new API calls", async ({
  page,
}) => {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) calls.push(request.url());
  });
  await page.goto("/analysis/259377024");
  await expect(page.getByTestId("fold-status")).toContainText("주기를 선택");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  const peak = candidatePeaksFixture().peaks[0];
  const result = page.getByTestId("fold-result"),
    plot = page.getByRole("group", { name: "접힌 곡선 그래프", exact: true });
  await expect(result).toHaveAttribute("data-period", String(peak.periodDays));
  await expect(plot).toHaveAttribute("data-point-count", "1009");
  const loaded = calls.slice();
  await plot.locator("canvas").evaluate((canvas) => {
    canvas.dataset.retained = "yes";
  });
  const yMin = await plot.getAttribute("data-y-min"),
    yMax = await plot.getAttribute("data-y-max");
  await plot.focus();
  await plot.press("+");
  await plot.press("+");
  await plot.press("ArrowRight");
  await expect(page.getByTestId("fold-zoom")).toHaveText("×4");
  await page.getByRole("button", { name: "한 간격 늘리기" }).click();
  await expect(result).toHaveAttribute(
    "data-period",
    String(peak.periodDays + peak.fineTune.periodStepDays),
  );
  await expect(page.getByTestId("fold-zoom")).toHaveText("×4");
  await expect(plot).toHaveAttribute("data-view-start", "0.25");
  await expect(plot.locator("canvas")).toHaveAttribute("data-retained", "yes");
  await expect(plot).toHaveAttribute("data-y-min", yMin!);
  await expect(plot).toHaveAttribute("data-y-max", yMax!);
  await page
    .getByRole("button", { name: "2위 봉우리 선택", exact: true })
    .click();
  await expect(result).toHaveAttribute(
    "data-period",
    String(candidatePeaksFixture().peaks[1].periodDays),
  );
  await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
  expect(calls).toEqual(loaded);
});

test("pointer zoom preserves its phase, keyboard and double click restore full view, numeric alternative is available", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
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
  await plot.press("+");
  await plot.press("+");
  await plot.press("+");
  await expect(page.getByTestId("fold-zoom")).toHaveText("×8");
  await plot.press("ArrowDown");
  await expect(page.locator(".fold-inspector")).toContainText("BTJD");
  await plot.press("0");
  await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
  await plot.press("+");
  await plot.dblclick();
  await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
});

test("direct periods fold without enabling deferred fine tuning at the minimum supported width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.goto("/analysis/259377024");
  await page
    .getByRole("spinbutton", { name: "새 주기 (일)", exact: true })
    .fill("1.2345678901234567");
  await page.getByRole("button", { name: "새 주기 선택", exact: true }).click();
  await expect(page.getByTestId("fold-result")).toHaveAttribute(
    "data-period",
    "1.2345678901234567",
  );
  await expect(
    page.getByRole("slider", { name: "반복 주기 미세 조정" }),
  ).toHaveCount(0);
  const panel = page.getByRole("region", {
    name: "주기로 접은 밝기 변화",
    exact: true,
  });
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await panel
    .getByRole("button", { name: "접힌 곡선 확대", exact: true })
    .click();
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
          setTimeout(() => super.postMessage(message), 500);
        else super.postMessage(message);
      }
    };
  });
  await page.goto("/analysis/259377024");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await expect(page.getByTestId("fold-status")).toContainText("접고 있습니다");
  await expect(page.getByTestId("fold-result")).toBeVisible();
  const old = await page.getByTestId("fold-result").getAttribute("data-period");
  await page.getByRole("button", { name: "한 간격 늘리기" }).click();
  await expect(page.getByTestId("fold-status")).toContainText("접고 있습니다");
  await expect(page.getByTestId("fold-result")).toHaveAttribute(
    "data-period",
    old!,
  );
  await page.getByRole("button", { name: "접기 취소", exact: true }).click();
  await expect(page.getByTestId("fold-status")).toContainText("취소");
  await page
    .getByRole("button", { name: "접기 다시 계산", exact: true })
    .click();
  await expect(page.getByTestId("fold-status")).toHaveText(
    "선택한 주기로 곡선을 접었습니다.",
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
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await expect(page.getByTestId("fold-status")).toContainText("접기에 실패");
  await expect(page.getByTestId("fold-result")).toHaveCount(0);
  await page
    .getByRole("button", { name: "접기 다시 계산", exact: true })
    .click();
  await expect(page.getByTestId("fold-result")).toBeVisible();
});
