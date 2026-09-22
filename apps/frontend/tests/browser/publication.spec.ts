import { test, expect, type Page } from "@playwright/test";
import {
  createPublicationFixture,
  publicationDetail,
  publicationReceipt,
  PUBLICATION_TIC,
} from "../../dev/publication-fixtures";
import { historyFixtureResponse } from "../../dev/history-fixtures";
import { starResultFixture } from "../../dev/star-result-fixtures";

test("star result and History round trips refresh publication after publish and cancel", async ({ page }) => {
  const { respond, writes } = await fixture(page);
  let resultReads = 0;
  await page.route("**/api/v1/stars/259377024/result", route => {
    resultReads++;
    const body = starResultFixture();
    const detail = respond("GET", new URL("http://fixture/api/v1/histories/h-1951"))!.body as ReturnType<typeof publicationDetail>;
    body.signals[0].latestHistoryId = "h-1951";
    body.signals[0].publication.state = detail.submission.publication.state;
    body.unpublishedSignalCount = detail.submission.publication.state === "PUBLISHED" ? 0 : 1;
    return route.fulfill({ json: body });
  });
  const resultUrl = "/results/259377024?returnTo=%2Fsky";
  await page.goto(resultUrl);
  await page.getByRole("link", { name: "분석 공개 검토", exact: true }).click();
  await expect(card(page)).toContainText("통과 모양을 확인했습니다.");
  expect(writes).toHaveLength(0);
  await card(page).getByRole("button", { name: "이 기록 게시", exact: true }).click();
  await expect(card(page)).toContainText("공개 중");
  await page.getByRole("link", { name: "나중에 · 돌아가기" }).click();
  await expect(page.locator(".star-result")).toContainText("게시됨");
  expect(resultReads).toBeGreaterThan(1);
  await page.getByRole("link", { name: "최신 기록과 곡선 보기" }).click();
  await page.getByRole("link", { name: "공개 검토·설정" }).click();
  await card(page).getByRole("button", { name: "공개 취소", exact: true }).click();
  await expect(card(page)).toContainText("공개되지 않음");
  await page.getByRole("link", { name: "나중에 · 돌아가기" }).click();
  await expect(page).toHaveURL(/\/history\/h-1951/);
  await expect(page.getByText("공개할 수 있습니다.", { exact: true })).toBeVisible();
  expect(writes.map(write => write.method)).toEqual(["POST", "PUT"]);
});

test("21 failures across pages are retried in batches of 20 without resending successes", async ({
  page,
}) => {
  const ids = Array.from({ length: 21 }, (_, index) => `h-${2000 + index}`);
  const published = new Set<string>();
  const sent: string[][] = [];
  await page.route("**/api/v1/public-analyses/batch-candidates?*", (route) => {
    const secondPage = new URL(route.request().url()).searchParams.has(
      "cursor",
    );
    return route.fulfill({
      json: {
        items: (secondPage ? ids.slice(20) : ids.slice(0, 20)).map(
          (historyId) => ({
            historyId,
            submissionId: `sub-${historyId.slice(2)}`,
            candidateId: `c-${historyId.slice(2)}`,
            ticId: PUBLICATION_TIC,
            submittedAt: "2026-09-22T01:00:00Z",
            userJudgment: "LIKELY_PLANET",
          }),
        ),
        hasMore: !secondPage,
        nextCursor: secondPage ? null : "second-page",
      },
    });
  });
  await page.route("**/api/v1/histories/h-20*", (route) => {
    const url = new URL(route.request().url());
    const historyId = url.pathname.split("/")[4];
    if (url.pathname.endsWith("/graph")) {
      const graph = historyFixtureResponse(
        "/v1/histories/h-501/graph",
        url.searchParams,
      )!.body as object;
      return route.fulfill({ json: { ...graph, historyId } });
    }
    return route.fulfill({
      json: publicationDetail(
        historyId,
        published.has(historyId) ? `pa-${historyId.slice(2)}` : null,
        published.has(historyId) ? "PUBLISHED" : "UNPUBLISHED",
      ),
    });
  });
  await page.route("**/api/v1/public-analyses/batch", (route) => {
    const body = route.request().postDataJSON() as {
      items: { historyId: string }[];
    };
    const batch = body.items.map((item) => item.historyId);
    sent.push(batch);
    const failed = sent.length <= 2;
    return route.fulfill({
      json: {
        results: batch.map((historyId) => {
          if (failed)
            return {
              historyId,
              status: "FAILED",
              retryable: true,
              error: { code: "TEMPORARY", message: "잠시 후 재시도" },
            };
          published.add(historyId);
          return { status: "PUBLISHED", ...publicationReceipt(historyId) };
        }),
      },
    });
  });
  await page.goto(`/publication?ticId=${PUBLICATION_TIC}`);
  await page.getByRole("button", { name: "공개 대상 더 보기" }).click();
  for (const id of ids.slice(0, 20))
    await card(page, id).getByRole("checkbox").check();
  await expect(card(page, ids[20]).getByRole("checkbox")).toBeDisabled();
  await page.getByRole("button", { name: "선택한 20개 모두 게시" }).click();
  await card(page, ids[20]).getByRole("checkbox").check();
  await page.getByRole("button", { name: "선택한 1개 모두 게시" }).click();
  await expect(
    page.getByText("재시도 대상 21개 중 한 번에 최대 20개를 보냅니다."),
  ).toBeVisible();
  await page.getByRole("button", { name: "실패한 20개만 다시 게시" }).click();
  await page.getByRole("button", { name: "실패한 1개만 다시 게시" }).click();
  await expect(card(page, ids[20])).toContainText("공개 중");
  expect(sent.map((batch) => batch.length)).toEqual([20, 1, 20, 1]);
  expect(sent[2]).toEqual(ids.slice(0, 20));
  expect(sent[3]).toEqual([ids[20]]);
});

