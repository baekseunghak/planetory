import { test, expect, type Page } from "@playwright/test";

// #223: main.tsx에 등록된 실제 A13 목록을 조작한다. 로컬 HTTP fixture 검증이며
// 실제 C17/DB/배포 인수(244 P1-223)나 분석 판정 자체의 검증을 대신하지 않는다.
const list = (page: Page) => page.getByRole("list", { name: "별 목록" });
const rows = (page: Page) => list(page).getByRole("listitem");
const grade = (page: Page) =>
  page.getByRole("combobox", { name: "등급", exact: true });
const submit = (page: Page) =>
  page.getByRole("button", { name: "내 별 검색", exact: true });
const more = (page: Page) =>
  page.getByRole("button", { name: "별 더 보기", exact: true });

function watch(page: Page) {
  const requests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/me/stars") requests.push(url);
  });
  return requests;
}

// 기존 fixture가 7건이라 size=20의 이어 읽기를 검사할 수 없다. 이 테스트 안에서만
// 동일 DTO의 25건을 공급한다. cursor는 검색 조건에 묶고 다른 조건에는 400을 낸다.
async function pagedStars(page: Page) {
  const sample = await page.request.get(
    "/api/v1/me/stars?scope=submitted&sort=recent&size=20",
  );
  expect(sample.status()).toBe(200);
  const base = (await sample.json()).items[0];
  const items = Array.from({ length: 25 }, (_, i) => ({
    ...base,
    ticId: String(800000001 + i),
    grade: i % 2 ? "S" : null,
    progressStage: i % 3 ? "in_progress" : "completed",
    lastActivityAt: new Date(Date.UTC(2026, 8, 21, 0, 0, 25 - i)).toISOString(),
  }));
  const state = {
    requests: [] as URL[],
    failNext: false,
    holdNext: false,
    nextStarted: false,
    release: () => {},
  };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  await page.route("**/api/v1/me/stars*", async (route) => {
    const url = new URL(route.request().url());
    state.requests.push(url);
    const q = url.searchParams;
    const filtered = items.filter(
      (item) =>
        (!q.get("grade") || item.grade === q.get("grade")) &&
        (!q.get("stage") || item.progressStage === q.get("stage")) &&
        (!q.get("ticId") || item.ticId === q.get("ticId")),
    );
    const binding = [
      "submitted",
      "recent",
      "20",
      q.get("ticId") ?? "",
      q.get("stage") ?? "",
      q.get("grade") ?? "",
    ].join("|");
    const cursor = Buffer.from(binding + "|20").toString("base64url");
    if (
      q.get("scope") !== "submitted" ||
      q.get("sort") !== "recent" ||
      q.get("size") !== "20" ||
      (q.has("cursor") && q.get("cursor") !== cursor)
    ) {
      await route.fulfill({
        status: 400,
        json: {
          code: "VALIDATION_FAILED",
          message: "목록 조건 또는 커서 불일치",
        },
      });
      return;
    }
    if (q.has("cursor")) {
      state.nextStarted = true;
      if (state.failNext) {
        state.failNext = false;
        await route.fulfill({
          status: 503,
          json: { code: "DEPENDENCY_UNAVAILABLE", message: "잠시 후 다시" },
        });
        return;
      }
      if (state.holdNext) await gate;
    }
    const offset = q.has("cursor") ? 20 : 0;
    const nextCursor = filtered.length > offset + 20 ? cursor : null;
    await route
      .fulfill({
        json: {
          items: filtered.slice(offset, offset + 20),
          nextCursor,
          hasNext: nextCursor !== null,
        },
      })
      .catch((error) => {
        // 취소 후 지연 응답을 내보내는 경우만 닫힌 요청을 허용한다.
        if (!state.holdNext || !q.has("cursor")) throw error;
      });
  });
  return state;
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("223 A13: TIC·진행·등급 조합을 요청과 실제 결과에서 확인한다", async ({
  page,
}) => {
  const requests = watch(page);
  await page.goto("/me?section=stars");
  await expect(rows(page)).toHaveCount(7);
  await grade(page).selectOption("S");
  await submit(page).click();
  await expect(rows(page)).toHaveCount(3);
  await page
    .getByRole("combobox", { name: "탐사 상태", exact: true })
    .selectOption("completed");
  await submit(page).click();
  await expect(rows(page)).toHaveCount(1);
  await page.getByLabel("TIC 번호", { exact: true }).fill("TIC 259377003");
  await submit(page).click();
  await expect
    .poll(() => requests.at(-1)?.searchParams.get("ticId"))
    .toBe("259377003");
  const q = requests.at(-1)!.searchParams;
  expect(q.get("stage")).toBe("completed");
  expect(q.get("grade")).toBe("S");
  expect(q.get("scope")).toBe("submitted");
  expect(q.get("size")).toBe("20");
  expect(q.has("cursor")).toBe(false);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("TIC 259377003");
  await page.getByRole("button", { name: "검색 초기화" }).click();
  await expect(rows(page)).toHaveCount(7);
  await expect(page).not.toHaveURL(/filter(Tic|Stage|Grade)=/);
});

test("223 A13: 빈 검색·입력 오류·잘못된 직접 URL을 구분한다", async ({
  page,
}) => {
  const requests = watch(page);
  await page.goto("/me?section=stars&filterGrade=SSS");
  await expect(
    page.getByText("조건에 맞는 별이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByText(/아직 제출한 별이 없습니다/)).toHaveCount(0);
  const before = requests.length;
  await page.getByLabel("TIC 번호", { exact: true }).fill("-1");
  await submit(page).click();
  await expect(page.getByRole("alert")).toContainText("TIC 번호");
  expect(requests).toHaveLength(before);
  await page.goto("/me?section=stars&filterTic=9223372036854775808");
  await expect(page.getByRole("alert")).toContainText("TIC 번호");
  await expect(list(page)).toHaveCount(0);
  expect(requests).toHaveLength(before);
  await page.getByRole("button", { name: "검색 초기화" }).click();
  await expect(rows(page)).toHaveCount(7);
});

test("223 A13: 분석·History 상세·새로고침·뒤로가기에서 검색을 복원한다", async ({
  page,
}) => {
  await page.goto("/me?section=stars&filterGrade=S");
  await expect(rows(page)).toHaveCount(3);
  const link = list(page).getByRole("link", { name: "이 별 분석하기" }).first();
  const destination = new URL(
    (await link.getAttribute("href"))!,
    "http://local",
  );
  expect(destination.searchParams.get("returnTo")).toContain("filterGrade=S");
  await link.click();
  await expect(page).toHaveURL(/\/analysis\//);
  // 실제 분석 페이지의 복귀 링크를 사용한다. 분석 계산 성공을 주장하지 않는다.
  await page.getByRole("link", { name: "← 이전 화면", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(grade(page)).toHaveValue("S");
  await page.getByRole("button", { name: "내 분석 기록", exact: true }).click();
  await page.getByRole("button", { name: "맞은 신호", exact: true }).click();
  await page
    .getByRole("list", { name: "내 분석 기록" })
    .getByRole("link", { name: "기록 상세 보기" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/history\//);
  await page.getByRole("link", { name: "마이페이지로 돌아가기" }).click();
  await expect(
    page.getByRole("button", { name: "맞은 신호", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "내 별", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(grade(page)).toHaveValue("S");
  await page.reload();
  await expect(rows(page)).toHaveCount(3);
  await grade(page).selectOption("SSS");
  await submit(page).click();
  await expect(
    page.getByText("조건에 맞는 별이 없습니다.", { exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(rows(page)).toHaveCount(3);
  await expect(grade(page)).toHaveValue("S");
});

test("223 A13: 필터 조회 실패는 이전 결과를 지우고 같은 조건으로 재시도한다", async ({
  page,
}) => {
  const requests = watch(page);
  await page.goto("/me?section=stars");
  await expect(rows(page)).toHaveCount(7);
  await page.route("**/api/v1/me/stars*", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "검색 서버 오류" },
    }),
  );
  await grade(page).selectOption("S");
  await submit(page).click();
  await expect(page.getByRole("alert")).toContainText("검색 서버 오류");
  await expect(list(page)).toHaveCount(0);
  await page.unroute("**/api/v1/me/stars*");
  await page
    .getByRole("button", { name: "다시 불러오기", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(3);
  expect(requests.at(-1)!.searchParams.get("grade")).toBe("S");
});

test("223 A13: 실제 내 별 이어 읽기의 503·재시도·필터 변경을 검사한다", async ({
  page,
}) => {
  const fixture = await pagedStars(page);
  await page.goto("/me?section=stars");
  await expect(rows(page)).toHaveCount(20);
  const first = await rows(page).first().innerText();
  fixture.failNext = true;
  await more(page).click();
  await expect(page.getByRole("alert")).toContainText("잠시 후 다시");
  await expect(rows(page)).toHaveCount(20);
  expect(await rows(page).first().innerText()).toBe(first);
  const failedCursor = fixture.requests.at(-1)!.searchParams.get("cursor");
  expect(failedCursor).toBeTruthy();
  await more(page).click();
  await expect(rows(page)).toHaveCount(25);
  expect(fixture.requests.at(-1)!.searchParams.get("cursor")).toBe(
    failedCursor,
  );
  await expect(more(page)).toHaveCount(0);
  await grade(page).selectOption("S");
  await submit(page).click();
  await expect(rows(page)).toHaveCount(12);
  expect(fixture.requests.at(-1)!.searchParams.get("grade")).toBe("S");
  expect(fixture.requests.at(-1)!.searchParams.has("cursor")).toBe(false);
  await expect(rows(page).filter({ hasText: "TIC 800000001" })).toHaveCount(0);
});

test("223 A13: 조건 변경은 지연된 다음 페이지 요청을 취소하고 결과를 섞지 않는다", async ({
  page,
}) => {
  // 네트워크 응답을 지연시켜도 AbortSignal 취소 자체를 관찰할 수 있게 기록한다.
  await page.addInitScript(() => {
    const original = window.fetch;
    const signals: string[] = [];
    Object.assign(window, { cancelled223: signals });
    window.fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.href;
      if (url.includes("/v1/me/stars") && url.includes("cursor=")) {
        init?.signal?.addEventListener("abort", () => signals.push(url), {
          once: true,
        });
      }
      return original.call(window, input, init);
    };
  });
  const fixture = await pagedStars(page);
  fixture.holdNext = true;
  try {
    await page.goto("/me?section=stars");
    await expect(rows(page)).toHaveCount(20);
    await more(page).click();
    await expect.poll(() => fixture.nextStarted).toBe(true);
    await grade(page).selectOption("S");
    await submit(page).click();
    await expect(rows(page)).toHaveCount(12);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { cancelled223: string[] }).cancelled223
              .length,
        ),
      )
      .toBe(1);
    expect(fixture.requests.at(-1)!.searchParams.has("cursor")).toBe(false);
    fixture.release();
    await page.waitForTimeout(100);
    await expect(rows(page)).toHaveCount(12);
  } finally {
    fixture.release();
  }
});

test("223 A13: 타인 공개 목록과 비공개 목록에는 내 검색 조건을 적용하지 않는다", async ({
  page,
}) => {
  const foreign: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\/api\/v1\/members\/[^/]+\/stars$/.test(url.pathname))
      foreign.push(url);
  });
  await page.goto("/me?section=stars&filterGrade=S");
  await expect(rows(page)).toHaveCount(3);
  await page.goto("/members/u-210?section=stars&filterGrade=S");
  await expect(
    page.getByText(
      "이 회원의 별 목록은 비공개입니다. 별별 진행 정보는 볼 수 없습니다.",
    ),
  ).toBeVisible();
  expect(foreign).toHaveLength(0);
  await expect(submit(page)).toHaveCount(0);
  await page.goto("/members/u-211?section=stars&filterGrade=S");
  await expect(rows(page)).toHaveCount(3);
  await expect(submit(page)).toHaveCount(0);
  expect(foreign.length).toBeGreaterThan(0);
  for (const url of foreign) {
    for (const key of ["ticId", "stage", "grade"])
      expect(url.searchParams.has(key)).toBe(false);
    expect(url.searchParams.get("scope")).not.toBe("discovered");
  }
  await expect(list(page).getByText("공개하지 않은 신호")).toHaveCount(0);
});
