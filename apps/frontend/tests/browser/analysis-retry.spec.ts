import { expect, test, type Page } from "@playwright/test";
import { beginRange, selectPeak, showJudgment, openMemo } from "../analysis-ui";

const tic = "259377024";
const base = `/analysis/${tic}?returnTo=%2Fsky`;
const retryUrl = (id: string) =>
  `${base}&retryOfSubmissionId=${encodeURIComponent(id)}`;
const memo = (page: Page) => page.getByLabel("메모 (선택)", { exact: true });
async function source(page: Page) {
  await page.goto(base);
  await selectPeak(page);
  await beginRange(page);
  await showJudgment(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await memo(page).fill("원본 메모");
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/stars/${tic}/submissions`) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  const result = await (await response).json();
  await expect(page.getByTestId("submission-result")).toBeVisible();
  return result;
}
async function submitRetry(page: Page) {
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/stars/${tic}/submissions`) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  const received = await response;
  expect(received.status()).toBe(201);
  await expect(page.getByTestId("submission-result")).toBeVisible();
  return received.request().postDataJSON();
}

test("intentional retries restore selection, clear answers, and allocate distinct request IDs", async ({
  page,
}) => {
  const original = await source(page);
  const ids = [original.requestId];
  for (let i = 0; i < 2; i++) {
    await page.goto(retryUrl(original.submissionId));
    await expect(page.locator('[aria-current="step"]')).toContainText("판단");
    await expect(page.getByTestId("selected-period")).toHaveAttribute(
      "data-source",
      "null",
    );
    await openMemo(page);
    await expect(memo(page)).toHaveValue("");
    await expect(
      page.getByRole("radio", { name: "모르겠음", exact: true }),
    ).not.toBeChecked();
    const input = await submitRetry(page);
    expect(input.retryOfSubmissionId).toBe(original.submissionId);
    expect(input.selection.periodDays).toBe(original.original.periodDays);
    expect(input.clientRetryAttemptId).toBeUndefined();
    expect(ids).not.toContain(input.requestId);
    ids.push(input.requestId);
  }
});

test("refresh preserves new answers and provenance, then requires range confirmation", async ({
  page,
}) => {
  const original = await source(page);
  await page.goto(retryUrl(original.submissionId));
  await expect(page.locator('[aria-current="step"]')).toContainText("판단");
  await openMemo(page);
  await memo(page).fill("재도전 중 메모");
  await page.reload();
  await page.getByRole("button", { name: "기존 초안 이어가기" }).click();
  await expect(memo(page)).toHaveValue("재도전 중 메모");
  await expect(page.locator('[aria-current="step"]')).toContainText(
    "구간 선택",
  );
  await showJudgment(page);
  const input = await submitRetry(page);
  expect(input.retryOfSubmissionId).toBe(original.submissionId);
  expect(input.memo).toBe("재도전 중 메모");
});

test("an existing normal draft is not overwritten by opening a retry", async ({
  page,
}) => {
  const original = await source(page);
  await page.goto(base);
  await selectPeak(page);
  await beginRange(page);
  await showJudgment(page);
  await memo(page).fill("기존 미제출 초안");
  await page.goto(retryUrl(original.submissionId));
  await expect(
    page.getByRole("heading", { name: "작성 중인 초안이 있습니다" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "기존 초안 이어가기" }).click();
  await expect(memo(page)).toHaveValue("기존 미제출 초안");
  await showJudgment(page);
  const input = await submitRetry(page);
  expect(input.retryOfSubmissionId).toBeNull();
});

test("selection-less retry stays at period selection and retains provenance on refresh", async ({
  page,
}) => {
  const original = await source(page);
  await page.route("**/retry-draft", async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    value.draft.periodDays =
      value.draft.phaseStart =
      value.draft.phaseEnd =
        null;
    await route.fulfill({ response, json: value });
  });
  await page.goto(retryUrl(original.submissionId));
  await expect(page.locator('[aria-current="step"]')).toContainText(
    "주기 선택",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(sessionStorage).some(
          (key) =>
            key.startsWith("planetory:analysis-draft:[") &&
            JSON.parse(sessionStorage.getItem(key)!).periodDays === null,
        ),
      ),
    )
    .toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "기존 초안 이어가기" }).click();
  await selectPeak(page);
  await beginRange(page);
  await showJudgment(page);
  expect((await submitRetry(page)).retryOfSubmissionId).toBe(
    original.submissionId,
  );
});