test("a retryable failure no longer retries when fresh state is already public", async ({
  page,
}) => {
  const { respond } = await fixture(page);
  await page.route("**/api/v1/public-analyses/batch", (route) => {
    respond("POST", new URL("http://fixture/api/v1/public-analyses"), {
      historyId: "h-1951",
    });
    return route.fulfill({
      json: {
        results: [
          {
            historyId: "h-1951",
            status: "FAILED",
            retryable: true,
            error: { code: "TEMPORARY", message: "다시 확인" },
          },
        ],
      },
    });
  });
  await page.goto(`/publication?ticId=${PUBLICATION_TIC}`);
  await card(page)
    .getByRole("button", { name: "이 기록 게시", exact: true })
    .click();
  await expect(card(page)).toContainText("공개 중");
  await expect(
    page.getByRole("button", { name: /실패한 .*다시 게시/ }),
  ).toHaveCount(0);
});

test("non-retryable item failure does not acquire a retry action", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/v1/public-analyses/batch", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            historyId: "h-1951",
            status: "FAILED",
            retryable: false,
            error: {
              code: "DEPENDENCY_UNAVAILABLE",
              message: "보관 자료를 확인할 수 없습니다.",
            },
          },
        ],
      },
    }),
  );
  await page.goto(`/publication?ticId=${PUBLICATION_TIC}`);
  await card(page)
    .getByRole("button", { name: "이 기록 게시", exact: true })
    .click();
  await expect(card(page)).toContainText("보관 자료를 확인할 수 없습니다");
  await expect(
    page.getByRole("button", { name: /실패한 .*다시 게시/ }),
  ).toHaveCount(0);
});

async function fixture(page: Page) {
  const respond = createPublicationFixture();
  const writes: { method: string; path: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      method = request.method(),
      url = new URL(request.url());
    const body = method === "GET" ? undefined : request.postDataJSON();
    const reply = respond(method, url, body);
    if (!reply) return route.fallback();
    if (method !== "GET") writes.push({ method, path: url.pathname, body });
    return route.fulfill({ status: reply.status, json: reply.body });
  });
  return { writes, respond };
}
const card = (page: Page, id = "h-1951") =>
  page.getByRole("region", { name: `기록 ${id}`, exact: true });

test("duplicate receipt lists its linked discoveries without claiming a new award", async ({
  page,
}) => {
  const { respond } = await fixture(page);
  await page.route("**/api/v1/public-analyses", (route) => {
    respond(
      "POST",
      new URL(route.request().url()),
      route.request().postDataJSON(),
    );
    const receipt = publicationReceipt("h-1951", true, false);
    return route.fulfill({
      json: {
        ...receipt,
        achievement: {
          ...receipt.achievement,
          unlockedStars: [{ ticId: "199574208", position: { x: 0, y: 0 } }],
        },
      },
    });
  });
  await page.goto("/publication/h-1951");
  await card(page)
    .getByRole("button", { name: "이 기록 게시", exact: true })
    .click();
  await expect(card(page)).toContainText("이미 인정된 성과");
  await expect(card(page)).toContainText("이 공개와 연결된 발견 별: 199574208");
  await expect(card(page)).not.toContainText("새로 발견한 별:");
});

test("denied History reveals no preview or publication action", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.route("**/api/v1/histories/h-1951", (route) =>
    route.fulfill({
      status: 403,
      json: { code: "ACCESS_DENIED", message: "이 기록에 접근할 수 없습니다." },
    }),
  );
  await page.goto("/publication/h-1951");
  await expect(card(page).getByRole("alert")).toContainText(
    "접근할 수 없습니다",
  );
  await expect(
    card(page).getByRole("button", { name: "이 기록 게시", exact: true }),
  ).toHaveCount(0);
  await expect(card(page)).not.toContainText("통과 모양을 확인했습니다");
  expect(writes).toHaveLength(0);
});

