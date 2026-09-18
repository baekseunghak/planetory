import {
  selectPeak,
  beginRange,
  tune,
  showJudgment,
  rangeStage,
  openMemo,
} from "../analysis-ui";
import { expect, test, type Page } from "@playwright/test";

async function select(page: Page, revealMemo = true) {
  await page.goto("/analysis/259377024");
  await selectPeak(page, 1);
  await beginRange(page);
  if (revealMemo) await showJudgment(page);
  else
    await page
      .getByRole("button", { name: "구간 확정하고 판단하기", exact: true })
      .click();
}
async function review(page: Page) {
  await openMemo(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByRole("checkbox", { name: "홀짝 깊이", exact: true }).check();
  await page
    .getByLabel("메모 (선택)", { exact: true })
    .fill("홀짝 깊이를 확인했지만 판단이 어렵다. 🌌");
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
}
test("memo limit preserves pasted text, focuses its error, accepts 200 Unicode code points", async ({
  page,
}) => {
  await select(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  const memo = page.getByLabel("메모 (선택)", { exact: true });
  const value = "🌌".repeat(200);
  await memo.fill(value + "가");
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(memo).toBeFocused();
  await expect(memo).toHaveValue(value + "가");
  await expect(
    page.getByText("메모를 200자 이내로 줄여 주세요.", { exact: true }),
  ).toBeVisible();
  await memo.fill(value);
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toBeVisible();
  await expect(page.locator(".analysis-memo-preview")).toHaveText(value);
});
test("cancelled range editing restores review; clear retains writing and reload awaits explicit draft restoration", async ({
  page,
}) => {
  await select(page);
  await review(page);
  const handle = page.getByRole("slider", {
    name: "위상 구간 끝",
    exact: true,
  });
  await rangeStage(page);
  const before = await handle.getAttribute("aria-valuenow");
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2);
  await expect(page.getByTestId("candidate-review")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", before!);
  await showJudgment(page);
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toBeVisible();
  await rangeStage(page);
  await page
    .locator(".chart-actions")
    .getByRole("button", { name: "구간 지우기", exact: true })
    .click();
  await expect(page.getByLabel("메모 (선택)", { exact: true })).toHaveValue(
    /🌌/,
  );
  await page.reload();
  await expect(page.getByLabel("메모 (선택)", { exact: true })).toHaveValue("");
});
test("gated keyboard flow, required judgment, review and back preserve input without submitting", async ({
  page,
}) => {
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/submissions"))
      posts++;
  });
  await page.goto("/analysis/259377024");
  await expect(
    page.getByRole("radio", {
      name: "행성 같음",
      exact: true,
      includeHidden: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "제출값 확인",
      exact: true,
      includeHidden: true,
    }),
  ).toBeDisabled();
  await select(page, false);
  const planet = page.getByRole("radio", { name: "행성 같음", exact: true });
  await expect(planet).toBeFocused();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(
    page.getByText("판단을 하나 선택해 주세요.", { exact: true }),
  ).toBeVisible();
  await expect(planet).toBeFocused();
  await planet.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "아닌 것 같음", exact: true }),
  ).toBeChecked();
  await review(page);
  const summary = page.getByTestId("candidate-review");
  await expect(
    summary.getByRole("heading", { name: "제출값 확인", exact: true }),
  ).toBeFocused();
  await expect(summary).toContainText("모르겠음");
  await expect(summary).toContainText("홀짝 깊이");
  await expect(summary).toContainText("🌌");
  await expect(
    summary.getByRole("button", { name: "제출하기 · 연결 예정", exact: true }),
  ).toBeDisabled();
  await expect(page.locator('[aria-current="step"]')).toContainText(
    "제출값 확인",
  );
  await page
    .getByRole("button", { name: "판단·메모 수정 →", exact: true })
    .click();
  await expect(planet).toBeFocused();
  await expect(
    page.getByRole("radio", {
      name: "모르겠음",
      exact: true,
      includeHidden: true,
    }),
  ).toBeChecked();
  await expect(page.getByLabel("메모 (선택)", { exact: true })).toHaveValue(
    /🌌/,
  );
  expect(posts).toBe(0);
});
test("view changes preserve review; phase edits retain writing but require confirmation; period success clears all", async ({
  page,
}) => {
  await select(page);
  await review(page);
  const folded = page.getByRole("group", {
    name: "접힌 곡선 그래프",
    exact: true,
  });
  await folded.focus();
  await folded.press("+");
  await folded.press("ArrowRight");
  await expect(page.getByTestId("candidate-review")).toBeVisible();
  const handle = page.getByRole("slider", {
    name: "위상 구간 끝",
    exact: true,
  });
  await rangeStage(page);
  await handle.focus();
  await handle.press("ArrowRight");
  await expect(page.getByTestId("candidate-review")).toHaveCount(0);
  const memo = page.getByLabel("메모 (선택)", { exact: true });
  await expect(memo).toBeDisabled();
  await expect(memo).toHaveValue(/🌌/);
  await expect(
    page.getByRole("radio", {
      name: "모르겠음",
      exact: true,
      includeHidden: true,
    }),
  ).toBeChecked();
  await showJudgment(page);
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toBeVisible();
  await tune(page, "ArrowRight");
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  await expect(memo).toHaveValue("");
  await expect(memo).toBeDisabled();
  await expect(
    page.getByRole("radio", {
      name: "모르겠음",
      exact: true,
      includeHidden: true,
    }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "홀짝 깊이",
      exact: true,
      includeHidden: true,
    }),
  ).not.toBeChecked();
});
for (const outcome of ["failure", "cancel"] as const)
  test(`pending locks judgment and ${outcome} restores the review snapshot`, async ({
    page,
  }) => {
    await page.addInitScript((outcome) => {
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
            if (outcome === "cancel") return;
            setTimeout(
              () =>
                this.dispatchEvent(
                  new MessageEvent("message", {
                    data: {
                      type: "fold-error",
                      dataId: job.dataId,
                      revision: job.revision,
                      error: "judgment recovery test",
                    },
                  }),
                ),
              1200,
            );
          } else super.postMessage(message);
        }
      };
    }, outcome);
    await select(page);
    await review(page);
    const summary = page.getByTestId("candidate-review");
    const before = await summary.locator("dl").textContent();
    await tune(page, "ArrowRight");
    await expect(summary).toHaveCount(0);
    await expect(
      page.getByLabel("메모 (선택)", { exact: true }),
    ).toBeDisabled();
    if (outcome === "cancel")
      await page
        .getByRole("button", { name: "접기 취소", exact: true })
        .click();
    await expect(page.getByTestId("fold-panel")).toHaveAttribute(
      "data-fold-ready",
      "true",
    );
    await rangeStage(page);
    await showJudgment(page);
    await page
      .getByRole("button", { name: "제출값 확인", exact: true })
      .click();
    await expect(summary.locator("dl")).toHaveText(before!);
    await page
      .getByRole("button", { name: "판단·메모 수정 →", exact: true })
      .click();
    await expect(page.getByLabel("메모 (선택)", { exact: true })).toHaveValue(
      /🌌/,
    );
  });
test("typing memo does not redraw observation canvases; 1024px form fits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await select(page);
  await page.evaluate(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    (window as unknown as { draws: number }).draws = 0;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      (window as unknown as { draws: number }).draws++;
      return clear.apply(this, args);
    };
  });
  await page
    .getByLabel("메모 (선택)", { exact: true })
    .pressSequentially("hello sample memo");
  expect(
    await page.evaluate(() => (window as unknown as { draws: number }).draws),
  ).toBe(0);
  expect(
    await page
      .locator(".analysis-judgment")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});
