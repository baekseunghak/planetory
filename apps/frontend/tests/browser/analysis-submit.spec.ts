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
  await expect(receipt.getByRole("heading").first()).toHaveText(
    "접수되었습니다",
  );
  // 접수 사실과 식별자만 보여 준다. 결과 풀이는 A06-2의 몫이다.
  await expect(receipt).toContainText("접수 번호");
  await expect(receipt).toContainText("기록 번호");
  // 다음 행동은 서버가 준 목록으로 나온다. 자세한 것은 아래 전용 테스트가 본다.
  await expect(receipt.getByTestId("next-actions")).toBeVisible();

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
  await expect(panel.getByRole("heading").first()).toHaveText(
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

test("a conflicting id is looked up first and only spent when the user says so", async ({
  page,
}) => {
  const posts: Record<string, unknown>[] = [];
  let conflict = true;
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    posts.push(JSON.parse(request.postData() ?? "{}"));
    if (!conflict) return route.continue();
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "IDEMPOTENCY_CONFLICT",
        message: "다른 내용이 이미 접수되어 있습니다.",
        fieldErrors: [],
      }),
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  await reachReview(page);
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const dialog = page.getByTestId("submission-result");
  await expect(dialog).toContainText("무엇이 접수됐는지 먼저 확인해 주세요");
  // 자동으로 다시 보내지 않는다. 전송은 한 번뿐이다.
  expect(posts).toHaveLength(1);
  // 조회가 먼저다. 새 ID는 아직 만들지 않는다.
  await expect(
    dialog.getByRole("button", { name: "접수 결과 확인", exact: true }),
  ).toBeVisible();
  // 이 ID로는 접수될 수 없으므로 초안이 잠긴다.
  await expect(
    page.getByRole("button", { name: "제출하기", exact: true }),
  ).toBeDisabled();

  // 사용자가 별도 제출을 고른 순간에만 새 ID가 나간다.
  conflict = false;
  await dialog
    .getByRole("button", { name: "별도 제출로 보내기", exact: true })
    .click();
  await expect(dialog).toContainText("접수되었습니다");
  expect(posts).toHaveLength(2);
  expect(posts[1].requestId).not.toBe(posts[0].requestId);
  // 본문은 그대로다. 바꾼 것은 요청 번호뿐이다.
  const strip = (body: Record<string, unknown>) => {
    const { requestId, ...rest } = body;
    return rest;
  };
  expect(strip(posts[1])).toEqual(strip(posts[0]));
});

test("a replay from an older plate is kept, not cancelled", async ({
  page,
}) => {
  const posts: string[] = [];
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    posts.push(request.url());
    const response = await route.fetch();
    // 응답이 오는 사이 판이 바뀌었다(D-5 재전송 성공 예외).
    return route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "x-current-bundle": "9007199254749999",
      },
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  await reachReview(page);
  await page.getByRole("button", { name: "제출하기", exact: true }).click();

  const dialog = page.getByTestId("submission-result");
  // 성공은 성공이다. 취소하지 않는다.
  await expect(dialog).toContainText("접수되었습니다");
  await expect(dialog.getByTestId("stale-bundle")).toContainText(
    "접수 당시 판 기준",
  );
  // 다시 보내지도 않는다.
  expect(posts).toHaveLength(1);
});