test("pending writes disable repeat actions and tolerate keyboard activation", async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route("**/api/v1/public-analyses", async (route) => {
    calls++;
    await gate;
    await route.fallback();
  });
  await page.goto("/publication/h-1951");
  const publish = card(page).getByRole("button", {
    name: "이 기록 게시",
    exact: true,
  });
  await publish.focus();
  await page.keyboard.press("Enter");
  await expect(publish).toBeDisabled();
  await page.keyboard.press("Enter");
  release();
  await expect(card(page)).toContainText("공개 중");
  expect(calls).toBe(1);
});

test("unconfirmed write with no record requires explicit review before resending", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.route(
    "**/api/v1/public-analyses",
    (route) => route.abort("failed"),
    { times: 1 },
  );
  await page.goto("/publication/h-1951");
  await card(page)
    .getByRole("button", { name: "이 기록 게시", exact: true })
    .click();
  await expect(
    card(page).getByRole("button", { name: "같은 기록 다시 검토" }),
  ).toBeEnabled();
  expect(writes).toHaveLength(0);
  await card(page).getByRole("button", { name: "같은 기록 다시 검토" }).click();
  await card(page)
    .getByRole("button", { name: "이 기록 게시", exact: true })
    .click();
  await expect(card(page)).toContainText("공개 중");
  expect(writes).toHaveLength(1);
});

test("refresh failure never turns a receipt into current public state", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.route("**/api/v1/histories/h-1951", async (route) => {
    if (!writes.length) return route.fallback();
    await route.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "기록 조회 지연" },
    });
  });
  await page.goto("/publication/h-1951");
  await card(page)
    .getByRole("button", { name: "이 기록 게시", exact: true })
    .click();
  await expect(card(page)).toContainText("다시 확인 필요");
  await expect(
    card(page).getByRole("link", { name: "공개 분석 보기" }),
  ).toHaveCount(0);
  await expect(card(page)).toContainText("이번 응답의 성과: 새로 인정됨");
});

