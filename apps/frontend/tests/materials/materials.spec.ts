import { test, expect, type Page, type Locator } from "@playwright/test";
const headers = { "X-CSRF-TOKEN": "community-fixture-209" };

for (const [submissionKind, label] of [
  ["no_candidate", "신호 없음으로 제출"],
  ["skipped", "건너뛴 기록"],
]) {
  test(`mixed histories allow selecting null judgment (${submissionKind})`, async ({
    page,
  }) => {
    await page.route("**/api/v1/me/histories?**", async (route) => {
      const response = await route.fetch();
      const dto = await response.json();
      await route.fulfill({
        response,
        json: {
          ...dto,
          items: dto.items.map((item: { historyId: string }) =>
            item.historyId === "h-502"
              ? { ...item, submissionKind, userJudgment: null }
              : item,
          ),
        },
      });
    });
    await page.goto("/posts/new?ticId=259377017");
    await enter(
      page.getByRole("textbox", { name: "제목", exact: true }),
      "혼합 기록 첨부",
    );
    await enter(
      page.getByRole("textbox", { name: "본문", exact: true }),
      "판단 없는 기록도 선택",
    );
    await page.getByRole("button", { name: "자료 선택 열기" }).click();
    const choices = page.getByRole("region", { name: "내 기록 선택" });
    await expect(
      choices.getByRole("listitem").filter({ hasText: "h-502" }),
    ).toContainText(label);
    await expect(
      choices.getByRole("listitem").filter({ hasText: "h-501" }),
    ).toContainText("모르겠음");
    for (const id of ["h-501", "h-502"])
      await choices
        .getByRole("button", { name: id + " 첨부", exact: true })
        .click();
    await expect(
      page.getByText("자료 응답을 확인할 수 없습니다.", { exact: true }),
    ).toHaveCount(0);
    const saved = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().endsWith("/api/v1/posts"),
    );
    await page.getByRole("button", { name: "게시하기", exact: true }).click();
    expect((await saved).postDataJSON().historyIds).toEqual(["h-501", "h-502"]);
    await expect(page).toHaveURL(/\/posts\/p-\d+/);
    for (const id of ["h-501", "h-502"])
      await expect(
        page.getByRole("button", { name: "분석 기록 " + id + " 열기" }),
      ).toBeVisible();
  });
}

test("first graph 503 reloads authorized metadata; revoked metadata is removed", async ({
  page,
}) => {
  const id = await seed(page);
  let revoked = false;
  let metadataReads = 0;
  const privateReads: string[] = [];
  page.on("request", (r) => {
    if (/\/histories\/|residual-jobs/.test(r.url())) privateReads.push(r.url());
  });
  await page.route("**/history-attachments/**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("includeGraph") ===
      "false"
    ) {
      metadataReads++;
      if (revoked)
        return route.fulfill({
          status: 404,
          json: { code: "RESOURCE_NOT_FOUND", message: "공개 취소" },
        });
      const response = await route.fetch();
      return route.fulfill({
        response,
        json: { ...(await response.json()), judgment: null },
      });
    }
    return route.fulfill({
      status: 503,
      json: {
        code: "GRAPH_TEMPORARILY_UNAVAILABLE",
        message: "그래프 재조회 필요",
      },
    });
  });
  await page.goto("/posts/" + id);
  await page.getByRole("button", { name: "분석 기록 h-501 열기" }).click();
  await expect(
    page.getByText("213 합성 첨부 메모", { exact: true }),
  ).toBeVisible();
  expect(metadataReads).toBe(1);
  revoked = true;
  await page.getByRole("button", { name: "제출 당시", exact: true }).click();
  await expect(
    page.getByText("213 합성 첨부 메모", { exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => metadataReads).toBe(2);
  expect(privateReads).toEqual([]);
});

