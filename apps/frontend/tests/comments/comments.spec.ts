import { test, expect, type Page, type Locator } from "@playwright/test";
const headers = { "X-CSRF-TOKEN": "community-fixture-209" };
declare global {
  interface Window {
    commentLoss?: string;
    commentCalls: string[];
  }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.commentCalls = [];
    window.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      if (String(input).startsWith("/api/v1/comments") && method !== "GET")
        window.commentCalls.push(method);
      const response = await original(input, init);
      if (
        window.commentLoss === method &&
        String(input).startsWith("/api/v1/comments")
      ) {
        await response.clone().text();
        throw new TypeError("Test response lost after HTTP");
      }
      return response;
    };
  });
});
async function enter(input: Locator, value: string) {
  await input.fill(value);
  if (test.info().project.name === "firefox") {
    await input.press("End");
    await input.press("Space");
    await input.press("Backspace");
  }
}
async function seed(page: Page) {
  const r = await page.request.post("/api/v1/posts", {
    headers,
    data: {
      title: "댓글 검사 " + Date.now(),
      body: "부모 본문",
      purposeTag: "GENERAL",
      ticId: null,
    },
  });
  return (await r.json()).postId as string;
}
async function write(page: Page, body: string) {
  await enter(page.getByLabel("댓글 본문", { exact: true }), body);
  await page.getByRole("button", { name: "댓글 등록", exact: true }).click();
}
test("post comment CRUD, owner controls, safe plain text, no nested replies and server count", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await write(page, "<b>새 댓글</b>");
  await expect(page.locator(".community-comments")).toContainText(
    "<b>새 댓글</b>",
  );
  await expect(page.locator(".community-comments b")).toHaveCount(0);
  await page.getByRole("button", { name: "댓글 수정", exact: true }).click();
  await enter(page.getByLabel("댓글 본문", { exact: true }), "수정한 댓글");
  await page.getByRole("button", { name: "댓글 저장", exact: true }).click();
  await expect(page.locator(".community-comments")).toContainText(
    "수정한 댓글",
  );
  await page.getByRole("button", { name: "댓글 삭제", exact: true }).click();
  expect(
    await page.evaluate(
      () => window.commentCalls.filter((x) => x === "DELETE").length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "댓글 삭제 확정" }).click();
  await expect(page.locator(".community-comments li")).toHaveCount(0);
  await expect(page.getByText("아직 토론이 없습니다.")).toBeVisible();
  expect(
    (await (await page.request.get("/api/v1/posts/" + id)).json()).commentCount,
  ).toBe(0);
});
test("official thread accepts one level comment without publishing analysis or reaction", async ({
  page,
}) => {
  await page.goto("/signal-threads/st-302");
  const body = "스레드 댓글 " + Date.now();
  await write(page, body);
  await expect(page.locator(".community-comments")).toContainText(body);
  await expect(page.getByRole("heading", { name: "참여자 0명" })).toBeVisible();
  expect(await page.evaluate(() => window.commentCalls)).toEqual(["POST"]);
});
test("limits 1/2000/2001, blanks and field errors preserve input", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await write(page, " \n ");
  await expect(page.getByRole("alert")).toContainText("1~2,000");
  await write(page, "🪐".repeat(2001));
  expect(await page.evaluate(() => window.commentCalls)).toEqual([]);
  await write(page, "🪐".repeat(2000));
  await expect(page.locator(".community-comments li")).toHaveCount(1);
  await write(page, "1");
  await expect(page.locator(".community-comments li")).toHaveCount(2);
  await page.route("**/api/v1/comments", (route) =>
    route.fulfill({
      status: 400,
      json: {
        code: "VALIDATION_FAILED",
        message: "확인",
        fieldErrors: [{ field: "body", reason: "서버 본문 오류" }],
      },
    }),
  );
  await write(page, "보존할 입력");
  await expect(page.getByRole("alert")).toContainText("서버 본문 오류");
  await expect(page.getByLabel("댓글 본문", { exact: true })).toHaveValue(
    "보존할 입력",
  );
});
test("POST response loss preserves draft through focus, does not replay, requires explicit duplicate acknowledgement", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await page.evaluate(() => (window.commentLoss = "POST"));
  await write(page, "유실된 등록");
  await expect(
    page.getByRole("button", { name: "최신 댓글 확인" }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("댓글 본문", { exact: true })).toHaveValue(
    "유실된 등록",
  );
  await expect(page.getByLabel("댓글 본문", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "최신 댓글 확인" }).click();
  await expect(
    page.getByRole("region", { name: "댓글 저장 여부 확인" }),
  ).toHaveCount(0);
  await expect(page.locator(".post-recovery")).toContainText("유실된 등록");
  await expect(
    page.getByRole("button", { name: "입력 유지하고 다시 편집" }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.commentCalls)).toEqual(["POST"]);
  await page.getByRole("button", { name: "확인하고 편집 종료" }).click();
  await expect(page.locator(".community-comments li")).toHaveCount(1);
});
test("PATCH loss compares stored body and DELETE loss never falsely asserts absence means success", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await write(page, "원문");
  await page.getByRole("button", { name: "댓글 수정", exact: true }).click();
  await enter(page.getByLabel("댓글 본문", { exact: true }), "저장된 수정");
  await page.evaluate(() => (window.commentLoss = "PATCH"));
  await page.getByRole("button", { name: "댓글 저장", exact: true }).click();
  await page.getByRole("button", { name: "최신 댓글 확인" }).click();
  await expect(page.getByRole("status")).toContainText("보낸 내용과 같습니다");
  await page.getByRole("button", { name: "확인하고 편집 종료" }).click();
  await page.evaluate(() => (window.commentLoss = "DELETE"));
  await page.getByRole("button", { name: "댓글 삭제", exact: true }).click();
  await page.getByRole("button", { name: "댓글 삭제 확정" }).click();
  await page.getByRole("button", { name: "최신 댓글 확인" }).click();
  await expect(page.locator(".post-recovery")).toContainText(
    "삭제 성공이나 저장 실패로 단정할 수 없습니다",
  );
  expect(
    await page.evaluate(() =>
      window.commentCalls.filter((x) => x === "DELETE"),
    ),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "확인하고 편집 종료" }).click();
  await expect(page.locator(".community-comments li")).toHaveCount(0);
});
test("other member controls hidden, parent hidden removes all child UI, 401 removes draft", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await write(page, "권한 확인");
  await page.route("**/api/v1/comments?*", async (route) => {
    const r = await route.fetch();
    const data = await r.json();
    data.items.forEach(
      (x: { author: unknown }) =>
        (x.author = { memberId: "u-other", nickname: "다른 회원" }),
    );
    await route.fulfill({ json: data });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".community-comments")).toContainText("다른 회원");
  await expect(
    page.getByRole("button", { name: "댓글 수정", exact: true }),
  ).toHaveCount(0);
  await enter(page.getByLabel("댓글 본문", { exact: true }), "비공개 초안");
  await page.route("**/api/v1/posts/" + id, (route) =>
    route.fulfill({
      status: 404,
      json: { code: "RESOURCE_NOT_FOUND", message: "부모 숨김" },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".community-comments,.comment-editor")).toHaveCount(
    0,
  );
  await page.unroute("**/api/v1/posts/" + id);
  await page.reload();
  await enter(page.getByLabel("댓글 본문", { exact: true }), "다시 초안");
  await page.route("**/api/v1/comments", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "AUTH_REQUIRED", message: "로그인 필요" },
    }),
  );
  await page.getByRole("button", { name: "댓글 등록", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다" }),
  ).toBeVisible();
  await expect(page.getByText("다시 초안", { exact: true })).toHaveCount(0);
});
test("duplicate in-flight submit is locked and keyboard creation works", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await page
    .getByLabel("댓글 본문", { exact: true })
    .pressSequentially("native keyboard comment");
  await page.getByRole("button", { name: "댓글 등록", exact: true }).dblclick();
  await expect(page.locator(".community-comments li")).toHaveCount(1);
  expect(await page.evaluate(() => window.commentCalls)).toEqual(["POST"]);
});
