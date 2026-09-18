import { expect, test, type Page } from "@playwright/test";

const url = "/analysis/259377024?returnTo=%2Fsky";
const fold = (p: Page) =>
  p.getByRole("group", { name: "접힌 곡선 그래프", exact: true });
const step = (p: Page) => p.locator('[aria-current="step"]');

test("help provides pointer zoom controls and enforces the same 32x limit", async ({
  page,
}) => {
  await choose(page);
  await page.getByText("조작 도움말 ›", { exact: true }).click();
  const controls = page.getByRole("group", { name: "접힌 곡선 보기 조작" });
  for (let i = 0; i < 5; i++)
    await controls
      .getByRole("button", { name: "접힌 곡선 확대", exact: true })
      .click();
  await expect(page.getByTestId("fold-zoom")).toHaveText("×32");
  await expect(
    controls.getByRole("button", { name: "접힌 곡선 확대", exact: true }),
  ).toBeDisabled();
  await controls
    .getByRole("button", { name: "접힌 곡선 보기 초기화", exact: true })
    .click();
  await expect(page.getByTestId("fold-zoom")).toHaveText("×1");
  await expect(
    controls.getByRole("button", { name: "접힌 곡선 축소", exact: true }),
  ).toBeDisabled();
});

test("invalid pointer range explains its error without opening keyboard details", async ({
  page,
}) => {
  await choose(page);
  await page
    .getByRole("button", { name: "이 주기로 구간 선택", exact: true })
    .click();
  const box = (await fold(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(
    page.locator(".analysis-judgment").getByRole("status"),
  ).toBeVisible();
  await expect(
    page.locator(".analysis-judgment").getByRole("status"),
  ).not.toBeEmpty();
  await expect(
    page.getByRole("button", { name: "구간 확정하고 판단하기", exact: true }),
  ).toBeDisabled();
});
async function choose(p: Page) {
  await p.goto(url);
  await p.getByRole("button", { name: "1위 봉우리 선택", exact: true }).click();
  await expect(p.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
}
async function range(p: Page) {
  await p
    .getByRole("button", { name: "이 주기로 구간 선택", exact: true })
    .click();
  await p.getByText("키보드 구간 선택", { exact: true }).click();
  await p.getByRole("button", { name: "구간 선택 시작", exact: true }).click();
}
async function judgment(p: Page) {
  await range(p);
  await p.getByRole("button", { name: "구간 확정하고 판단하기" }).click();
}

test("four stages preserve graph instances, gate editing and retain judgment when revisiting range", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await choose(page);
  await fold(page)
    .locator("canvas")
    .evaluate((n) => (n.dataset.retained = "yes"));
  // 봉우리를 골라도 1단계에 머물고 다른 봉우리로 다시 고를 수 있다.
  await expect(step(page)).toContainText("주기 선택");
  const selected = await page
    .getByTestId("selected-period")
    .getAttribute("data-period");
  const second = page.getByRole("button", {
    name: "2위 봉우리 선택",
    exact: true,
  });
  await expect(second).toHaveAttribute("aria-disabled", "false");
  await second.press("Enter");
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  await expect(page.getByTestId("selected-period")).not.toHaveAttribute(
    "data-period",
    selected!,
  );
  await expect(step(page)).toContainText("주기 선택");
  await judgment(page);
  await expect(
    page.getByRole("slider", { name: "반복 주기 미세 조정" }),
  ).toBeDisabled();
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByText("＋ 메모 추가 · 최대 200자", { exact: true }).click();
  await page.getByLabel("메모 (선택)", { exact: true }).fill("디자인 회귀 🌌");
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(step(page)).toContainText("제출값 확인");
  await expect(page.getByTestId("candidate-review")).toContainText(
    "디자인 회귀 🌌",
  );
  await expect(
    page.getByRole("button", { name: "제출하기 · 연결 예정", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /✓ 구간 선택/ }).click();
  await page
    .getByRole("slider", { name: "위상 구간 시작", exact: true })
    .press("ArrowLeft");
  await page.getByRole("button", { name: "구간 확정하고 판단하기" }).click();
  await expect(
    page.getByRole("radio", { name: "모르겠음", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toContainText(
    "디자인 회귀 🌌",
  );
  await expect(fold(page).locator("canvas")).toHaveAttribute(
    "data-retained",
    "yes",
  );
  expect(errors).toEqual([]);
});

test("32x fine tuning retains view, chart and data without requests or short progress flashes", async ({
  page,
}) => {
  await choose(page);
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) calls.push(r.url());
  });
  await fold(page).focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("+");
  await page.keyboard.press("ArrowRight");
  const low = await fold(page).getAttribute("data-view-start"),
    high = await fold(page).getAttribute("data-view-end");
  await fold(page)
    .locator("canvas")
    .evaluate((n) => (n.dataset.retained = "yes"));
  await page
    .getByRole("slider", { name: "반복 주기 미세 조정" })
    .press("ArrowRight");
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  await expect(page.getByTestId("fold-zoom")).toHaveText("×32");
  await expect(fold(page)).toHaveAttribute("data-view-start", low!);
  await expect(fold(page)).toHaveAttribute("data-view-end", high!);
  await expect(fold(page).locator("canvas")).toHaveAttribute(
    "data-retained",
    "yes",
  );
  await expect(page.getByRole("button", { name: "접기 취소" })).toBeHidden();
  expect(calls).toEqual([]);
});

test("keyboard handles use viewport /1000 and reset view does not delete range", async ({
  page,
}) => {
  await choose(page);
  await range(page);
  const start = page.getByRole("slider", {
    name: "위상 구간 시작",
    exact: true,
  });
  await expect(start).toBeFocused();
  const before = Number(await start.getAttribute("aria-valuenow"));
  await start.press("ArrowLeft");
  expect(Number(await start.getAttribute("aria-valuenow"))).toBeCloseTo(
    before - 0.002,
    12,
  );
  await start.press("Shift+ArrowRight");
  expect(Number(await start.getAttribute("aria-valuenow"))).toBeCloseTo(
    before + 0.018,
    12,
  );
  await fold(page).focus();
  await page.keyboard.press("+");
  await page
    .getByRole("button", { name: "접힌 곡선 전체 보기", exact: true })
    .click();
  await expect(start).toHaveAttribute("aria-valuenow", String(before + 0.018));
  await page
    .locator(".chart-actions")
    .getByRole("button", { name: "구간 지우기", exact: true })
    .click();
  await expect(start).toHaveCount(0);
});

test("saved draft is refolded and requires range confirmation after reload", async ({
  page,
}) => {
  await choose(page);
  await judgment(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByText("＋ 메모 추가 · 최대 200자", { exact: true }).click();
  await page.getByLabel("메모 (선택)", { exact: true }).fill("저장 테스트");
  await page.reload();
  await page
    .getByRole("button", { name: "초안 불러오기", exact: true })
    .click();
  await expect(step(page)).toContainText("구간 선택");
  await expect(page.getByTestId("candidate-review")).toHaveCount(0);
  await page.getByRole("button", { name: "구간 확정하고 판단하기" }).click();
  await expect(
    page.getByRole("radio", { name: "모르겠음", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toContainText(
    "저장 테스트",
  );
});

test("memo over 200 codepoints remains intact and error focuses expanded input", async ({
  page,
}) => {
  await choose(page);
  await judgment(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  const summary = page.getByText("＋ 메모 추가 · 최대 200자", { exact: true });
  await summary.click();
  const memo = page.getByLabel("메모 (선택)", { exact: true });
  await memo.fill("🌌".repeat(201));
  await summary.click();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(memo).toBeFocused();
  await expect(memo).toHaveValue("🌌".repeat(201));
  await expect(page.getByTestId("candidate-review")).toHaveCount(0);
});

for (const width of [1024, 1440])
  test(
    "every stage fits " + width + "px without horizontal overflow",
    async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(url);
      const positions: Record<string, number>[] = [];
      for (let stage = 1; stage <= 5; stage++) {
        if (stage === 2) {
          await page
            .getByRole("button", { name: "1위 봉우리 선택", exact: true })
            .click();
          await expect(page.getByTestId("fold-panel")).toHaveAttribute(
            "data-fold-ready",
            "true",
          );
        }
        if (stage === 3) await range(page);
        if (stage === 4) {
          await page
            .getByRole("button", { name: "구간 확정하고 판단하기" })
            .click();
          await page
            .getByRole("radio", { name: "모르겠음", exact: true })
            .check();
        }
        if (stage === 5)
          await page
            .getByRole("button", { name: "제출값 확인", exact: true })
            .click();
        await expect(page.locator(".periodogram-card")).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        // boundingBox()는 뷰포트 기준이라 포커스 이동으로 페이지가 스크롤되면
        // 값이 달라진다. 확인하려는 것은 배치 위치이므로 문서 기준으로 읽는다.
        const scrollY = await page.evaluate(() => window.scrollY);
        const time = (await page
            .locator(".analysis-time-curve")
            .boundingBox())!,
          folded = (await page.locator(".fold-panel").boundingBox())!;
        positions.push({
          timeX: time.x,
          timeY: time.y + scrollY,
          foldX: folded.x,
          foldY: folded.y + scrollY,
        });
      }
      expect(
        positions.every(
          (x) => JSON.stringify(x) === JSON.stringify(positions[0]),
        ),
      ).toBe(true);
    },
  );

for (const [tic, message] of [
  ["259377027", "표시할 추천 봉우리 자료가 없습니다"],
  ["259377028", "주기도를 불러오지 못했습니다"],
])
  test("unavailable state " + tic, async ({ page }) => {
    await page.goto("/analysis/" + tic);
    await expect(page.locator(".periodogram-state")).toContainText(message);
    await expect(
      page.getByRole("button", { name: "주기도 다시 불러오기" }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "시간 곡선 그래프", exact: true }),
    ).toBeVisible();
  });

test("fine tuning never flickers the next-step button while a slow fold still locks it", async ({
  page,
}) => {
  await choose(page);
  const next = page.getByRole("button", {
    name: "이 주기로 구간 선택",
    exact: true,
  });
  await expect(next).toBeEnabled();
  // 접기 한 번은 10ms 남짓이라 잠금을 그대로 표시하면 프레임마다 깜빡인다.
  await page.evaluate(() => {
    const w = window as unknown as { __flips: number };
    w.__flips = 0;
    const find = () =>
      [...document.querySelectorAll(".analysis-judgment button")].find((b) =>
        b.textContent?.includes("이 주기로 구간 선택"),
      ) as HTMLButtonElement | undefined;
    let last = find()?.disabled;
    new MutationObserver(() => {
      const b = find();
      if (b && b.disabled !== last) {
        last = b.disabled;
        w.__flips += 1;
      }
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      attributeFilter: ["disabled"],
    });
  });
  const slider = page.getByRole("slider", { name: "반복 주기 미세 조정" });
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    await page.mouse.move(
      box.x + box.width / 2 + i * 6,
      box.y + box.height / 2,
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { __flips: number }).__flips,
    ),
  ).toBe(0);
  await expect(next).toBeEnabled();
});

test("a slow fold locks the next-step button together with the progress notice", async ({
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
  await page.goto(url);
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  const next = page.getByRole("button", {
    name: "이 주기로 구간 선택",
    exact: true,
  });
  await expect(page.getByTestId("fold-status")).toContainText("접고 있습니다");
  await expect(next).toBeDisabled();
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  await expect(next).toBeEnabled();
});