async function submitFromPeak(page: Page, peak: string, judgment: string) {
  await selectPeak(page, Number(peak));
  await beginRange(page);
  await showJudgment(page);
  await page.getByRole("radio", { name: judgment, exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  const dialog = page.getByTestId("submission-result");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the result separates matching, scoring and achievement", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  // 확정 신호를 맞혔다. 세 축이 모두 성공이다.
  const right = await submitFromPeak(page, "1", "행성 같음");
  await expect(right).toContainText("고른 주기가 신호와 맞았습니다");
  await expect(right).toContainText("판단이 맞았습니다");
  await expect(right).toContainText("성과로 인정되었습니다");
  // 접수 안내가 오류 색이 되지 않는다. 판단 패널의 오류 색 규칙이 덮지 않는다.
  await expect(right.locator('[role="status"]').first()).toHaveCSS(
    "color",
    "rgb(238, 238, 238)",
  );

  await page.goto(`/analysis/${NORMAL}`);
  // 같은 신호를 오판했다. 매칭은 그대로 성공이고 성과만 미인정이다.
  const wrong = await submitFromPeak(page, "1", "아닌 것 같음");
  await expect(wrong).toContainText("고른 주기가 신호와 맞았습니다");
  await expect(wrong).toContainText("판단이 달랐습니다");
  await expect(wrong).toContainText("성과로 인정되지 않았습니다");
});

test("an unscored signal is not called wrong, and a harmonic keeps both periods", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "2", "행성 같음");
  // 미확정은 틀렸다고 하지 않는다.
  await expect(dialog).toContainText("채점하지 않습니다");
  await expect(dialog).not.toContainText("판단이 달랐습니다");
  // 내 입력과 신호의 값을 비교표에 나란히 둔다.
  const compare = dialog.getByTestId("result-compare");
  await expect(compare).toContainText("내가 낸 것");
  await expect(compare).toContainText("기록의 신호");
  // 두 주기가 모두 있고 배수 관계라고 적는다.
  const period = compare.locator("tr").filter({ hasText: "주기" }).first();
  await expect(period).toContainText("4.474096일");
  await expect(period).toContainText("8.948193일");
  await expect(compare).toContainText("정정 주기 = 고른 주기 × 2");
  // 공개할 수 있는 것은 미확정뿐이다.
  await expect(dialog).toContainText("공개할 수 있습니다");
});

test("an unrunnable AI says why instead of showing zero", async ({ page }) => {
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "3", "아닌 것 같음");
  await expect(dialog).toContainText("자료가 부족해 실행하지 못했습니다");
  await expect(dialog).not.toContainText("0점");
  // 외부 출처는 원천 표기 그대로 둔다.
  await expect(dialog).toContainText("TOI-9001.03 · FP");
});

test("an ambiguous match shows no signal at all", async ({ page }) => {
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const headers = {
      ...route.request().headers(),
      "x-fixture-outcome": "ambiguous",
    };
    return route.continue({ headers });
  });
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "1", "행성 같음");
  await expect(dialog).toContainText("어느 신호인지 가리지 못했습니다");
  // 신호·AI·통계·성과를 하나도 붙이지 않는다.
  await expect(dialog).not.toContainText("AI 판정");
  await expect(dialog).not.toContainText("다른 사람의 판단");
  await expect(dialog).not.toContainText("성과");
});

test("nobody having published is not drawn as zero percent", async ({
  page,
}) => {
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const headers = {
      ...route.request().headers(),
      "x-fixture-outcome": "empty-statistics",
    };
    return route.continue({ headers });
  });
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "2", "모르겠음");
  await expect(dialog).toContainText("아직 공개된 분석이 없습니다");
  await expect(dialog).not.toContainText("0%");
});

test("the answer is revealed only when the user asks for it", async ({
  page,
}) => {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (/detail-view$/.test(request.url())) calls.push(request.url());
  });
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "1", "아닌 것 같음");
  // 상세 보기는 열람 기록을 남긴다. 화면을 열었다고 대신 부르지 않는다.
  expect(calls).toHaveLength(0);
  await expect(dialog).toContainText("상세 보기");

  await dialog
    .getByRole("button", { name: "이 신호 상세 보기", exact: true })
    .click();
  await expect(dialog).toContainText("확정된 행성 신호");
  expect(calls).toHaveLength(1);
  // 매칭한 제출에는 내 판단과의 일치 여부를 준다(RES-02).
  await expect(dialog).toContainText("내 판단과 다릅니다");
});

