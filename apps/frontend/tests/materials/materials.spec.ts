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
  await expect(
    page.getByRole("img", { name: /현재 판으로 다시 접은 곡선.*관측점 3개/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "제출 당시", exact: true }).click();
  await expect(
    page.getByRole("img", { name: /제출 당시 접힌 곡선.*관측점 150개/ }),
  ).toBeVisible();
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

for (const [reason, message] of [
  [
    "RETIRED_CANDIDATE",
    "당시 조합에 은퇴한 후보가 있어 원본 곡선으로 대체했습니다.",
  ],
  [
    "RESIDUAL_NOT_AVAILABLE",
    "현재 사용할 수 있는 잔차 자료가 없어 현재 원본 곡선으로 표시합니다.",
  ],
]) {
  test(`public fallback explains ${reason} without replacing the submitted snapshot`, async ({
    page,
  }) => {
    const id = await seed(page);
    let attachmentReads = 0;
    const privateRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/histories\/|residual-jobs/.test(request.url()))
        privateRequests.push(request.url());
    });
    await page.route("**/history-attachments/**", async (route) => {
      attachmentReads++;
      const response = await route.fetch();
      const dto = await response.json();
      const graph = dto.graph;
      // 공개 SUBMITTED의 미완료 캐시는 당시 배열에 영향을 주지 않는다.
      const fallbackReason =
        graph.curve || reason === "RETIRED_CANDIDATE" ? reason : null;
      await route.fulfill({
        response,
        json: {
          ...dto,
          graph: {
            ...graph,
            reproduction: {
              ...graph.reproduction,
              residualReproducible: fallbackReason === null,
              fallbackReason,
            },
            curve: graph.curve && {
              ...graph.curve,
              residual: { status: "COMPLETED", jobId: null },
            },
          },
        },
      });
    });
    await page.clock.install();
    await page.goto("/posts/" + id);
    await page.getByRole("button", { name: "분석 기록 h-501 열기" }).click();
    const card = page.getByRole("region", { name: "첨부 기록 h-501" });
    await expect(card.getByText(message, { exact: true })).toBeVisible();
    await expect(
      card.getByRole("img", { name: /현재 판으로 다시 접은 곡선/ }),
    ).toBeVisible();
    await expect(card).not.toContainText(
      /RETIRED_CANDIDATE|RESIDUAL_NOT_AVAILABLE|작업이 진행 중/,
    );
    // StrictMode의 초기 재마운트·중단 요청과 주기적 재조회를 구분한다.
    const initialReads = attachmentReads;
    await page.clock.fastForward(35_000);
    expect(attachmentReads).toBe(initialReads);
    await card.getByRole("button", { name: "제출 당시", exact: true }).click();
    await expect(
      card.getByRole("img", { name: /제출 당시 접힌 곡선.*관측점 150개/ }),
    ).toBeVisible();
    await expect(card.getByText(message, { exact: true })).toHaveCount(0);
    await expect(card).not.toContainText(
      /원본 곡선으로|현재 원본 자료|RETIRED_CANDIDATE|RESIDUAL_NOT_AVAILABLE/,
    );
    if (reason === "RETIRED_CANDIDATE")
      await expect(
        card.getByText(
          "현재 데이터에서는 당시 잔차 조합을 재현할 수 없습니다. 아래 배열은 당시 그대로입니다.",
          { exact: true },
        ),
      ).toBeVisible();
    expect(attachmentReads).toBe(initialReads + 1);
    expect(privateRequests).toEqual([]);
  });
}

