import { test, expect, type Page, type Locator } from "@playwright/test";

const headers = { "X-CSRF-TOKEN": "community-fixture-209" };
declare global {
  interface Window {
    postWriteRequests: { method: string; body: unknown }[];
    postLostResponse?: { method: string; path: string };
  }
}
test.beforeEach(async ({ page }) => {
  // BiDi request.postDataJSON() does not expose a body. Observe the real fetch
  // boundary, without replacing the HTTP request or backend response.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.postWriteRequests = [];
    window.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      if (["POST", "PATCH"].includes(method))
        window.postWriteRequests.push({
          method,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
      const response = await original(input, init);
      if (
        window.postLostResponse?.method === method &&
        String(input) === window.postLostResponse.path
      ) {
        await response.clone().text();
        throw new TypeError(
          "Test-only response loss after the real HTTP request completed",
        );
      }
      return response;
    };
  });
});
async function enter(input: Locator, value: string) {
  await input.fill(value);
  if (test.info().project.name === "firefox") {
    // Playwright 1.63's BiDi fill assigns element.value, updating React's
    // value tracker without a native edit. Finish with native key events.
    // This is a test-driver workaround, not a production event-handler change.
    await input.press("End");
    await input.press("Space");
    await input.press("Backspace");
  }
}
async function seed(page: Page) {
  const response = await page.request.post("/api/v1/posts", {
    headers,
    data: {
      title: `검증 글 ${Date.now()}`,
      body: "서버의 본문",
      purposeTag: "GENERAL",
      ticId: null,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).postId as string;
}
async function fill(page: Page, title = "새 관측 이야기") {
  await enter(page.getByRole("textbox", { name: "제목", exact: true }), title);
  await enter(
    page.getByRole("textbox", { name: "본문", exact: true }),
    "<b>태그도 텍스트 그대로</b>\n관측 결과입니다.",
  );
}
test("only final publish writes, duplicate clicks are locked, CSRF and return context work", async ({
  page,
}) => {
  const title = `새 관측 이야기 ${Date.now()}`;
  const writes: { method: string; body: unknown; csrf: string | undefined }[] =
    [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/posts") && request.method() === "POST")
      writes.push({
        method: request.method(),
        body: request.postDataJSON(),
        csrf: request.headers()["x-csrf-token"],
      });
  });
  await page.goto("/community/stars/259377017");
  await page.getByRole("link", { name: "새 글 쓰기" }).click();
  await expect(page.getByLabel("별의 TIC 번호")).toHaveValue("259377017");
  await fill(page, title);
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "게시하기", exact: true }).dblclick();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].csrf).toBe("community-fixture-209");
  expect(
    await page.evaluate(
      () => window.postWriteRequests.find((r) => r.method === "POST")?.body,
    ),
  ).toEqual({
    title,
    body: "<b>태그도 텍스트 그대로</b>\n관측 결과입니다.",
    purposeTag: "GENERAL",
    ticId: "259377017",
  });
  await expect(page.locator(".community-post-body b")).toHaveCount(0);
  await page.getByRole("link", { name: "이전 화면" }).click();
  await expect(page).toHaveURL(/\/community\/stars\/259377017$/);
  await expect(
    page.getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
});
test("Unicode limits, blank validation and server fieldErrors retain input", async ({
  page,
}) => {
  let count = 0;
  await page.route("**/api/v1/posts", (route) => {
    count++;
    return route.fulfill({
      status: 400,
      json: {
        code: "VALIDATION_FAILED",
        message: "입력을 확인해 주세요",
        fieldErrors: [
          { field: "title", reason: "서버에서 제목 확인이 필요합니다" },
        ],
      },
    });
  });
  await page.goto("/posts/new");
  await fill(page, "🪐".repeat(101));
  await page.getByRole("button", { name: "게시하기" }).click();
  await expect(page.locator("#post-title")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(count).toBe(0);
  await enter(page.locator("#post-title"), "🪐".repeat(100));
  await enter(page.locator("#post-body"), "🪐".repeat(10001));
  await page.getByRole("button", { name: "게시하기" }).click();
  expect(count).toBe(0);
  await enter(page.locator("#post-body"), " \n ");
  await page.getByRole("button", { name: "게시하기" }).click();
  expect(count).toBe(0);
  await enter(page.locator("#post-body"), "🪐".repeat(10000));
  await page.getByRole("button", { name: "게시하기" }).click();
  await expect(page.locator("#post-title-help")).toContainText("서버에서 제목");
  expect(count).toBe(1);
  await expect(page.locator("#post-body")).toHaveValue("🪐".repeat(10000));
});
test("lost POST response preserves draft, GETs own list and never auto-replays", async ({
  page,
}) => {
  const title = `응답 유실 게시글 ${Date.now()}`;
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/posts"))
      writes++;
  });
  await page.goto("/posts/new");
  await page.evaluate(() => {
    window.postLostResponse = { method: "POST", path: "/api/v1/posts" };
  });
  await fill(page, title);
  await page.getByRole("button", { name: "게시하기" }).click();
  await expect(
    page.getByRole("heading", { name: "저장 여부를 먼저 확인해 주세요" }),
  ).toBeVisible();
  await expect(page.locator("#post-title")).toHaveValue(title);
  await expect(page.getByRole("button", { name: "게시하기" })).toBeDisabled();
  await page.getByRole("button", { name: "목록에서 게시 여부 확인" }).click();
  await expect(
    page
      .getByRole("region", { name: "게시 여부 확인 목록" })
      .getByRole("link", { name: `${title} (새 탭)` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "목록 새로고침" }).click();
  expect(writes).toBe(1);
  await expect(
    page.getByRole("button", { name: "입력을 이어서 편집" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "입력을 이어서 편집" }).click();
  await expect(page.locator("#post-title")).toBeEnabled();
  expect(writes).toBe(1);
});
test("PATCH sends changed fields only; focus does not erase input or concurrent unrelated edits", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto(`/posts/${id}/edit?returnTo=%2Fcommunity%3Fboard%3DFREE`);
  await expect(page.locator("#post-title")).toBeVisible();
  await enter(page.locator("#post-title"), "내가 수정한 제목");
  await page.request.patch(`/api/v1/posts/${id}`, {
    headers,
    data: { body: "다른 창에서 수정한 본문" },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#post-title")).toBeEnabled();
  await expect(page.locator("#post-title")).toHaveValue("내가 수정한 제목");
  await page.getByRole("button", { name: "수정 저장" }).click();
  await expect(
    page.getByRole("heading", { name: "내가 수정한 제목", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.postWriteRequests.find((r) => r.method === "PATCH")?.body,
    ),
  ).toEqual({ title: "내가 수정한 제목" });
  await expect(page.locator(".community-post-body")).toHaveText(
    "다른 창에서 수정한 본문",
  );
});
for (const committed of [true, false])
  test(`lost PATCH reconciles GET with committed=${committed}, no resend`, async ({
    page,
  }) => {
    const id = await seed(page);
    let writes = 0;
    page.on("request", (request) => {
      if (request.method() === "PATCH") writes++;
    });
    if (!committed)
      await page.route(`**/api/v1/posts/${id}`, (route) =>
        route.request().method() === "PATCH"
          ? route.abort("failed")
          : route.continue(),
      );
    await page.goto(`/posts/${id}/edit`);
    if (committed)
      await page.evaluate((postId) => {
        window.postLostResponse = {
          method: "PATCH",
          path: `/api/v1/posts/${postId}`,
        };
      }, id);
    await expect(page.locator("#post-title")).toBeVisible();
    await enter(page.locator("#post-title"), "수정 응답 유실");
    await page.getByRole("button", { name: "수정 저장" }).click();
    await page.getByRole("button", { name: "저장 여부 다시 확인" }).click();
    await expect(page.getByRole("status")).toContainText(
      committed ? "요청한 변경이 반영" : "내 요청과 다릅니다",
    );
    await expect(page.locator("#post-title")).toHaveValue("수정 응답 유실");
    expect(writes).toBe(1);
    await page.getByRole("button", { name: "서버 내용 사용" }).click();
    await expect(page.locator("#post-title")).toBeEnabled();
    expect(writes).toBe(1);
  });
test("owner-only controls and direct edit permission; hidden/missing response clears old content", async ({
  page,
}) => {
  const id = await seed(page);
  await page.route(`**/api/v1/posts/${id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.author.memberId = "u-other";
    await route.fulfill({ json: body });
  });
  await page.goto(`/posts/${id}`);
  await expect(page.locator(".community-post-body")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "글 수정", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "글 삭제" })).toHaveCount(0);
  await page.goto(`/posts/${id}/edit`);
  await expect(
    page.getByRole("heading", { name: "접근 권한이 없습니다" }),
  ).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(0);
  await page.unroute(`**/api/v1/posts/${id}`);
  await page.goto(`/posts/${id}/edit`);
  await expect(page.locator("#post-body")).toBeVisible();
  await page.route(`**/api/v1/posts/${id}`, (route) =>
    route.fulfill({
      status: 404,
      json: { code: "RESOURCE_NOT_FOUND", message: "볼 수 없습니다" },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("heading", { name: "자료를 찾을 수 없거나 볼 수 없습니다" }),
  ).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(0);
});
test("delete confirmation cancel does not write; confirmed delete refreshes feed; server repeat returns 204", async ({
  page,
}) => {
  const id = await seed(page);
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "DELETE") writes++;
  });
  await page.goto(`/posts/${id}?returnTo=%2Fcommunity%3Fboard%3DFREE`);
  await page.getByRole("button", { name: "글 삭제" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "돌아가기", exact: true }).click();
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "글 삭제" }).click();
  await page.getByRole("button", { name: "삭제하기", exact: true }).click();
  await expect(page).toHaveURL(/\/community\?board=FREE$/);
  expect(writes).toBe(1);
  expect(
    (await page.request.delete(`/api/v1/posts/${id}`, { headers })).status(),
  ).toBe(204);
  await page.goto(`/posts/${id}`);
  await expect(
    page.getByRole("heading", { name: "자료를 찾을 수 없거나 볼 수 없습니다" }),
  ).toBeVisible();
});
test("lost DELETE can be checked; missing GET hides content without falsely claiming deletion", async ({
  page,
}) => {
  const id = await seed(page);
  let writes = 0;
  await page.route(`**/api/v1/posts/${id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    writes++;
    await route.fetch();
    await route.abort("failed");
  });
  await page.goto(`/posts/${id}`);
  await page.getByRole("button", { name: "글 삭제" }).click();
  await page.getByRole("button", { name: "삭제하기", exact: true }).click();
  await page
    .getByRole("button", { name: "삭제 결과 확인", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "자료를 찾을 수 없거나 볼 수 없습니다" }),
  ).toBeVisible();
  await expect(page.locator(".community-post-body")).toHaveCount(0);
  expect(writes).toBe(1);
});
test("expired session clears private editor; invalid 2xx DTO cannot trigger retry", async ({
  page,
}) => {
  await page.route("**/api/v1/posts", (route) =>
    route.fulfill({ status: 201, json: {} }),
  );
  await page.goto("/posts/new");
  await fill(page);
  await page.getByRole("button", { name: "게시하기" }).click();
  await expect(
    page.getByRole("heading", { name: "저장 여부를 먼저 확인해 주세요" }),
  ).toBeVisible();
  await page.route("**/api/v1/community/feed?*", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "UNAUTHENTICATED", message: "다시 로그인해 주세요" },
    }),
  );
  await page.getByRole("button", { name: "목록에서 게시 여부 확인" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("#post-body")).toHaveCount(0);
});