test("an unconfirmed candidate is never explained as an answer", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "2", "모르겠음");
  await dialog
    .getByRole("button", { name: "이 신호 상세 보기", exact: true })
    .click();
  await expect(dialog).toContainText("아직 확정되지 않은 후보입니다");
  // 확정되지 않은 것을 확정처럼 말하지 않는다.
  await expect(dialog).not.toContainText("정답");
  // 채점하지 않았으므로 일치 여부도 없다.
  await expect(dialog).not.toContainText("내 판단과");
});

test("a submission with no detail target says so instead of guessing", async ({
  page,
}) => {
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.continue({
      headers: {
        ...route.request().headers(),
        "x-fixture-outcome": "ambiguous",
      },
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "1", "행성 같음");
  // 모호한 매칭에는 상세 대상이 없다. 버튼 자체를 내놓지 않는다.
  await expect(dialog).not.toContainText("상세 보기");
});

test("the next actions are the server's list and they lead somewhere real", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}?returnTo=%2Fsky`);
  const dialog = await submitFromPeak(page, "2", "행성 같음");
  const actions = dialog.getByTestId("next-actions");
  // 미확정 매칭이라 서버가 공개를 권한다. 프론트가 조건을 다시 계산하지 않는다.
  await expect(
    actions.getByRole("link", { name: "공개 내용 검토" }),
  ).toBeVisible();
  await expect(actions.getByRole("link", { name: "결과 보기" })).toBeVisible();
  // 상세 보기는 상세 절이 이미 맡았다. 여기서 또 내지 않는다.
  await expect(actions).not.toContainText("상세 보기");
  // 화면 안에서 일어나는 동작은 옮겨 갈 곳이 없다고 그대로 말한다.
  await expect(actions).toContainText("다음 곡선 단계로 · 연결 예정");
  // 6.4절: 매칭 성공에는 별지도로가 붙는다(RES-08).
  await expect(actions.getByRole("link", { name: "별지도로" })).toBeVisible();

  // 공개 화면으로 갔다가 분석 화면으로 돌아온다. 게시로 강제 이동이 아니다(AT-36).
  await actions.getByRole("link", { name: "공개 내용 검토" }).click();
  await expect(page).toHaveURL(/\/publication\/[^?]+\?returnTo=/);
  await expect(page.locator(".unconnected")).toContainText("분석 기록");
  await page.getByRole("link", { name: "이전 화면으로" }).click();
  await expect(page).toHaveURL(`/analysis/${NORMAL}?returnTo=%2Fsky`);
});

test("an action the server did not offer is not invented", async ({ page }) => {
  await page.goto(`/analysis/${NORMAL}`);
  // 확정 신호는 공개 대상이 아니다. 서버가 빼면 화면에도 없다.
  const confirmed = await submitFromPeak(page, "1", "행성 같음");
  await expect(confirmed.getByTestId("next-actions")).not.toContainText(
    "공개 내용 검토",
  );
});

test("a match the server could not settle offers only a retry", async ({
  page,
}) => {
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.continue({
      headers: {
        ...route.request().headers(),
        "x-fixture-outcome": "ambiguous",
      },
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  const ambiguous = await submitFromPeak(page, "1", "행성 같음");
  const actions = ambiguous.getByTestId("next-actions");
  // 모호한 매칭의 힌트는 다시 풀기뿐이다(AT-13). 갈 곳을 지어내지 않는다.
  await expect(actions).toContainText("다시 풀기");
  await expect(actions.getByRole("link")).toHaveCount(0);
});

test("a skipped star is not offered the map or the board", async ({ page }) => {
  await page.goto(`/analysis/${TUTORIAL}?returnTo=%2Fsky`);
  await page
    .locator(".submission-alternatives")
    .getByRole("button", { name: "이 별 건너뛰기", exact: true })
    .click();
  await page
    .getByTestId("submission-confirm")
    .getByRole("button", { name: "보내기", exact: true })
    .click();
  const actions = page
    .getByTestId("submission-result")
    .getByTestId("next-actions");
  // 6.4절: 건너뛴 별에는 GO_HOME·DISCUSS를 추가하지 않는다. 나가는 길
  // 하나만 남는다.
  await expect(actions.getByRole("link")).toHaveCount(1);
  await expect(actions).not.toContainText("별지도로");
  await actions.getByRole("link", { name: "나중에 하기" }).click();
  await expect(page).toHaveURL("/sky");
});

test("an already-found signal is shown without taking the achievement twice", async ({
  page,
}) => {
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.continue({
      headers: {
        ...route.request().headers(),
        "x-fixture-outcome": "duplicate",
      },
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "1", "행성 같음");
  // 매칭은 성공이다. 신호도 그대로 붙는다.
  await expect(dialog).toContainText("이미 찾은 신호입니다");
  await expect(dialog).toContainText("AI 판정");
  // 성과만 다시 주지 않는다. 미인정과 같은 말로 적지 않는다.
  await expect(dialog).toContainText(
    "이미 인정된 신호라 다시 인정되지 않습니다",
  );
  await expect(dialog).not.toContainText("성과로 인정되었습니다");
  // 별이 새로 열렸다고 말하지 않는다.
  await expect(dialog).not.toContainText("새로 열린 별");
});

test("a duplicate of a harmonic match keeps the correction it came with", async ({
  page,
}) => {
  // 배수로 맞힌 신호를 다시 맞힌 경우다. 서버는 상태만 duplicate로 바꾸고
  // 후보와 정정값은 그대로 보낸다(SubmissionMatching.markDuplicate).
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.continue({
      headers: {
        ...route.request().headers(),
        "x-fixture-outcome": "duplicate",
      },
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "2", "행성 같음");
  await expect(dialog).toContainText("이미 찾은 신호입니다");
  // 정정을 지우면 내가 낸 주기가 틀렸던 것처럼 보인다.
  await expect(dialog).toContainText("2배가 맞았습니다");
  const compare = dialog.getByTestId("result-compare");
  await expect(compare).toContainText("4.474096일");
  await expect(compare).toContainText("8.948193일");
  // 성과는 그래도 다시 주지 않는다.
  await expect(dialog).toContainText(
    "이미 인정된 신호라 다시 인정되지 않습니다",
  );
});

test("values the server does not have are left out, not drawn as zero", async ({
  page,
}) => {
  // 고른 것이 없는 제출에는 원본도 계산값도 안쪽이 비어 온다. 빈 칸을
  // 0으로 바꾸면 주기 0일·길이 0시간이라는 뜻이 된다(RES-04와 같은 이유).
  await page.goto(`/analysis/${NORMAL}`);
  await page
    .locator(".submission-alternatives")
    .getByRole("button", { name: "더 이상 없음", exact: true })
    .click();
  await page
    .getByTestId("submission-confirm")
    .getByRole("button", { name: "보내기", exact: true })
    .click();
  const dialog = page.getByTestId("submission-result");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("더 이상 없음으로 접수했습니다");
  await expect(dialog).not.toContainText("0일");
  await expect(dialog).not.toContainText("0시간");
  await expect(dialog).not.toContainText("0 ppm");
});

test("discussing opens a draft for this star, not the board list", async ({
  page,
}) => {
  // 미매칭에만 이 힌트가 온다(6.4절). 화면에서 직접 주기를 고르려면 주기도를
  // 끌어야 하는데 키보드 경로가 없어, 요청의 봉우리 번호만 비워 「직접 선택」과
  // 같은 모양으로 만든다. 그 뒤의 개발 응답·파서·화면은 모두 실제 경로다.
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const body = JSON.parse(request.postData() ?? "{}");
    if (body.selection) body.selection.sourcePeakGridIndex = null;
    return route.continue({ postData: JSON.stringify(body) });
  });
  await page.goto(`/analysis/${NORMAL}?returnTo=%2Fsky`);
  const dialog = await submitFromPeak(page, "1", "모르겠음");
  await expect(dialog).toContainText("맞는 신호를 찾지 못했습니다");
  const actions = dialog.getByTestId("next-actions");
  await expect(actions).not.toContainText("별지도로");
  await actions.getByRole("link", { name: "일반 토론 쓰기" }).click();
  // 같은 TIC·DISCUSSION을 들고 글쓰기로 간다. 목록으로 보내지 않는다.
  await expect(page).toHaveURL(/\/posts\/new\?/);
  await expect(page).toHaveURL(new RegExp(`ticId=${NORMAL}`));
  await expect(page).toHaveURL(/purposeTag=DISCUSSION/);
});

test("a result from an older plate marks only what needs to be fresh", async ({
  page,
}) => {
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const response = await route.fetch();
    return route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "x-current-bundle": "9007199254749999",
      },
    });
  });
  await page.goto(`/analysis/${NORMAL}?returnTo=%2Fsky`);
  const dialog = await submitFromPeak(page, "2", "행성 같음");
  await expect(dialog.getByTestId("stale-bundle")).toBeVisible();

  // 최신이 필요한 축을 **한 줄에 모아** 이름으로 말한다. 축마다 같은
  // 문장을 되풀이하면 무엇이 옛 값인지보다 경고가 많다는 인상만 남는다.
  const band = dialog.getByTestId("stale-axis");
  await expect(band).toHaveCount(1);
  for (const name of [
    "진행",
    "공개",
    "다른 사람의 판단",
    "다음에 할 수 있는 일",
  ])
    await expect(band).toContainText(name);

  // 당시 값이 정본인 축은 이름을 올리지 않는다. 145가 아직 없으니 최신
  // 상태는 모른다고 말한다.
  for (const name of ["매칭", "내 판단", "성과"])
    await expect(band).not.toContainText(name);
  await expect(band).toContainText("최신 상태는 아직 확인하지 못했습니다");
});

test("an achievement celebrates once per member, not once per 201", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  const first = await submitFromPeak(page, "1", "행성 같음");
  const achievement = first.getByTestId("achievement");
  await expect(achievement).toContainText("성과로 인정되었습니다");
  await expect(achievement).toContainText("축하합니다");

  // 같은 제출을 다시 열면 사실은 그대로, 축하만 사라진다.
  await page.reload();
  const again = await submitFromPeak(page, "1", "행성 같음");
  const repeat = again.getByTestId("achievement");
  await expect(repeat).toContainText("성과로 인정되었습니다");
  await expect(repeat).not.toContainText("축하합니다");
});

test("a replay a member has never seen still celebrates", async ({ page }) => {
  // 최초 201을 잃고 200으로 처음 복구한 경우다(2.2절). 그 사람에게는 이
  // 200이 처음 보는 결과이므로 연출이 나와야 한다.
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    return route.continue({
      headers: { ...request.headers(), "x-fixture-submit": "drop-saved" },
    });
  });
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "1", "행성 같음");
  // 복구로 확인한 결과이고 201이 아니다.
  await expect(dialog).toContainText("이미 접수돼 있던 제출을 확인했습니다");
  await expect(dialog.getByTestId("achievement")).toContainText("축하합니다");
});

test("the result says what the wireframe says it must say", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "1", "행성 같음");

  // 성과는 인정 여부만이 아니라 이 별의 누적 건수·등급까지 보여 준다.
  const achievement = dialog.getByTestId("achievement");
  await expect(achievement).toContainText("성과로 인정되었습니다");
  await expect(achievement).toContainText("이 별 성과");
  await expect(achievement).toContainText("등급");

  // AI는 구간 이름으로 읽고, 성과와 무관하다는 것을 매번 말한다.
  const ai = dialog.locator(".result-axis").filter({
    has: page.getByRole("heading", { name: "AI 판정", exact: true }),
  });
  await expect(ai).toContainText("승인 구간");
  await expect(ai).toContainText("인정에는 쓰이지 않습니다");

  // 매칭 뒤 상세는 방금 맞힌 신호가 대상이다. 미매칭 힌트와 이름이 다르다.
  await expect(
    dialog.getByRole("button", { name: "이 신호 상세 보기", exact: true }),
  ).toBeVisible();

  // 집계 시각은 공개 분포에만 붙는다. 채점형 통계에는 명세상 `asOf`가 없다.
  await page.goto(`/analysis/${NORMAL}`);
  const open = await submitFromPeak(page, "2", "모르겠음");
  await expect(
    open.locator(".result-axis").filter({
      has: page.getByRole("heading", { name: "다른 사람의 판단", exact: true }),
    }),
  ).toContainText("집계 시각");
});

test("the comparison table puts my values beside the signal's, all of bls", async ({
  page,
}) => {
  // Gold에 열이 생기면 SDE·SNR이 값으로 온다. 그때 표가 그 줄을 만드는지
  // 본다. fixture가 null만 보내는 동안에는 줄이 없어 확인되지 않는 자리다.
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.signal.bls.sde = 9.1;
    body.signal.bls.snr = 7.8;
    return route.fulfill({ response, json: body });
  });
  await page.goto(`/analysis/${NORMAL}`);
  const dialog = await submitFromPeak(page, "1", "행성 같음");
  const compare = dialog.getByTestId("result-compare");
  const row = (name: string) =>
    compare.locator("tbody tr").filter({ hasText: name }).first();
  await expect(row("SDE")).toContainText("9.1");
  await expect(row("SNR")).toContainText("7.8");
  await expect(row("깊이")).toContainText("ppm");
  // 내가 내지 않은 값은 빈 칸이 아니라 없음 표시다.
  await expect(row("SDE").locator("td").first()).toContainText("—");
  // 서버가 내 제출로 계산한 값은 내 쪽 칸에 온다.
  await expect(row("기준 시각").locator("td").first()).toContainText("BTJD");
});

test("a submission with nothing chosen draws no comparison at all", async ({
  page,
}) => {
  // 고른 것이 없으면 양쪽 모두 빈다. 빈 표를 두면 값만 없는 것처럼 보인다.
  await page.goto(`/analysis/${NORMAL}`);
  await page
    .locator(".submission-alternatives")
    .getByRole("button", { name: "더 이상 없음", exact: true })
    .click();
  await page
    .getByTestId("submission-confirm")
    .getByRole("button", { name: "보내기", exact: true })
    .click();
  const dialog = page.getByTestId("submission-result");
  await expect(dialog).toContainText("더 이상 없음으로 접수했습니다");
  await expect(dialog.getByTestId("result-compare")).toHaveCount(0);
});

test("the next actions share the closing band and drop their label", async ({
  page,
}) => {
  await page.goto(`/analysis/${NORMAL}?returnTo=%2Fsky`);
  const dialog = await submitFromPeak(page, "1", "행성 같음");
  const band = dialog.locator(".submission-dialog-actions");
  // 바닥 한 줄에 다음 행동과 닫기가 함께 있다. 이름표는 두지 않는다.
  await expect(band.getByTestId("next-actions")).toBeVisible();
  await expect(dialog).not.toContainText("다음에 할 수 있는 일");
  await expect(
    band.getByRole("button", { name: "닫기", exact: true }),
  ).toBeVisible();

  // 떠나는 링크는 왼쪽, 닫기는 오른쪽이다. 좌표로 잰다.
  const link = await band
    .getByRole("link", { name: "결과 보기", exact: true })
    .boundingBox();
  const close = await band
    .getByRole("button", { name: "닫기", exact: true })
    .boundingBox();
  expect(link).not.toBeNull();
  expect(close).not.toBeNull();
  expect(link!.x).toBeLessThan(close!.x);
});

test("the result fits without scrolling, table beside the axes", async ({
  page,
}) => {
  // 이 판을 좌우로 편 까닭이 세로 스크롤을 없애는 것이다. 지표로 잰다.
  await page.goto(`/analysis/${NORMAL}?returnTo=%2Fsky`);
  const dialog = await submitFromPeak(page, "2", "행성 같음");

  // 비교표는 왼쪽, 축은 그 오른쪽이다. 표 아래로 내려가면 다시 길어진다.
  const table = await dialog.getByTestId("result-compare").boundingBox();
  const bands = await dialog.locator(".result-bands").boundingBox();
  expect(table).not.toBeNull();
  expect(bands).not.toBeNull();
  expect(bands!.x).toBeGreaterThan(table!.x + table!.width - 1);
  // 축은 그 안에서 다시 두 칸이다.
  const axes = dialog.locator(".result-bands > .result-axis");
  const first = await axes.first().boundingBox();
  const second = await axes.nth(1).boundingBox();
  expect(second!.x).toBeGreaterThan(first!.x);

  // 지원하는 가장 넓은 곳과 가장 좁은 곳 모두에서 넘치지 않는다.
  for (const [w, h] of [
    [1440, 1080],
    [1024, 768],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    const over = await dialog.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    expect(over, `${w}x${h}에서 세로로 넘친다`).toBe(0);
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(sideways, `${w}x${h}에서 가로로 넘친다`).toBe(0);
  }
});

test("opening the answer does not make the panel grow", async ({ page }) => {
  // 상세의 수치는 비교표가 이미 들고 있는 값이다. 다시 실으면 같은 숫자가
  // 두 곳에 놓이고 판만 길어진다.
  await page.goto(`/analysis/${NORMAL}?returnTo=%2Fsky`);
  const dialog = await submitFromPeak(page, "1", "행성 같음");
  await dialog
    .getByRole("button", { name: "이 신호 상세 보기", exact: true })
    .click();
  await expect(dialog).toContainText("확정된 행성 신호");

  // 깊이는 표에 한 번만 있다.
  const body = await dialog.innerText();
  expect(body.match(/8,000 ppm/g) ?? []).toHaveLength(1);

  // 성과가 가장 많은 결과에 상세까지 연 경우다. 여기서 넘치지 않으면 된다.
  for (const [w, h] of [
    [1440, 1080],
    [1024, 768],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    const over = await dialog.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    expect(over, `${w}x${h}에서 상세를 열면 넘친다`).toBe(0);
  }
});

test("an unmatched answer fills the empty column instead of a new block", async ({
  page,
}) => {
  // 직접 고른 주기를 흉내 낸다. 봉우리를 고르면 fixture가 늘 매칭시킨다.
  await page.route("**/api/v1/stars/*/submissions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const sent = JSON.parse(route.request().postData() ?? "{}");
    if (sent.selection) sent.selection.sourcePeakGridIndex = null;
    return route.continue({ postData: JSON.stringify(sent) });
  });
  await page.goto(`/analysis/${NORMAL}?returnTo=%2Fsky`);
  const dialog = await submitFromPeak(page, "1", "모르겠음");
  await expect(dialog).toContainText("맞는 신호를 찾지 못했습니다");

  // 신호를 모르는 동안에는 내 값만 있는 한 칸이다.
  const heads = dialog.locator(".result-compare thead th");
  await expect(heads).toHaveText(["항목", "내가 낸 것"]);

  // 누르면 그 단계의 신호가 내 값 옆에 들어온다. 별도 덩어리를 만들지 않는다.
  await dialog.getByRole("button", { name: "상세 보기", exact: true }).click();
  await expect(heads).toHaveText(["항목", "내가 낸 것", "이 단계의 신호"]);
  await expect(dialog.getByTestId("result-compare")).toContainText("8,000 ppm");
});
