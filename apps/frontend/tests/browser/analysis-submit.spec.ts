import { expect, test, type Page } from "@playwright/test";
import { PERIODOGRAM_FIXTURE_TICS } from "../../dev/periodogram-fixtures.ts";
import { beginRange, selectPeak, showJudgment } from "../analysis-ui";

// 화면에서 제출까지 가는 경로. 사다리 자체는 submission-recovery.spec.ts가 보고,
// 여기서는 버튼·안내·잠금이 사용자에게 어떻게 보이는지 확인한다.
const NORMAL = PERIODOGRAM_FIXTURE_TICS.normal;
const TUTORIAL = PERIODOGRAM_FIXTURE_TICS.tutorial;

async function reachReview(page: Page) {
  // 기존 헬퍼의 키보드 경로를 쓴다. 손으로 드래그하면 폭 규칙에 걸려 흔들린다.
  await selectPeak(page);
  await beginRange(page);
  await showJudgment(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toBeVisible();
}

test("the review step submits and shows what was accepted", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  await reachReview(page);
  const submit = page.getByRole("button", { name: "제출하기", exact: true });
  // 더 이상 「연결 예정」이 아니다.
  await expect(submit).toBeEnabled();
  await submit.click();

  const receipt = page.getByTestId("submission-result");
  await expect(receipt).toBeVisible();
  await expect(receipt.getByRole("heading")).toHaveText("접수되었습니다");
  // 접수 사실과 식별자만 보여 준다. 결과 풀이는 A06-2의 몫이다.
  await expect(receipt).toContainText("접수 번호");
  await expect(receipt).toContainText("기록 번호");
  await expect(receipt).toContainText("아직 연결되지 않았습니다");

  // 접수한 뒤에는 초안을 고칠 수 없다. 고치면 복구 경로가 막힌다.
  await expect(submit).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "판단·메모 수정 →", exact: true }),
  ).toBeDisabled();
});

test("a lost response asks the user to check instead of submitting again", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  // 첫 POST만 읽을 수 없는 응답으로 바꾼다. 조회와 재전송은 실제 서버가 답한다.
  let dropped = false;
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    if (route.request().method() !== "POST" || dropped) return route.continue();
    dropped = true;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"code":"SERVER_ERROR"',
    });
  });
  await reachReview(page);
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  // 조회가 미접수를 알려 같은 번호로 다시 보냈고 이번에 접수됐다.
  const receipt = page.getByTestId("submission-result");
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("다시 확인했고, 이번에 접수되었습니다");
});

test("an unresolved submission offers a check that never resubmits", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  // 제출도 조회도 결과를 주지 못하게 막는다. 자동 복구가 끝나면 사용자 차례다.
  const posts: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = route.request().url();
    if (/\/submissions$/.test(url) && route.request().method() === "POST") {
      posts.push(url);
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"code":"SERVER_ERROR"',
      });
    }
    if (url.includes("/submissions/by-request/"))
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "DEPENDENCY_UNAVAILABLE", message: "x" }),
      });
    return route.continue();
  });
  await reachReview(page);
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const panel = page.getByTestId("submission-result");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading")).toHaveText(
    "접수 여부를 확인해 주세요",
  );
  // 「제출되지 않았습니다」라고 단정하지 않는다.
  await expect(panel).not.toContainText("제출되지 않았");
  const sent = posts.length;

  await panel
    .getByRole("button", { name: "접수 결과 확인", exact: true })
    .click();
  await expect(panel).toBeVisible();
  // 확인은 조회만 한다. 제출을 한 번도 더 보내지 않는다.
  expect(posts.length).toBe(sent);
});

test("a refused submission explains the field and lets the draft be edited again", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  await page.route("**/api/v1/stars/*/submissions", async (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            code: "VALIDATION_FAILED",
            message: "입력을 확인해 주세요.",
            fieldErrors: [
              { field: "selection.periodDays", reason: "Invalid input" },
            ],
          }),
        })
      : route.continue(),
  );
  await reachReview(page);
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const failure = page.getByTestId("submission-result");
  await expect(failure).toBeVisible();
  // 서버의 필드 경로를 화면의 말로 바꾼다.
  await expect(failure).toContainText("주기: Invalid input");
  // 거절은 접수가 아니므로 입력을 계속 고칠 수 있다.
  await expect(
    page.getByRole("button", { name: "제출하기", exact: true }),
  ).toBeEnabled();
  await failure
    .getByRole("button", { name: "입력으로 돌아가기", exact: true })
    .click();
  await expect(failure).toBeHidden();
  // 거절을 닫으면 상태를 지운다. 남길 접수 결과가 없기 때문이다.
  await expect(page.locator(".submission-reminder")).toHaveCount(0);
});