test("a source from another TIC is rejected before fetching its retry draft", async ({
  page,
}) => {
  let queried = 0;
  await page.route("**/api/v1/submissions/foreign", (route) =>
    route.fulfill({ json: { submissionId: "foreign", ticId: "other" } }),
  );
  await page.route("**/retry-draft", (route) => {
    queried++;
    return route.abort();
  });
  await page.goto(retryUrl("foreign"));
  await expect(page.getByRole("alert")).toContainText(
    "항성이 일치하지 않습니다",
  );
  expect(queried).toBe(0);
});

test("returning to a post rechecks access and TIC without losing the draft", async ({
  page,
}) => {
  await page.route("**/api/v1/posts/p-1", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "RESOURCE_NOT_FOUND", message: "글이 없습니다." },
    }),
  );
  await page.goto(`/analysis/${tic}?returnTo=%2Fposts%2Fp-1`);
  await selectPeak(page);
  await page.getByRole("button", { name: "← 이전 화면", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "원래 글로 돌아가지 못했습니다",
  );
  await expect(page).toHaveURL(/\/analysis\//);
  await expect(page.getByTestId("selected-period")).toHaveAttribute(
    "data-source",
    /\d+/,
  );
});

test("server-rebased wrapping phases restore at 1024px and retain the existing small-screen notice", async ({
  page,
}) => {
  const original = await source(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.route("**/retry-draft", async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    value.draft.periodDays = 4;
    value.draft.phaseStart = 0.95;
    value.draft.phaseEnd = 1.05;
    value.draft.viewState = {
      periodogramViewport: { minDays: 2, maxDays: 8 },
      foldedXZoomRatio: 32,
    };
    await route.fulfill({ response, json: value });
  });
  await page.goto(retryUrl(original.submissionId));
  await expect(page.locator('[aria-current="step"]')).toContainText("판단");
  await expect(page.getByTestId("selected-period")).toHaveAttribute(
    "data-period",
    "4",
  );
  await expect(page.getByTestId("phase-selection-value")).toHaveAttribute(
    "data-start",
    "0.95",
  );
  await expect(page.getByTestId("phase-selection-value")).toHaveAttribute(
    "data-end",
    "1.05",
  );
  await expect(page.getByTestId("selected-period")).toHaveAttribute(
    "data-source",
    "null",
  );
  await expect(page.getByTestId("fold-zoom")).toHaveText("×32");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText("Planetory는 폭 1024px 이상의 화면을 지원합니다."),
  ).toBeVisible();
});

for (const mode of ["queue-full", "unavailable"] as const)
  test(`retry residual ${mode} respects the server retry policy`, async ({
    page,
  }) => {
    const original = await source(page);
    await page.route("**/retry-draft", async (route) => {
      const response = await route.fetch(),
        value = await response.json();
      value.curveContext.curveStep = 1;
      value.curveContext.removedCandidateIds = ["9007199254740994"];
      value.residualForStep = { status: null, jobId: null };
      await route.fulfill({ response, json: value });
    });
    await page.route("**/curves?**", async (route) => {
      const response = await route.fetch(),
        value = await response.json();
      value.segments = null;
      value.curveContext.curveStep = 1;
      value.curveContext.removedCandidateIds = ["9007199254740994"];
      value.residual = { status: null, jobId: null };
      await route.fulfill({ status: 202, json: value });
    });
    await page.route("**/residual-jobs", (route) =>
      route.fulfill({
        status: mode === "queue-full" ? 429 : 503,
        json:
          mode === "queue-full"
            ? {
                code: "RESIDUAL_QUEUE_FULL",
                message: "대기열 가득 참",
                retryAfterSeconds: 2,
                activeJobId: null,
              }
            : {
                code: "DEPENDENCY_UNAVAILABLE",
                message: "계산 기반이 아직 없습니다.",
                retryable: false,
              },
      }),
    );
    await page.goto(retryUrl(original.submissionId));
    await expect(page.getByRole("alert")).toBeVisible();
    if (mode === "queue-full") {
      await expect(
        page.getByRole("button", { name: /초 후 다시 불러오기/ }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "다시 불러오기", exact: true }),
      ).toBeEnabled();
    } else {
      await expect(page.getByRole("alert")).toContainText(
        "계산 기반이 아직 없습니다",
      );
      await expect(
        page.getByRole("button", { name: "다시 불러오기", exact: true }),
      ).toHaveCount(0);
    }
  });