test("moderation-hidden record has cancel but no republish; ineligible has no publish", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/v1/histories/h-1951", (route) =>
    route.fulfill({ json: publicationDetail("h-1951", "pa-1951", "HIDDEN") }),
  );
  await page.goto("/publication/h-1951");
  await expect(card(page)).toContainText("운영에 의해 숨겨짐");
  await expect(
    card(page).getByRole("button", { name: "공개 취소" }),
  ).toBeEnabled();
  await expect(
    card(page).getByRole("button", { name: "이 기록 재공개" }),
  ).toHaveCount(0);
  await page.route("**/api/v1/histories/h-1952", (route) =>
    route.fulfill({ json: publicationDetail("h-1952", null, "NOT_ELIGIBLE") }),
  );
  await page.goto("/publication/h-1952");
  await expect(card(page, "h-1952")).toContainText("공개 대상 아님");
  await expect(
    card(page, "h-1952").getByRole("button", {
      name: "이 기록 게시",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("review is read only until publish; cancellation and republish use visibility PUT", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.goto("/publication/h-1951?returnTo=%2Fsky");
  await expect(card(page)).toContainText("통과 모양을 확인했습니다.");
  await expect(
    card(page).getByRole("button", { name: "이 기록 게시", exact: true }),
  ).toBeEnabled();
  expect(writes).toEqual([]);
  await card(page)
    .getByRole("button", { name: "이 기록 게시", exact: true })
    .click();
  await expect(card(page)).toContainText("공개 중");
  await expect(
    card(page).getByRole("button", { name: "공개 취소" }),
  ).toBeEnabled();
  await card(page).getByRole("button", { name: "공개 취소" }).click();
  await expect(
    card(page).getByRole("button", { name: "이 기록 재공개" }),
  ).toBeEnabled();
  await card(page).getByRole("button", { name: "이 기록 재공개" }).click();
  await expect(card(page)).toContainText("공개 중");
  expect(writes.map((value) => [value.method, value.body])).toEqual([
    ["POST", { historyId: "h-1951" }],
    ["PUT", { isPublic: false }],
    ["PUT", { isPublic: true }],
  ]);
});

test("batch lets user replace representative then sends one history per signal", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.goto(`/publication?ticId=${PUBLICATION_TIC}`);
  await card(page)
    .getByRole("button", { name: "이 신호의 다른 기록 찾기" })
    .click();
  await card(page)
    .getByRole("listitem")
    .filter({ hasText: "h-1953" })
    .getByRole("button")
    .click();
  await card(page, "h-1953").getByRole("checkbox").check();
  await card(page, "h-1952").getByRole("checkbox").check();
  await page.getByRole("button", { name: "선택한 2개 모두 게시" }).click();
  await expect(card(page, "h-1953")).toContainText("공개 중");
  expect(writes[0].body).toEqual({
    ticId: PUBLICATION_TIC,
    items: [{ historyId: "h-1953" }, { historyId: "h-1952" }],
  });
});

test("partial failure retries only the server-designated failed item", async ({
  page,
}) => {
  const { respond } = await fixture(page);
  const bodies: unknown[] = [];
  await page.route("**/api/v1/public-analyses/batch", async (route) => {
    const body = route.request().postDataJSON();
    bodies.push(body);
    if (bodies.length > 1) return route.fallback();
    respond("POST", new URL("http://fixture/api/v1/public-analyses"), {
      historyId: "h-1951",
    });
    await route.fulfill({
      json: {
        results: [
          { status: "PUBLISHED", ...publicationReceipt("h-1951") },
          {
            historyId: "h-1952",
            status: "FAILED",
            error: {
              code: "TEMPORARY",
              message: "잠시 후 다시 시도해 주세요.",
            },
            retryable: true,
          },
        ],
      },
    });
  });
  await page.goto(`/publication?ticId=${PUBLICATION_TIC}`);
  await card(page).getByRole("checkbox").check();
  await card(page, "h-1952").getByRole("checkbox").check();
  await page.getByRole("button", { name: "선택한 2개 모두 게시" }).click();
  await expect(card(page)).toContainText("공개 중");
  await expect(card(page, "h-1952")).toContainText(
    "성과 인정 여부를 확인할 수 없습니다",
  );
  await page.getByRole("button", { name: "실패한 1개만 다시 게시" }).click();
  await expect(card(page, "h-1952")).toContainText("공개 중");
  expect(bodies[1]).toEqual({
    ticId: PUBLICATION_TIC,
    items: [{ historyId: "h-1952" }],
  });
});

test("lost response re-reads state without posting again or inventing achievement", async ({
  page,
}) => {
  const { respond } = await fixture(page);
  let count = 0;
  await page.route("**/api/v1/public-analyses", async (route) => {
    count++;
    respond(
      "POST",
      new URL(route.request().url()),
      route.request().postDataJSON(),
    );
    await route.abort("failed");
  });
  await page.goto("/publication/h-1951");
  await card(page)
    .getByRole("button", { name: "이 기록 게시", exact: true })
    .click();
  await expect(card(page)).toContainText("요청 결과를 확인하지 못했습니다");
  await expect(card(page)).toContainText("공개 중");
  await expect(card(page)).not.toContainText("새로 인정됨");
  expect(count).toBe(1);
});

test("an old successful receipt cannot turn a currently cancelled history public", async ({
  page,
}) => {
  await fixture(page);
  let posted = false;
  await page.route("**/api/v1/public-analyses", (route) => {
    posted = true;
    return route.fulfill({ json: publicationReceipt("h-1951") });
  });
  await page.route("**/api/v1/histories/h-1951", (route) =>
    route.fulfill({
      json: publicationDetail("h-1951", posted ? "pa-1951" : null),
    }),
  );
  await page.goto("/publication/h-1951");
  await card(page)
    .getByRole("button", { name: "이 기록 게시", exact: true })
    .click();
  await expect(
    card(page).getByRole("button", { name: "이 기록 재공개" }),
  ).toBeEnabled();
  await expect(card(page)).toContainText("공개되지 않음");
  await expect(
    card(page).getByRole("link", { name: "공개 분석 보기" }),
  ).toHaveCount(0);
});

test("missing snapshot preview is explicit, errors keep retry button outside alert", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/v1/histories/h-1951/graph?*", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "missing" },
    }),
  );
  await page.goto("/publication/h-1951");
  await expect(card(page).getByRole("alert")).toContainText(
    "그래프를 불러오지 못했습니다",
  );
  await expect(card(page).getByRole("alert").getByRole("button")).toHaveCount(
    0,
  );
  await expect(
    card(page).getByRole("button", { name: "그래프 다시 확인" }),
  ).toBeVisible();
});

test("empty batch and missing TIC do not expose a publish action", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/v1/public-analyses/batch-candidates?*", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null, hasMore: false } }),
  );
  await page.goto(`/publication?ticId=${PUBLICATION_TIC}`);
  await expect(
    page.getByText("아직 게시하지 않은 공개 대상 기록이 없습니다.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.goto("/publication");
  await expect(page.getByRole("alert")).toContainText("별 정보가 없습니다");
});