test("retired candidate with no snapshot does not claim a saved array is shown", async ({
  page,
}) => {
  const id = await seed(page, ["h-502"]);
  await page.route("**/history-attachments/**", async (route) => {
    const response = await route.fetch();
    const dto = await response.json();
    await route.fulfill({
      response,
      json: {
        ...dto,
        graph: {
          ...dto.graph,
          reproduction: {
            ...dto.graph.reproduction,
            residualReproducible: false,
            fallbackReason: "RETIRED_CANDIDATE",
          },
        },
      },
    });
  });
  await page.goto("/posts/" + id);
  await page.getByRole("button", { name: "분석 기록 h-502 열기" }).click();
  const card = page.getByRole("region", { name: "첨부 기록 h-502" });
  await expect(
    card.getByText("213 합성 첨부 메모", { exact: true }),
  ).toBeVisible();
  await card.getByRole("button", { name: "제출 당시", exact: true }).click();
  await expect(card.getByText(/제출 당시 스냅샷이 없습니다/)).toBeVisible();
  await expect(
    card.getByText("현재 데이터에서는 당시 잔차 조합을 재현할 수 없습니다.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(card).not.toContainText(
    /아래 배열은|원본 곡선으로|현재 원본 자료|RETIRED_CANDIDATE/,
  );
  await expect(card.getByRole("img")).toHaveCount(0);
});

for (const status of ["QUEUED", "COMPLETED"]) {
  test(`public ${status} jobId is rejected without polling any endpoint`, async ({
    page,
  }) => {
    const id = await seed(page);
    let attachmentReads = 0;
    const privateRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/histories\/|residual-jobs/.test(request.url()))
        privateRequests.push(request.url());
    });
    await page.route("**/history-attachments/**", async (route) => {
      attachmentReads++;
      const response = await route.fetch();
      const dto = await response.json();
      await route.fulfill({
        response,
        json: {
          ...dto,
          graph: {
            ...dto.graph,
            curve: {
              ...dto.graph.curve,
              residual: { status, jobId: "private-job-must-not-be-used" },
            },
          },
        },
      });
    });
    await page.clock.install();
    await page.goto("/posts/" + id);
    await page.getByRole("button", { name: "분석 기록 h-501 열기" }).click();
    const card = page.getByRole("region", { name: "첨부 기록 h-501" });
    await expect(card.getByRole("alert")).toContainText(
      "자료 응답을 확인할 수 없습니다.",
    );
    await expect(card.getByRole("img")).toHaveCount(0);
    await expect(card).not.toContainText(
      /213 합성 첨부 메모|작업이 진행 중|private-job-must-not-be-used/,
    );
    const initialReads = attachmentReads;
    await page.clock.fastForward(35_000);
    expect(attachmentReads).toBe(initialReads);
    expect(privateRequests).toEqual([]);
    await expect(
      card.getByRole("button", { name: "작업 상태 다시 확인" }),
    ).toHaveCount(0);
  });
}

test("hidden sources have no lookup or link; post body/history edits preserve them until explicit clear", async ({
  page,
}) => {
  const id = await seed(page);
  const sourceReads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/source-cards"))
      sourceReads.push(request.url());
  });
  await page.route(`**/api/v1/posts/${id}`, async (route) => {
    const response = await route.fetch();
    const dto = await response.json();
    await route.fulfill({
      response,
      json: {
        ...dto,
        sourceLinks: [{ type: "PUBLIC_ANALYSIS", available: false }],
      },
    });
  });
  await page.goto(`/posts/${id}`);
  await expect(
    page.getByText("공개 취소되었거나 볼 수 없는 출처입니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /^출처 .* 열기$/ })).toHaveCount(
    0,
  );
  expect(sourceReads).toEqual([]);
  await page.goto(`/posts/${id}/edit`);
  await enter(
    page.getByRole("textbox", { name: "본문", exact: true }),
    "본문만 수정",
  );
  const saved = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith(`/posts/${id}`),
  );
  await page.getByRole("button", { name: "수정 저장", exact: true }).click();
  expect((await saved).postDataJSON()).toEqual({ body: "본문만 수정" });
  await page.goto(`/posts/${id}/edit`);
  await page
    .getByRole("button", { name: "공개 출처 모두 제거", exact: true })
    .click();
  const removed = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith(`/posts/${id}`),
  );
  await page.getByRole("button", { name: "수정 저장", exact: true }).click();
  expect((await removed).postDataJSON().sourceLinks).toEqual([]);
  expect(sourceReads).toEqual([]);
});

test("comment unavailable source is visible and body-only edit omits sourceLinks", async ({
  page,
}) => {
  const id = await seed(page, []);
  const created = await page.request.post("/api/v1/comments", {
    headers,
    data: { parentType: "POST", parentId: id, body: "출처 댓글" },
  });
  expect(created.status()).toBe(201);
  const commentId = (await created.json()).commentId;
  let reads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/source-cards")) reads++;
  });
  await page.route("**/api/v1/comments?**", async (route) => {
    const response = await route.fetch();
    const dto = await response.json();
    await route.fulfill({
      response,
      json: {
        ...dto,
        items: dto.items.map((item: { commentId: string }) =>
          item.commentId === commentId
            ? {
                ...item,
                sourceLinks: [{ type: "SIGNAL_THREAD", available: false }],
              }
            : item,
        ),
      },
    });
  });
  await page.goto(`/posts/${id}`);
  await expect(
    page.getByText("공개 취소되었거나 볼 수 없는 출처입니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "댓글 수정", exact: true }).click();
  await enter(
    page.getByRole("textbox", { name: "댓글 본문" }),
    "본문만 바꾼 댓글",
  );
  const saved = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith(`/comments/${commentId}`),
  );
  await page.getByRole("button", { name: "댓글 저장", exact: true }).click();
  expect((await saved).postDataJSON()).toEqual({ body: "본문만 바꾼 댓글" });
  expect(reads).toBe(0);
});