test("DELETE uncertainty survives focus and requires a fresh GET before manual repeat", async ({
  page,
}) => {
  const id = await seed(page);
  let writes = 0;
  await page.route(`**/api/v1/posts/${id}`, (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    writes++;
    return writes === 1 ? route.abort("failed") : route.continue();
  });
  await page.goto(`/posts/${id}`);
  await page.getByRole("button", { name: "글 삭제" }).click();
  await page.getByRole("button", { name: "삭제하기", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "삭제 결과 확인", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("button", { name: "다시 삭제", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "삭제 결과 확인", exact: true })
    .click();
  await expect(
    page.locator(".community-detail-main").getByRole("status"),
  ).toContainText("현재 글이 조회됩니다");
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "다시 삭제", exact: true }).click();
  await expect(page).toHaveURL(/\/community\?board=FREE$/);
  expect(writes).toBe(2);
});
test("delete-before-PATCH clears editor; neither rejection nor cancel recreates the post", async ({
  page,
}) => {
  const id = await seed(page);
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" || r.method() === "PATCH") writes++;
  });
  await page.goto(`/posts/${id}/edit`);
  await expect(page.locator("#post-title")).toBeVisible();
  await enter(page.locator("#post-title"), "삭제되기 전 입력");
  await page.request.delete(`/api/v1/posts/${id}`, { headers });
  await page.getByRole("button", { name: "수정 저장" }).click();
  await expect(
    page.getByRole("heading", { name: "자료를 찾을 수 없거나 볼 수 없습니다" }),
  ).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(0);
  expect(writes).toBe(1);
  await page.goto("/posts/new?returnTo=%2Fcommunity");
  await fill(page);
  await expect(
    page.getByRole("button", { name: /첨부|분석 기록 선택/ }),
  ).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page).toHaveURL(/\/community$/);
  expect(writes).toBe(1);
});
test("pending POST disables all mutations and POST failure before dispatch is safe to edit", async ({
  page,
}) => {
  let writes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/posts", async (route) => {
    writes++;
    await gate;
    await route.continue();
  });
  await page.goto("/posts/new");
  await fill(page, "중복 방지 확인");
  await page.getByRole("button", { name: "게시하기" }).click();
  await expect(
    page.getByRole("button", { name: "저장 결과 확인 중…", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#post-title")).toBeDisabled();
  await page.locator("form").evaluate((form) => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(writes).toBe(1);
  release();
  await expect(
    page.getByRole("heading", { name: "중복 방지 확인", exact: true }),
  ).toBeVisible();
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "인증 확인 지연" },
    }),
  );
  await page.goto("/posts/new");
  await fill(page);
  await page.getByRole("button", { name: "게시하기" }).click();
  await expect(page.getByRole("alert")).toContainText("인증 확인 지연");
  await expect(page.locator("#post-title")).toBeEnabled();
  expect(writes).toBe(1);
  await expect(
    page.getByRole("heading", { name: "저장 여부를 먼저 확인해 주세요" }),
  ).toHaveCount(0);
});

test("delete return respects post ID boundaries and rejects the deleted post or its edit route", async ({
  page,
}) => {
  for (const kind of ["sibling", "self", "edit"] as const) {
    const id = await seed(page);
    const target =
      kind === "sibling"
        ? "/posts/" + id + "0"
        : "/posts/" + id + (kind === "edit" ? "/edit" : "?from=detail");
    await page.goto("/posts/" + id + "?returnTo=" + encodeURIComponent(target));
    await page.getByRole("button", { name: "글 삭제", exact: true }).click();
    await page.getByRole("button", { name: "삭제하기", exact: true }).click();
    const expected = kind === "sibling" ? target : "/community?board=FREE";
    await expect
      .poll(() => new URL(page.url()).pathname + new URL(page.url()).search)
      .toBe(expected);
  }
});
