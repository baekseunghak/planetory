import { expect, test, type Page } from "@playwright/test";
import { PERIODOGRAM_FIXTURE_TICS } from "../../dev/periodogram-fixtures.ts";
import {
  DEPENDENCY_UNAVAILABLE_MESSAGE,
  RESIDUAL_FIXTURE_HEADER,
} from "../../dev/residual-job-fixtures.ts";
import { beginRange, selectPeak, showJudgment } from "../analysis-ui";

// 곡선 단계 이동(#189). 계산이 끝나야 곡선이 바뀐다.

const NORMAL = PERIODOGRAM_FIXTURE_TICS.normal;
const bar = (page: Page) => page.locator(".curve-step-bar");
const move = (page: Page, name: string) =>
  bar(page).getByRole("button", { name, exact: true });
/**
 * 개발용 응답의 캐시는 서버 수명 동안 남는다. **캐시만 건너뛴다.**
 *
 * 전에는 나가는 목표를 몰래 바꿔 캐시를 피했는데, 그러면 서버가 돌려주는
 * 문맥과 화면이 들고 있는 목표가 달라진다. 실제로는 일어날 수 없는 상태라,
 * 서버가 준 `resultCurveContext`로 조회하기 시작하자 곧바로 깨졌다.
 */
async function freshTarget(page: Page) {
  await page.route("**/api/v1/stars/*/residual-jobs", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    return route.continue({
      headers: { ...request.headers(), [RESIDUAL_FIXTURE_HEADER]: "fresh" },
    });
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

test("what the bar says is what the charts and the submission use", async ({
  page,
}) => {
  // 표시줄만 바뀌고 차트·주기도·제출이 이전 문맥이면 단계 이동이 아니다.
  // 문구가 아니라 **실제로 나간 요청**을 본다.
  const curves: string[] = [];
  const periodograms: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const step = url.searchParams.get("curveStep");
    if (step === null) return;
    if (url.pathname.endsWith("/curves")) curves.push(step);
    if (url.pathname.endsWith("/periodogram")) periodograms.push(step);
  });
  await freshTarget(page);
  await page.goto(`/analysis/${NORMAL}`);
  await expect(bar(page).locator(".curve-step-where")).toContainText(
    "원본 곡선",
  );
  expect(curves.at(-1), "들어올 때는 진입 단계를 읽는다").toBe("0");

  await move(page, "다음 곡선 단계로").click();
  await expect(bar(page).locator(".curve-step-where")).toContainText(
    "곡선 단계 1",
  );
  // 표시가 바뀌었으면 곡선도 그 단계를 읽었어야 한다.
  expect(curves.at(-1), "전환 뒤 곡선이 새 단계로 바뀌지 않았다").toBe("1");
  await expect
    .poll(() => periodograms.at(-1), {
      message: "주기도가 이전 단계에 남아 있다",
    })
    .toBe("1");

  // 제출도 보고 있는 단계로 나간다.
  const sent: number[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/submissions") || request.method() !== "POST")
      return;
    sent.push(JSON.parse(request.postData() ?? "{}").curveContext.curveStep);
  });
  await selectPeak(page, 1);
  await beginRange(page);
  await showJudgment(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  const result = page.getByTestId("submission-result");
  await expect(result).toBeVisible();
  expect(sent, "제출이 이전 단계 문맥으로 나갔다").toEqual([1]);
  // 옮긴 단계의 문맥이 서버에 받아들여진다. 거절되면 단계를 옮긴 뒤 제출을
  // 할 수 없다는 뜻이다.
  await expect(result).toContainText("접수되었습니다");

  // 원본으로 돌아가면 다시 0을 읽는다.
  await page
    .getByTestId("submission-result")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await move(page, "← 이전 단계").click();
  await expect(bar(page).locator(".curve-step-where")).toContainText(
    "원본 곡선",
  );
  expect(curves.at(-1)).toBe("0");
});

/** 시나리오 헤더를 붙여 보낸다. */
async function withScenario(page: Page, scenario: string) {
  await page.route("**/api/v1/stars/*/residual-jobs", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    return route.continue({
      headers: { ...request.headers(), [RESIDUAL_FIXTURE_HEADER]: scenario },
    });
  });
}

test("a failure that will not change is not offered a retry", async ({
  page,
}) => {
  // 7.2절 `failure.retryable: false`. 눌러도 같은 결과인 버튼은 사용자에게
  // 「내가 뭘 잘못했나」를 묻게 만든다.
  await withScenario(page, "fail-permanent");
  await page.goto(`/analysis/${NORMAL}`);
  await move(page, "다음 곡선 단계로").click();
  await expect(bar(page)).toContainText("보고 있던 곡선은 그대로입니다");
  await expect(move(page, "다시 시도")).toHaveCount(0);
  // 보던 곡선은 그대로다.
  await expect(bar(page).locator(".curve-step-where")).toContainText(
    "원본 곡선",
  );
});

