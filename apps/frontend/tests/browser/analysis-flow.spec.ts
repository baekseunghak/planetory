import { expect, test, type Locator, type Page } from "@playwright/test";

// Traverse the actual Tab order; do not bypass unreachable controls with focus().
async function tabTo(page: Page, target: Locator, backwards = false) {
  await expect(target).toBeVisible();
  for (let i = 0; i < 100; i++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
  }
  throw new Error(
    `Keyboard could not reach ${(await target.getAttribute("aria-label")) ?? (await target.textContent())}`,
  );
}

test("1024px keyboard journey reaches selection, judgment, review and return without pointer input", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/analysis/259377024?returnTo=%2Fsky%3Ffocus%3D259377024");
  await expect(page.locator('[aria-current="step"]')).toContainText(
    "봉우리 선택",
  );
  await tabTo(
    page,
    page.getByRole("button", { name: "1위 봉우리 선택", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  await expect(page.locator('[aria-current="step"]')).toContainText(
    "주기 맞추기",
  );
  const folded = page.getByRole("group", {
    name: "접힌 곡선 그래프",
    exact: true,
  });
  await tabTo(page, folded);
  for (let i = 0; i < 5; i++) await page.keyboard.press("+");
  await page.keyboard.press("ArrowRight");
  await tabTo(
    page,
    page.getByRole("button", { name: "구간 선택 시작", exact: true }),
  );
  await page.keyboard.press("Enter");
  const start = page.getByRole("slider", {
    name: "위상 구간 시작",
    exact: true,
  });
  const end = page.getByRole("slider", { name: "위상 구간 끝", exact: true });
  await expect(start).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Tab");
  await expect(end).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('[aria-current="step"]')).toContainText(
    "구간 선택",
  );
  await tabTo(
    page,
    page.getByRole("button", { name: "구간 확정하고 판단하기", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("radio", { name: "행성 같음", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("checkbox", { name: "홀짝 깊이", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Space");
  await tabTo(page, page.getByLabel("메모 (선택)", { exact: true }));
  await page.keyboard.insertText("키보드로 확인한 구간");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "제출값 확인", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const review = page.getByTestId("candidate-review");
  await expect(review.getByRole("heading")).toBeFocused();
  await expect(review).toContainText("아닌 것 같음");
  await expect(review).toContainText("키보드로 확인한 구간");
  expect(
    await review.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "판단 수정", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("radio", { name: "행성 같음", exact: true }),
  ).toBeFocused();
  await tabTo(
    page,
    page.getByRole("button", { name: "한 간격 늘리기", exact: true }),
    true,
  );
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  await expect(page.locator('[aria-current="step"]')).toContainText(
    "주기 맞추기",
  );
  await expect(page.getByLabel("메모 (선택)", { exact: true })).toHaveValue("");
  await tabTo(
    page,
    page.getByRole("link", { name: "이전 화면으로", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sky\?focus=259377024$/);
  await page.setViewportSize({ width: 1023, height: 900 });
  await expect(
    page.getByRole("heading", { name: "데스크톱에서 이용해 주세요" }),
  ).toBeVisible();
});

test("changing the star clears the reviewed draft and leaves empty/error samples usable", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
  await page
    .getByRole("button", { name: "구간 확정하고 판단하기", exact: true })
    .click();
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByLabel("메모 (선택)", { exact: true }).fill("이전 별의 초안");
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toBeVisible();
  await page.getByRole("link", { name: "빈 봉우리 샘플", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toHaveCount(0);
  await expect(
    page.getByText("표시할 추천 봉우리 자료가 없습니다.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "주기도 다시 불러오기", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("group", { name: "시간 곡선 그래프", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("메모 (선택)", { exact: true })).toHaveCount(0);
  await page
    .getByRole("link", { name: "주기도 정상 샘플", exact: true })
    .click();
  await expect(page.getByLabel("메모 (선택)", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "제출값 확인", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("link", { name: "주기도 오류 샘플", exact: true })
    .click();
  await expect(page.getByTestId("candidate-review")).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "시간 곡선 그래프", exact: true }),
  ).toBeVisible();
});