async function enter(target: Locator, value: string) {
  await target.fill(value);
  if (test.info().project.name === "firefox") {
    await target.press("End");
    await target.press("Space");
    await target.press("Backspace");
  }
}
async function seed(page: Page, ids = ["h-501"]) {
  const res = await page.request.post("/api/v1/posts", {
    headers,
    data: {
      title: "첨부 검사",
      body: "본문 유지",
      purposeTag: "DISCUSSION",
      ticId: "259377017",
      historyIds: ids,
      sourceLinks: [],
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).postId as string;
}
test("select own same-TIC histories and public sources; max3, duplicate, final submit only", async ({
  page,
}) => {
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/v1/posts")) writes++;
  });
  await page.goto("/posts/new?ticId=259377017");
  await enter(
    page.getByRole("textbox", { name: "제목", exact: true }),
    "첨부 새 글",
  );
  await enter(
    page.getByRole("textbox", { name: "본문", exact: true }),
    "자료와 함께 남기는 본문",
  );
  await page.getByRole("button", { name: "자료 선택 열기" }).click();
  for (const id of ["h-501", "h-502", "h-503"])
    await page.getByRole("button", { name: id + " 첨부", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "h-504 첨부", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "h-501 첨부", exact: true }),
  ).toBeDisabled();
  await enter(page.getByRole("textbox", { name: "출처 ID" }), "pa-601");
  await page.getByRole("button", { name: "출처 확인 후 첨부" }).click();
  await expect(
    page.getByRole("button", { name: "출처 pa-601 제거" }),
  ).toBeVisible();
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "게시하기", exact: true }).click();
  await expect(page).toHaveURL(/\/posts\/p-\d+/);
  expect(writes).toBe(1);
  for (const id of ["h-501", "h-502", "h-503"])
    await expect(
      page.getByRole("button", { name: "분석 기록 " + id + " 열기" }),
    ).toBeVisible();
});
test("TIC/board changes detach all selected materials in PATCH", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id + "/edit");
  await expect(
    page.getByRole("button", { name: "기록 h-501 제거" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "게시판", exact: true })
    .selectOption("FREE");
  await expect(
    page.getByRole("button", { name: "기록 h-501 제거" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "수정 저장", exact: true }).click();
  await expect(page).toHaveURL(new RegExp("/posts/" + id + "(?:\\?|$)"));
  const dto = await (await page.request.get("/api/v1/posts/" + id)).json();
  expect(dto.ticId).toBeNull();
  expect(dto.attachments).toEqual([]);
});
test("comments persist materials and load only parent scoped graph; missing snapshot distinct", async ({
  page,
}) => {
  const id = await seed(page, []);
  const paths: string[] = [];
  page.on("request", (r) => paths.push(new URL(r.url()).pathname));
  await page.goto("/posts/" + id);
  await enter(page.getByRole("textbox", { name: "댓글 본문" }), "첨부 댓글");
  await page.getByRole("button", { name: "자료 선택 열기" }).click();
  await page.getByRole("button", { name: "h-502 첨부", exact: true }).click();
  await page.getByRole("button", { name: "댓글 등록", exact: true }).click();
  await page.getByRole("button", { name: "분석 기록 h-502 열기" }).click();
  await expect(
    page.getByText("213 합성 첨부 메모", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "제출 당시", exact: true }).click();
  await expect(page.getByText(/제출 당시 스냅샷이 없습니다/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "제출 당시", exact: true }),
  ).toBeDisabled();
  expect(
    paths.some((p) =>
      /^\/api\/v1\/comments\/[^/]+\/history-attachments\/h-502$/.test(p),
    ),
  ).toBe(true);
  expect(
    paths.some(
      (p) => /^\/api\/v1\/histories\//.test(p) || /residual-jobs/.test(p),
    ),
  ).toBe(false);
});
test("revoked attachment and source never leave cached metadata or direct links", async ({
  page,
}) => {
  await page.goto("/posts/p-201");
  await page.getByRole("button", { name: "분석 기록 h-501 열기" }).click();
  await expect(
    page.getByText("213 합성 첨부 메모", { exact: true }),
  ).toBeVisible();
  await page.route("**/history-attachments/**", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "RESOURCE_NOT_FOUND", message: "공개 취소" },
    }),
  );
  await page.getByRole("button", { name: "제출 당시", exact: true }).click();
  await expect(
    page.getByText("213 합성 첨부 메모", { exact: true }),
  ).toHaveCount(0);
  await page.route("**/source-cards?**", (route) =>
    route.fulfill({ json: { available: false } }),
  );
  await page.reload();
  await expect(
    page.getByRole("link", { name: "출처 pa-601 열기" }),
  ).toHaveCount(0);
});
test("server rejects other owner/other TIC/4 items and public UI sends no mutations for graph reads", async ({
  page,
}) => {
  for (const historyIds of [
    ["private-history"],
    ["h-501", "h-502", "h-503", "h-504"],
    ["h-501", "h-501"],
  ])
    expect(
      (
        await page.request.post("/api/v1/posts", {
          headers,
          data: {
            title: "검사",
            body: "본문",
            purposeTag: "GENERAL",
            ticId: "259377017",
            historyIds,
          },
        })
      ).status(),
    ).toBe(400);
  const id = await seed(page);
  const writes: string[] = [];
  page.on("request", (r) => {
    if (!["GET", "HEAD"].includes(r.method())) writes.push(r.url());
  });
  await page.goto("/posts/" + id);
  await page.getByRole("button", { name: "분석 기록 h-501 열기" }).click();
  await expect(page.getByText(/공용 그래프 화면은 연결 준비 중/)).toBeVisible();
  await page.getByRole("button", { name: "제출 당시", exact: true }).click();
  await expect(page.getByText(/공용 그래프 화면은 연결 준비 중/)).toBeVisible();
  expect(writes).toEqual([]);
});

test("lost PATCH reconciles reordered server attachments without resending", async ({
  page,
}) => {
  const id = await seed(page, ["h-501", "h-502"]);
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "PATCH") writes++;
  });
  await page.addInitScript((postId) => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (
        init?.method === "PATCH" &&
        String(input) === "/api/v1/posts/" + postId
      ) {
        await response.clone().text();
        throw new TypeError("Test response loss after server commit");
      }
      return response;
    };
  }, id);
  await page.route("**/api/v1/posts/" + id, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const dto = await response.json();
    await route.fulfill({
      response,
      json: { ...dto, attachments: [...dto.attachments].reverse() },
    });
  });
  await page.goto("/posts/" + id + "/edit");
  await page
    .getByRole("button", { name: "기록 h-502 제거", exact: true })
    .click();
  await page.getByRole("button", { name: "자료 선택 열기" }).click();
  await page.getByRole("button", { name: "h-503 첨부", exact: true }).click();
  await page.getByRole("button", { name: "수정 저장", exact: true }).click();
  await page.getByRole("button", { name: "저장 여부 다시 확인" }).click();
  await expect(page.getByRole("status")).toContainText("요청한 변경이 반영");
  expect(writes).toBe(1);
});