test("a dependency that is not wired yet is not called a failure", async ({
  page,
}) => {
  // 미연결 503은 다시 요청해도 같은 결과다(`retryable: false`).
  await withScenario(page, "unavailable");
  await page.goto(`/analysis/${NORMAL}`);
  await move(page, "다음 곡선 단계로").click();
  await expect(bar(page)).toContainText("보고 있던 곡선은 그대로입니다");
  await expect(move(page, "다시 시도")).toHaveCount(0);
  // 실패가 아니라 준비되지 않은 것이라 경보로 외치지 않는다.
  await expect(bar(page).getByRole("alert")).toHaveCount(0);
  // **서버 문구를 그대로 옮긴다**(7.1절). 화면이 문구를 지어내지 않는다.
  // 개발용 응답이 여기에 코드 이름을 넣고 있던 동안 이 줄이 없어서, 문구가
  // 재시도를 권하는데 버튼은 없는 상태를 검사가 통과시켰다.
  await expect(bar(page)).toContainText(
    DEPENDENCY_UNAVAILABLE_MESSAGE.notConnected,
  );
});

test("the same 503 offers a retry when the server says it is retryable", async ({
  page,
}) => {
  // 같은 코드·같은 상태인데 화면이 할 일이 반대다(7.1절, #249). 실행기를
  // 시작하지 못한 것은 다시 요청하는 것이 맞다.
  await withScenario(page, "start-failed");
  await page.goto(`/analysis/${NORMAL}`);
  await move(page, "다음 곡선 단계로").click();
  await expect(move(page, "다시 시도")).toHaveCount(1);
  await expect(bar(page)).toContainText(
    DEPENDENCY_UNAVAILABLE_MESSAGE.serverDefault,
  );
  // **덧붙이지 않는다.** 서버 문구가 이미 다시 시도하라고 말하므로 일반 실패
  // 경로처럼 꼬리를 붙이면 같은 말이 두 번 나온다.
  expect(
    ((await bar(page).innerText()).match(/잠시 후 다시 시도해 주세요/g) ?? [])
      .length,
  ).toBe(1);
});

test("a 503 without the field is read as retryable", async ({ page }) => {
  // **배포 순서의 창.** 화면이 `retryable`을 읽기 시작했는데 서버가 아직
  // 보내지 않는 동안이다(#249 전). 모르는 것 때문에 나갈 길을 막지 않는다 —
  // 7.2절 `failure.retryable`과 같은 규칙이다.
  //
  // 이 검사가 없으면 기본값을 `=== true`로 뒤집어도 아무것도 깨지지 않는다.
  // 개발용 503 둘이 모두 필드를 실어, 필드가 없는 경로가 검사에 오지 않는다.
  await withScenario(page, "unavailable-legacy");
  await page.goto(`/analysis/${NORMAL}`);
  await move(page, "다음 곡선 단계로").click();
  await expect(move(page, "다시 시도")).toHaveCount(1);
  await expect(bar(page)).toContainText(
    DEPENDENCY_UNAVAILABLE_MESSAGE.serverDefault,
  );
});

test("a plate that changes mid-computation reloads by itself", async ({
  page,
}) => {
  // D-5: 계산이 도는 동안의 교체는 폴링 헤더로만 드러난다. 곡선 조회가
  // 하던 것을 폴링도 한다 — 누르라고 하지 않고 스스로 다시 읽는다.
  const entries: string[] = [];
  page.on("request", (request) => {
    if (/analysis-context$/.test(request.url())) entries.push(request.url());
  });
  await withScenario(page, "plate-changed");
  await page.goto(`/analysis/${NORMAL}`);
  const before = entries.length;
  await move(page, "다음 곡선 단계로").click();
  // 다 읽고 나면 화면이 갱신됐다고 말한다. 곡선 조회가 판 교체를 만났을
  // 때와 **같은 안내**다 — 어느 경로로 감지됐든 화면이 같아야 한다.
  await expect(page.locator("body")).toContainText(
    "새 데이터 판으로 갱신했습니다",
  );
  // 안내만 띄우고 마는 것이 아니라 진입을 실제로 다시 조회한다.
  await expect
    .poll(() => entries.length, { timeout: 5000 })
    .toBeGreaterThan(before);
  // 누르라고 하지 않는다.
  await expect(
    page.getByRole("button", { name: "최신 자료 불러오기" }),
  ).toHaveCount(0);
});
