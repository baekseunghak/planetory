import { expect, type Page } from "@playwright/test";
export async function selectPeak(page: Page, rank = 1) {
  const peak = page.getByRole("button", {
    name: `${rank}위 봉우리 선택`,
    exact: true,
  });
  if ((await peak.getAttribute("aria-disabled")) === "true")
    await page
      .locator(".analysis-steps")
      .getByRole("button", { name: /주기 선택/ })
      .click();
  await peak.click();
}
export async function rangeStage(page: Page) {
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "true",
  );
  const next = page.getByRole("button", {
    name: "이 주기로 구간 선택",
    exact: true,
  });
  if (await next.count()) await next.click();
  else if (
    !(await page.locator('[aria-current="step"]').textContent())?.includes(
      "구간 선택",
    )
  )
    await page
      .locator(".analysis-steps")
      .getByRole("button", { name: /구간 선택/ })
      .click();
  const details = page.locator(".phase-keyboard-details");
  if (!((await details.getAttribute("open")) !== null))
    await details.locator("summary").click();
}
export async function beginRange(page: Page) {
  await rangeStage(page);
  await page
    .getByRole("button", { name: "구간 선택 시작", exact: true })
    .click();
}
export async function tune(
  page: Page,
  direction: "ArrowRight" | "ArrowLeft" = "ArrowRight",
) {
  const slider = page.getByRole("slider", { name: "반복 주기 미세 조정" });
  if (await slider.isDisabled())
    await page
      .locator(".analysis-steps")
      .getByRole("button", { name: /주기 선택/ })
      .click();
  await slider.press(direction);
}
export async function openData(page: Page) {
  const d = page
    .locator(".analysis-secondary details")
    .filter({ has: page.getByText("데이터 상세 ›", { exact: true }) });
  await d.waitFor();
  if ((await d.getAttribute("open")) === null)
    await d.locator("summary").click();
}
export async function openMemo(page: Page) {
  const d = page.locator(".memo-details");
  if ((await d.getAttribute("open")) === null)
    await d.locator("summary").click();
}
export async function showJudgment(page: Page) {
  await page
    .getByRole("button", { name: "구간 확정하고 판단하기", exact: true })
    .click();
  await openMemo(page);
}
export async function logout(page: Page) {
  await page.getByRole("button", { name: "메뉴", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "로그아웃", exact: true })
    .click();
}