test("skipping is offered only where the server allows it", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  const ordinary = page.locator(".submission-alternatives");
  await expect(
    ordinary.getByRole("button", { name: "더 이상 없음", exact: true }),
  ).toBeEnabled();
  const skip = ordinary.getByRole("button", {
    name: "이 별 건너뛰기",
    exact: true,
  });
  await expect(skip).toBeDisabled();
  await expect(ordinary).toContainText("지금은 건너뛸 수 없습니다");

  await page.goto(`/analysis/${TUTORIAL}`);
  await expect(
    page
      .locator(".submission-alternatives")
      .getByRole("button", { name: "이 별 건너뛰기", exact: true }),
  ).toBeEnabled();
});

test("more-none is confirmed once and sends no judgment with it", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (/\/submissions$/.test(request.url()) && request.method() === "POST")
      bodies.push(JSON.parse(request.postData() ?? "{}"));
  });
  await page
    .locator(".submission-alternatives")
    .getByRole("button", { name: "더 이상 없음", exact: true })
    .click();
  // 브라우저 기본 confirm이 아니라 같은 언어의 대화상자로 묻는다.
  await page
    .getByTestId("submission-confirm")
    .getByRole("button", { name: "보내기", exact: true })
    .click();

  await expect(page.getByTestId("submission-result")).toContainText(
    "더 이상 없음으로 접수했습니다",
  );
  expect(bodies).toHaveLength(1);
  // 완료 조건: 이전 후보의 수치·판단·근거가 섞이면 안 된다.
  expect(Object.keys(bodies[0]).sort()).toEqual([
    "curveContext",
    "requestId",
    "retryOfSubmissionId",
    "submissionKind",
  ]);
  expect(bodies[0].submissionKind).toBe("no_candidate");
});

test("the result opens as a centred dialog that can be closed and reopened", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  await reachReview(page);
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const dialog = page.getByTestId("submission-result");
  await expect(dialog).toBeVisible();
  // 모달이어야 배경이 비활성화되고 포커스가 안에 갇힌다.
  expect(
    await dialog.evaluate((node: HTMLDialogElement) => node.matches(":modal")),
  ).toBe(true);
  await expect(dialog.locator('[role="status"]').first()).toBeFocused();

  // Escape로 닫아도 접수 결과를 잃지 않는다.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const reminder = page.locator(".submission-reminder");
  await expect(reminder).toContainText("접수 완료");
  // 대화상자를 연 버튼은 제출 뒤 비활성이라 포커스가 문서 맨 위로 떨어지기 쉽다.
  const reopen = reminder.getByRole("button", {
    name: "접수 결과 보기",
    exact: true,
  });
  await expect(reopen).toBeFocused();

  await reopen.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("접수 번호");
});

test("an irreversible submission is confirmed in the app, not by the browser", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  // 브라우저 기본 대화상자가 뜨면 이 검사는 여기서 멈춘다.
  let native = false;
  page.on("dialog", (dialog) => {
    native = true;
    void dialog.dismiss();
  });
  const sent: string[] = [];
  page.on("request", (request) => {
    if (/[/]submissions$/.test(request.url()) && request.method() === "POST")
      sent.push(request.url());
  });

  const opener = page
    .locator(".submission-alternatives")
    .getByRole("button", { name: "더 이상 없음", exact: true });
  await opener.click();
  const confirm = page.getByTestId("submission-confirm");
  await expect(confirm).toBeVisible();
  expect(native).toBe(false);
  await expect(confirm).toContainText("되돌릴 수 없습니다");
  // 되돌릴 수 없는 동작이므로 안전한 쪽에 포커스가 간다.
  const cancel = confirm.getByRole("button", { name: "취소", exact: true });
  await expect(cancel).toBeFocused();

  await cancel.click();
  await expect(confirm).toBeHidden();
  // 취소는 아무것도 보내지 않고 누른 버튼으로 포커스를 돌려준다.
  expect(sent).toHaveLength(0);
  await expect(opener).toBeFocused();

  await opener.click();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  expect(sent).toHaveLength(0);

  await opener.click();
  await confirm.getByRole("button", { name: "보내기", exact: true }).click();
  await expect(page.getByTestId("submission-result")).toContainText(
    "접수되었습니다",
  );
  expect(sent).toHaveLength(1);
});

