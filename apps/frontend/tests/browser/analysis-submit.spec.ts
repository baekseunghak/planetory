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
