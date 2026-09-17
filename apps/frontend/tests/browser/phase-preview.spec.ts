import { expect, test, type Page } from "@playwright/test";

async function select(page: Page) {
  await page.goto("/analysis/259377024");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
  await expect(page.getByTestId("phase-time-preview")).toHaveAttribute(
    "data-available",
    "true",
  );
}
test("one preview drives readonly BTJD/hours and time bands during dragging without redrawing observations", async ({
  page,
}) => {
  await select(page);
  const bands = page.getByTestId("transit-bands");
  await expect(bands).not.toHaveAttribute("data-band-count", "0");
  const period = Number(
    await page.getByTestId("selected-period").getAttribute("data-period"),
  );
  const range = page.getByTestId("phase-selection-value");
  const width =
    Number(await range.getAttribute("data-end")) -
    Number(await range.getAttribute("data-start"));
  expect(Number(await bands.getAttribute("data-duration"))).toBeCloseTo(
    width * period,
    10,
  );
  expect(
    Number(await page.getByTestId("phase-duration").getAttribute("data-value")),
  ).toBeCloseTo(width * period * 24, 10);
  await expect(bands).toHaveAttribute(
    "data-epoch",
    (await page.getByTestId("phase-epoch").getAttribute("data-value"))!,
  );
  await expect(
    page.getByTestId("phase-time-preview").locator("input"),
  ).toHaveCount(0);
  const folded = page.getByRole("group", {
    name: "접힌 곡선 그래프",
    exact: true,
  });
  await folded.focus();
  for (let i = 0; i < 5; i++) await folded.press("+");
  const end = page.getByRole("slider", { name: "위상 구간 끝", exact: true });
  await end.scrollIntoViewIfNeeded();
  const box = (await end.boundingBox())!;
  const initial = await bands.getAttribute("data-duration");
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.clearRect;
    (window as unknown as { observationDraws: number }).observationDraws = 0;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (
        this.canvas.closest(".fold-plot") ||
        (this.canvas.closest(".analysis-time-plot") &&
          !this.canvas.classList.contains("analysis-transit-bands"))
      )
        (window as unknown as { observationDraws: number }).observationDraws++;
      return original.apply(this, args);
    };
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, {
    steps: 5,
  });
  await expect(bands).not.toHaveAttribute("data-duration", initial!);
  expect(
    Number(await page.getByTestId("phase-duration").getAttribute("data-value")),
  ).toBeCloseTo(Number(await bands.getAttribute("data-duration")) * 24, 10);
  await page.mouse.up();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { observationDraws: number }).observationDraws,
    ),
  ).toBe(0);
  const saved = await range.getAttribute("data-end");
  const time = page.getByRole("group", {
    name: "시간 곡선 그래프",
    exact: true,
  });
  await time.focus();
  await time.press("+");
  await time.press("ArrowRight");
  await expect(range).toHaveAttribute("data-end", saved!);
  await expect(bands).toHaveAttribute(
    "data-epoch",
    (await page.getByTestId("phase-epoch").getAttribute("data-value"))!,
  );
  await page.getByRole("button", { name: "구간 지우기", exact: true }).click();
  await expect(bands).toHaveAttribute("data-band-count", "0");
  await expect(page.getByTestId("phase-time-preview")).toHaveAttribute(
    "data-available",
    "false",
  );
});

for (const recovery of ["failure", "cancel"] as const)
  test(`pending hides derived values, ${recovery} restores one snapshot and latest successful refold clears it`, async ({
    page,
  }) => {
    await page.addInitScript((recovery) => {
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
            if (recovery === "cancel") return;
            setTimeout(
              () =>
                this.dispatchEvent(
                  new MessageEvent("message", {
                    data: {
                      type: "fold-error",
                      dataId: job.dataId,
                      revision: job.revision,
                      error: "preview restore test",
                    },
                  }),
                ),
              1200,
            );
          } else super.postMessage(message);
        }
      };
    }, recovery);
    await select(page);
    const bands = page.getByTestId("transit-bands");
    const epoch = await bands.getAttribute("data-epoch"),
      duration = await bands.getAttribute("data-duration");
    await page
      .getByRole("button", { name: "한 간격 늘리기", exact: true })
      .click();
    await expect(
      page.getByRole("slider", { name: "위상 구간 끝", exact: true }),
    ).toBeDisabled();
    await expect(bands).toHaveAttribute("data-band-count", "0");
    await expect(page.getByTestId("phase-epoch")).toHaveText("—");
    if (recovery === "cancel")
      await page
        .getByRole("button", { name: "접기 취소", exact: true })
        .click();
    await expect(page.getByTestId("fold-status")).toContainText(
      recovery === "failure" ? "접기에 실패" : "접기를 취소",
    );
    await expect(bands).toHaveAttribute("data-epoch", epoch!);
    await expect(bands).toHaveAttribute("data-duration", duration!);
    await expect(page.getByTestId("phase-epoch")).toHaveAttribute(
      "data-value",
      epoch!,
    );
    await page
      .getByRole("button", { name: "접기 다시 계산", exact: true })
      .click();
    await expect(page.getByTestId("fold-panel")).toHaveAttribute(
      "data-fold-ready",
      "true",
    );
    await expect(bands).toHaveAttribute("data-band-count", "0");
    await expect(page.getByTestId("phase-duration")).toHaveText("—");
  });

test("invalid edits, cancelled gestures and a data reload never leave stale time bands", async ({
  page,
}) => {
  await select(page);
  const bands = page.getByTestId("transit-bands");
  const before = await bands.getAttribute("data-epoch");
  const plot = page.getByRole("group", {
    name: "접힌 곡선 그래프",
    exact: true,
  });
  await plot.scrollIntoViewIfNeeded();
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await expect(bands).toHaveAttribute("data-band-count", "0");
  await expect(page.getByTestId("phase-duration")).toHaveText("—");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(bands).toHaveAttribute("data-epoch", before!);
  await page
    .getByRole("button", { name: "최신 자료 확인", exact: true })
    .click();
  await expect(page.getByTestId("fold-status")).toContainText("주기를 선택");
  await expect(bands).toHaveAttribute("data-band-count", "0");
});
