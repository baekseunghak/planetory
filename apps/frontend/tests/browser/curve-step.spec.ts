import { expect, test, type Page } from "@playwright/test";
import { PERIODOGRAM_FIXTURE_TICS } from "../../dev/periodogram-fixtures.ts";
import { RESIDUAL_FIXTURE_HEADER } from "../../dev/residual-job-fixtures.ts";
import { beginRange, selectPeak, showJudgment } from "../analysis-ui";

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
  // 서버가 기다리라고 한 동안에는 누를 수 없다. 말과 버튼이 다르면 곧바로
  // 눌러 대기열을 한 번 더 두드린다.
  const retry = bar(page).getByRole("button", { name: /^다시 시도/ });
  await expect(retry).toBeDisabled();
  await expect(retry).toContainText("초");

  scenario = "other-job";
  // 대기가 끝나면 열린다. 개발용 응답이 12초를 주므로 시계를 앞당긴다.
  await page.clock.install();
  await page.clock.fastForward("00:13");
  await expect(retry).toBeEnabled();
  await retry.click();
  // 내가 이미 돌리고 있는 작업이다. 기다리라고 하면 안 된다(D-4).
  await expect(bar(page)).toContainText("다른 곡선을 이미 계산하고 있습니다");
  await expect(bar(page)).not.toContainText("대기가 가득");
});

test("the result screen moves the step in place, not by navigating", async ({
  page,
}) => {
  await freshTarget(page);
  await page.goto(`/analysis/${NORMAL}`);
  const before = page.url();
  await selectPeak(page);
  await beginRange(page);
  await showJudgment(page);
  await page.getByRole("radio", { name: "행성 같음", exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const dialog = page.getByTestId("submission-result");
  const action = dialog
    .getByTestId("next-actions")
    .getByRole("button", { name: "다음 곡선 단계로", exact: true });
  // 「연결 예정」이 아니라 실제 버튼이다.
  await expect(action).toBeEnabled();
  await action.click();

  // 같은 화면에서 일어난다. 주소는 그대로다(SRS 3.2 흐름).
  await expect(dialog).toBeHidden();
  expect(page.url()).toBe(before);
  // 진입 때 매칭해 둔 하나에 방금 맞힌 것이 더해져 단계 2다. 진입 응답의
  // `nextCurveContext`(단계 1)를 그대로 썼다면 방금 맞힌 신호가 빠진다.
  await expect(bar(page).locator(".curve-step-where")).toContainText(
    "곡선 단계 2",
  );
});

test("a submission refused for a missing residual can ask for it", async ({
  page,
}) => {
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    return route.continue({
      headers: {
        ...request.headers(),
        "x-fixture-submit": "context-not-ready",
      },
    });
  });
  await freshTarget(page);
  await page.goto(`/analysis/${NORMAL}`);
  await selectPeak(page);
  await beginRange(page);
  await showJudgment(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const dialog = page.getByTestId("submission-result");
  await expect(dialog).toContainText("아직 제출할 수 없습니다");
  // #187은 「준비되면 다시 보낼 수 있다」까지만 말했다. 이제 준비시킬 수 있다.
  await dialog
    .getByRole("button", { name: "이 단계 계산 준비하기", exact: true })
    .click();
  // 제자리 계산이다. 보고 있는 단계가 바뀌지 않는다.
  await expect(bar(page).locator(".curve-step-where")).toContainText(
    "원본 곡선",
  );
});

test("a job that vanishes is recovered without the user pressing anything", async ({
  page,
}) => {
  // Redis 재시작으로 작업이 사라진 경우다(7.2절). 실패로 보여 주고 사용자가
  // [다시 시도]를 누르게 하지 않는다. 같은 목표로 다시 요청하면 그만이다.
  const posts: string[] = [];
  await page.route("**/api/v1/stars/*/residual-jobs", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    posts.push(request.postData() ?? "");
    return route.continue({
      headers: { ...request.headers(), [RESIDUAL_FIXTURE_HEADER]: "lose-job" },
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  await move(page, "다음 곡선 단계로").click();

  // 사라져도 전환은 끝까지 간다.
  await expect(bar(page).locator(".curve-step-where")).toContainText(
    "곡선 단계 1",
  );
  await expect(bar(page)).not.toContainText("보고 있던 곡선은 그대로입니다");
  await expect(move(page, "다시 시도")).toHaveCount(0);
  // 스스로 한 번 더 요청했고, 두 번 다 같은 목표다.
  expect(posts).toHaveLength(2);
  expect(posts[1]).toBe(posts[0]);
});
