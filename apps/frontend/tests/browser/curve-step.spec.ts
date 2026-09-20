import { expect, test, type Page } from "@playwright/test";
import { PERIODOGRAM_FIXTURE_TICS } from "../../dev/periodogram-fixtures.ts";
import { RESIDUAL_FIXTURE_HEADER } from "../../dev/residual-job-fixtures.ts";

// 곡선 단계 이동(#189). 계산이 끝나야 곡선이 바뀐다.

const NORMAL = PERIODOGRAM_FIXTURE_TICS.normal;
const bar = (page: Page) => page.locator(".curve-step-bar");
const move = (page: Page, name: string) =>
  bar(page).getByRole("button", { name, exact: true });
/** 개발용 응답의 캐시는 서버 수명 동안 남는다. 목표를 매번 다르게 만든다. */
async function freshTarget(page: Page) {
  await page.route("**/api/v1/stars/*/residual-jobs", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const body = JSON.parse(request.postData() ?? "{}");
    body.target.residualModelVersion = `rm-${crypto.randomUUID().slice(0, 8)}`;
    return route.continue({ postData: JSON.stringify(body) });
  });
}

test("a step moves only after the computation finishes", async ({ page }) => {
  await freshTarget(page);
  await page.goto(`/analysis/${NORMAL}`);
  await expect(bar(page)).toContainText("원본 곡선");
  // 이 별에서 이미 하나를 매칭했으므로 갈 다음 단계가 있다.
  await expect(bar(page)).toContainText("이 별에서 찾은 신호 1");
  await expect(move(page, "← 이전 단계")).toBeDisabled();
  await expect(move(page, "원본 곡선")).toBeDisabled();

  await move(page, "다음 곡선 단계로").click();
  const progress = page.getByTestId("residual-progress");
  await expect(progress).toBeVisible();
  // 순서를 끝까지 보여 준다. 어디까지 왔는지 모르면 기다림이 더 길다.
  for (const state of ["대기", "잔차 계산", "잔차 준비", "주기도 계산", "완료"])
    await expect(progress).toContainText(state);
  // 계산 중에는 다른 곳으로 옮길 수 없다.
  await expect(move(page, "← 이전 단계")).toBeDisabled();

  await expect(bar(page).locator(".curve-step-where")).toContainText(
    "곡선 단계 1",
  );
  await expect(progress).toBeHidden();
});

test("going back returns the way we came", async ({ page }) => {
  await freshTarget(page);
  await page.goto(`/analysis/${NORMAL}`);
  await move(page, "다음 곡선 단계로").click();
  const where = bar(page).locator(".curve-step-where");
  await expect(where).toContainText("곡선 단계 1");

  // 원본으로 돌아가는 데는 계산이 필요 없다(5.2절).
  await move(page, "← 이전 단계").click();
  await expect(where).toContainText("원본 곡선");
  await expect(page.getByTestId("residual-progress")).toBeHidden();
  // 돌아온 뒤에는 갈 이전이 없다.
  await expect(move(page, "← 이전 단계")).toBeDisabled();
});

test("a failed computation keeps the curve we were looking at", async ({
  page,
}) => {
  await page.route("**/api/v1/stars/*/residual-jobs", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    return route.continue({
      headers: { ...request.headers(), [RESIDUAL_FIXTURE_HEADER]: "fail" },
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  await move(page, "다음 곡선 단계로").click();
  const where = bar(page).locator(".curve-step-where");
  await expect(bar(page)).toContainText("보고 있던 곡선은 그대로입니다");
  // 실패는 전환이 안 된 것이지 앞선 결과가 사라진 것이 아니다.
  await expect(where).toContainText("원본 곡선");
  await expect(move(page, "다시 시도")).toBeVisible();
});

test("the two queue refusals do not say the same thing", async ({ page }) => {
  let scenario = "queue-full";
  await page.route("**/api/v1/stars/*/residual-jobs", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    return route.continue({
      headers: { ...request.headers(), [RESIDUAL_FIXTURE_HEADER]: scenario },
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  await move(page, "다음 곡선 단계로").click();
  // 대기열이 찼다. 기다리면 된다.
  await expect(bar(page)).toContainText("계산 대기가 가득 찼습니다");
  await expect(bar(page)).toContainText("12초");

  scenario = "other-job";
  await move(page, "다시 시도").click();
  // 내가 이미 돌리고 있는 작업이다. 기다리라고 하면 안 된다(D-4).
  await expect(bar(page)).toContainText("다른 곡선을 이미 계산하고 있습니다");
  await expect(bar(page)).not.toContainText("대기가 가득");
});