test("a not-ready residual says why and keeps the same request id for the retry", async ({
  page,
}) => {
  const ids: string[] = [];
  let ready = false;
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    ids.push(JSON.parse(request.postData() ?? "{}").requestId);
    // 잔차가 준비되기 전에는 거절하고, 준비된 뒤에는 개발 서버가 받게 둔다.
    if (ready) return route.continue();
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "SUBMISSION_CONTEXT_NOT_READY",
        message: "이 단계의 잔차가 준비되지 않았습니다.",
        fieldErrors: [],
        residual: { status: "QUEUED", jobId: "job-7701", computedAt: null },
      }),
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  await reachReview(page);
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const dialog = page.getByTestId("submission-result");
  // 못 보낸 것이 아니라 아직 못 보내는 것이다. 말이 달라야 한다.
  await expect(dialog).toContainText("아직 제출할 수 없습니다");
  await expect(dialog).toContainText(
    "같은 내용을 그대로 다시 보낼 수 있습니다",
  );
  // 왜 못 보내는지 서버가 준 상태 그대로 알린다.
  await expect(dialog).toContainText("계산을 기다리는 중입니다");
  await expect(dialog).toContainText("job-7701");

  // 접수가 아니므로 초안이 잠기지 않는다.
  await expect(
    page.getByRole("button", { name: "제출하기", exact: true }),
  ).toBeEnabled();

  ready = true;
  await dialog
    .getByRole("button", { name: "입력으로 돌아가기", exact: true })
    .click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await expect(dialog).toContainText("접수되었습니다");
  // 본문이 그대로이므로 같은 요청 ID로 다시 보낸다. 새 ID를 만들면 안 된다.
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

test("an unresolved submission survives a reload and blocks a different one", async ({
  page,
}) => {
  // 리뷰 재현: 저장은 됐는데 응답을 잃고, 조회도 막힌다.
  let blockChecks = true;
  await page.route("**/api/v1/submissions/by-request/*", async (route) =>
    blockChecks
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "DEPENDENCY_UNAVAILABLE",
            message: "조회할 수 없습니다.",
            fieldErrors: [],
          }),
        })
      : route.continue(),
  );
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    posts.push(JSON.parse(request.postData() ?? "{}"));
    // 서버에는 남았지만 응답은 돌아오지 않는다.
    await route.continue({
      headers: { ...request.headers(), "x-fixture-submit": "drop-saved" },
    });
  });

  await page.goto(`/analysis/${TUTORIAL}`);
  await page
    .locator(".submission-alternatives")
    .getByRole("button", { name: "더 이상 없음", exact: true })
    .click();
  await page
    .getByTestId("submission-confirm")
    .getByRole("button", { name: "보내기", exact: true })
    .click();
  const dialog = page.getByTestId("submission-result");
  await expect(dialog).toContainText("접수 여부를 확인해 주세요");
  const sentId = posts[0].requestId;

  // 새로고침해도 미확인 요청이 사라지면 안 된다.
  await page.reload();
  await expect(dialog).toContainText("결과를 확인하지 못한 제출이 있습니다");
  await expect(
    dialog.getByRole("button", { name: "접수 결과 확인", exact: true }),
  ).toBeVisible();

  // 되살린 미확인 요청이 초안을 잠근다. 결과를 모르는 채로 다른 제출을
  // 보내면 앞선 요청의 ID를 잃고 같은 일을 두 번 접수할 수 있다.
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  const alternatives = page.locator(".submission-alternatives");
  await expect(
    alternatives.getByRole("button", { name: "이 별 건너뛰기", exact: true }),
  ).toBeDisabled();
  await expect(
    alternatives.getByRole("button", { name: "더 이상 없음", exact: true }),
  ).toBeDisabled();
  expect(posts).toHaveLength(1);

  // 되살린 상태에서도 확인 경로는 남아 있다.
  await page
    .locator(".submission-reminder")
    .getByRole("button", { name: "접수 결과 보기", exact: true })
    .click();

  // 조회가 풀리면 원래 요청의 접수 결과를 그대로 확인할 수 있다.
  blockChecks = false;
  await dialog
    .getByRole("button", { name: "접수 결과 확인", exact: true })
    .click();
  await expect(dialog).toContainText("접수되었습니다");
  expect(posts).toHaveLength(1);
  expect(posts[0].requestId).toBe(sentId);
});

test("a check that finds nothing offers the same id and body again", async ({
  page,
}) => {
  const posts: Record<string, unknown>[] = [];
  // 조회는 늘 미접수다. 404를 근거로 단정하지 않으므로 상태는 「모름」이다.
  await page.route("**/api/v1/submissions/by-request/*", async (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        code: "NOT_FOUND",
        message: "없습니다.",
        fieldErrors: [],
      }),
    }),
  );
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    posts.push(JSON.parse(request.postData() ?? "{}"));
    // 자동 복구가 쓰는 전송 두 번을 모두 잃는다. 사다리를 소진시켜야
    // 수동 경로가 드러난다. 그 뒤의 전송은 개발 서버가 받는다.
    if (posts.length <= 2)
      return route.continue({
        headers: { ...request.headers(), "x-fixture-submit": "drop-unsaved" },
      });
    return route.continue();
  });

  await page.goto(`/analysis/${NORMAL}`);
  await reachReview(page);
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const dialog = page.getByTestId("submission-result");
  await expect(dialog).toContainText("접수 여부를 확인해 주세요");
  const resend = dialog.getByRole("button", {
    name: "같은 내용으로 다시 보내기",
    exact: true,
  });
  // 조회로 미접수를 확인하기 전에는 내놓지 않는다.
  await expect(resend).toBeHidden();

  await dialog
    .getByRole("button", { name: "접수 결과 확인", exact: true })
    .click();
  await expect(dialog).toContainText("아직 접수 기록을 찾지 못했습니다");
  await expect(resend).toBeVisible();

  const before = posts.length;
  await resend.click();
  await expect(dialog).toContainText("접수되었습니다");

  // 같은 ID·같은 본문이어야 서버가 중복을 만들지 않는다.
  expect(posts).toHaveLength(before + 1);
  const [first, again] = [posts[0], posts[posts.length - 1]];
  expect(again.requestId).toBe(first.requestId);
  expect(again).toEqual(first);
});

test("a changed bundle reloads the data instead of resending the old snapshot", async ({
  page,
}) => {
  const posts: Record<string, unknown>[] = [];
  let contexts = 0;
  await page.route("**/api/v1/stars/*/analysis-context*", async (route) => {
    contexts += 1;
    return route.continue();
  });
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    posts.push(JSON.parse(request.postData() ?? "{}"));
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "BUNDLE_CHANGED",
        message: "판이 바뀌었습니다.",
        fieldErrors: [],
        currentBundleId: "9007199254741099",
      }),
    });
  });

  await page.goto(`/analysis/${NORMAL}`);
  await reachReview(page);
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const dialog = page.getByTestId("submission-result");
  await expect(dialog).toContainText("별의 데이터 판이 바뀌었습니다");
  const before = contexts;

  // 낡은 스냅샷을 그대로 다시 보낼 수 없어야 한다. 제출은 잠겨 있다.
  await expect(
    page.getByRole("button", { name: "제출하기", exact: true }),
  ).toBeDisabled();

  // 안내로 끝내지 않고 실제 재조회로 잇는다.
  await dialog
    .getByRole("button", { name: "최신 자료 불러오기", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => contexts).toBeGreaterThan(before);
  // 다시 부른 것은 조회뿐이다. 제출은 한 번으로 남는다.
  expect(posts).toHaveLength(1);
});
