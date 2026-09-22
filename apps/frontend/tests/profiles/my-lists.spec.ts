import { test, expect, type Page } from "@playwright/test";

// #196 마이페이지 두 목록. 프로필 틀과 권한 분기는 W16(#214) 것이고 여기서는
// 목록이 계약대로 묻고 사실대로 보이는지만 본다.

/** 화면이 실제로 보낸 목록 요청을 모은다. */
function watch(page: Page, pattern: RegExp) {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (pattern.test(request.url())) urls.push(request.url());
  });
  return urls;
}

const stars = (page: Page) => page.getByRole("list", { name: "별 목록" });
const histories = (page: Page) =>
  page.getByRole("list", { name: "내 분석 기록" });

async function openHistories(page: Page) {
  await page.goto("/me");
  await page.getByRole("button", { name: "내 분석 기록", exact: true }).click();
  await expect(histories(page)).toBeVisible();
}

test("필터를 바꾸면 커서를 버리고 처음부터 읽는다", async ({ page }) => {
  const urls = watch(page, /\/v1\/me\/histories/);
  await openHistories(page);
  await expect(histories(page).getByRole("listitem")).toHaveCount(3);

  await page.getByRole("button", { name: "기록 더 보기" }).click();
  await expect(histories(page).getByRole("listitem")).toHaveCount(6);
  expect(urls.some((url) => url.includes("cursor="))).toBe(true);

  const before = urls.length;
  await page.getByRole("button", { name: "맞은 신호", exact: true }).click();
  await expect(histories(page).getByRole("listitem")).toHaveCount(3);

  // 조건이 달라진 요청에 옛 커서가 실리면 서버가 400으로 거절한다.
  const after = urls.slice(before);
  expect(after.length).toBeGreaterThan(0);
  for (const url of after) {
    expect(url).toContain("result=matched");
    expect(url).not.toContain("cursor=");
  }
});

test("이어 읽은 쪽은 앞쪽을 지우지 않는다", async ({ page }) => {
  await openHistories(page);
  const first = await histories(page).getByRole("listitem").first().innerText();
  await page.getByRole("button", { name: "기록 더 보기" }).click();
  await expect(histories(page).getByRole("listitem")).toHaveCount(6);
  expect(await histories(page).getByRole("listitem").first().innerText()).toBe(
    first,
  );
});

test("상세가 없는 기록은 링크 대신 이유를 말한다", async ({ page }) => {
  await openHistories(page);
  const row = histories(page)
    .getByRole("listitem")
    .filter({ hasText: /최초 응답이 없어/ });
  await expect(row).toHaveCount(1);
  // 눌러서 막다른 길에 가게 두지 않는다(8.1절).
  await expect(row.getByRole("link", { name: "기록 상세 보기" })).toHaveCount(
    0,
  );
  // 상세가 있는 기록에는 링크가 있다. 한꺼번에 끈 것이 아니다.
  await expect(
    histories(page).getByRole("link", { name: "기록 상세 보기" }).first(),
  ).toBeVisible();
});

test("공개하지 않은 신호 수는 본인에게만, 0도 사실로 보인다", async ({
  page,
}) => {
  await page.goto("/me");
  await page.getByRole("button", { name: "내 별", exact: true }).click();
  await expect(stars(page)).toBeVisible();
  // 본인 목록에는 0인 별이 있고 그것도 사실이다.
  await expect(
    stars(page).getByRole("listitem").filter({ hasText: "공개하지 않은 신호" }),
  ).not.toHaveCount(0);
  await expect(stars(page).getByText("공개하지 않은 신호")).toBeTruthy();

  // 타인 목록에서는 서버가 필드를 빼므로 줄 자체가 없다. 0으로도 보이지 않는다.
  await page.goto("/members/u-211");
  await page.getByRole("button", { name: "공개한 별", exact: true }).click();
  await expect(stars(page)).toBeVisible();
  await expect(page.getByText(/공개하지 않은 신호/)).toHaveCount(0);
});

test("내 목록은 223 검색 계약을 쓰고 타인 목록에는 넘기지 않는다", async ({
  page,
}) => {
  const urls = watch(page, /\/stars(\?|$)/);
  await page.goto("/me");
  await page.getByRole("button", { name: "내 별", exact: true }).click();
  await expect(stars(page)).toBeVisible();
  await page.goto("/members/u-211");
  await page.getByRole("button", { name: "공개한 별", exact: true }).click();
  await expect(stars(page)).toBeVisible();

  expect(urls.length).toBeGreaterThan(0);
  const own = urls.filter((url) => url.includes("/v1/me/stars?"));
  const foreign = urls.filter((url) => /\/v1\/members\/[^/]+\/stars/.test(url));
  expect(own.length).toBeGreaterThan(0);
  for (const url of own) {
    expect(url).toContain("scope=submitted");
    expect(url).toContain("size=20");
    expect(url).not.toContain("discovered");
  }
  expect(foreign.length).toBeGreaterThan(0);
  for (const url of foreign) {
    // 223의 개인 검색 조건은 타인 공개 목록 계약에 섞지 않는다.
    expect(url).not.toMatch(/[?&](stage|grade|ticId)=/);
    expect(url).not.toContain("discovered");
  }
});

test("목록 조회가 실패하면 다시 불러올 수 있다", async ({ page }) => {
  await page.route("**/v1/me/histories*", (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "목록을 읽지 못했습니다.",
      },
    }),
  );
  await page.goto("/me");
  await page.getByRole("button", { name: "내 분석 기록", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "목록을 읽지 못했습니다.",
  );

  await page.unroute("**/v1/me/histories*");
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(histories(page)).toBeVisible();
});

test("이어 읽다 권한이 철회되면 보던 것도 남기지 않는다", async ({ page }) => {
  await page.goto("/members/u-211?section=stars");
  await expect(stars(page)).toBeVisible();
  await expect(stars(page).getByRole("listitem")).toHaveCount(3);

  // 목록 API가 그제서야 알려 주는 철회다. 슬롯은 들어올 때의 공개 여부만 본다.
  await page.route("**/v1/members/u-211/stars*", (route) =>
    route.fulfill({
      status: 403,
      json: {
        code: "STAR_LIST_PRIVATE",
        message: "별 목록이 비공개로 변경되었습니다.",
      },
    }),
  );
  await page.getByRole("button", { name: "별 더 보기" }).click();

  await expect(page.getByRole("alert")).toContainText("비공개로 변경");
  // 이미 볼 수 없게 된 내용을 계속 보여 주지 않는다.
  await expect(stars(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /게시판|분석/ })).toHaveCount(0);
});

test("잠깐의 통신 실패는 보던 것을 지우지 않는다", async ({ page }) => {
  // 223은 별 목록을 size=20으로 읽어 개발 fixture 7개가 한 쪽에 끝난다.
  // 일시 실패의 "이어 읽기" 보존 규칙은 같은 usePagedList를 쓰는 History의
  // 실제 다중 페이지 fixture로 검증한다.
  await openHistories(page);
  await expect(histories(page).getByRole("listitem")).toHaveCount(3);
  await page.route("**/v1/me/histories*", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "잠시 후 다시" },
    }),
  );
  await page.getByRole("button", { name: "기록 더 보기" }).click();
  await expect(page.getByRole("alert")).toContainText("잠시 후 다시");
  // 권한 철회와 다르다. 보고 있던 기록은 그대로 둔다.
  await expect(histories(page).getByRole("listitem")).toHaveCount(3);
});

test("타인의 별에는 막히는 분석 링크를 내밀지 않는다", async ({ page }) => {
  await page.goto("/me?section=stars");
  await expect(
    stars(page).getByRole("link", { name: "이 별 분석하기" }).first(),
  ).toBeVisible();
  await expect(stars(page).getByText("내 행성")).toBeTruthy();

  await page.goto("/members/u-211?section=stars");
  await expect(stars(page)).toBeVisible();
  // 그 사람이 발견한 별을 내가 열었다는 보장이 없다. 서버는 403 STAR_LOCKED다.
  await expect(
    stars(page).getByRole("link", { name: "이 별 분석하기" }),
  ).toHaveCount(0);
  await expect(
    stars(page).getByRole("link", { name: "이 별 게시판 보기" }).first(),
  ).toBeVisible();
  await expect(stars(page).getByText("내 행성")).toHaveCount(0);
});

test("기록 상세에 갔다 오면 보던 칸과 필터가 그대로다", async ({ page }) => {
  await page.goto("/me");
  await page.getByRole("button", { name: "내 분석 기록", exact: true }).click();
  await page.getByRole("button", { name: "맞은 신호", exact: true }).click();
  await expect(histories(page)).toBeVisible();

  await histories(page)
    .getByRole("link", { name: "기록 상세 보기" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/history\//);
  // 돌아갈 곳이 분석이 아니므로 그렇게 적지 않는다.
  await page.getByRole("link", { name: "마이페이지로 돌아가기" }).click();

  await expect(histories(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "맞은 신호", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("조건이 다른 커서는 개발용 응답도 400으로 거절한다", async ({ page }) => {
  // 이 MR의 핵심 주장이 「커서가 조건·size에 묶인다」인데, 개발용 응답이
  // 통과시켜 주면 화면이 옛 커서를 실어 보내도 검사가 못 잡는다. 서버처럼
  // 거절하는지 직접 확인한다(명세 4.4·8.1).
  const first = await page.request.get("/api/v1/me/histories?result=matched");
  expect(first.status()).toBe(200);
  const cursor = (await first.json()).nextCursor as string;
  expect(cursor).toBeTruthy();

  // 같은 조건이면 이어 읽힌다.
  expect(
    (
      await page.request.get(
        `/api/v1/me/histories?result=matched&cursor=${encodeURIComponent(cursor)}`,
      )
    ).status(),
  ).toBe(200);

  // 필터가 달라지면 거절한다.
  expect(
    (
      await page.request.get(
        `/api/v1/me/histories?result=skipped&cursor=${encodeURIComponent(cursor)}`,
      )
    ).status(),
  ).toBe(400);

  // **크기가 달라져도 거절한다.** 명세에 size가 묶음에 들어 있다.
  expect(
    (
      await page.request.get(
        `/api/v1/me/histories?result=matched&size=5&cursor=${encodeURIComponent(cursor)}`,
      )
    ).status(),
  ).toBe(400);

  // 별 목록도 같다 — 대상 회원이 다르면 이어 쓸 수 없다.
  const mine = await page.request.get("/api/v1/me/stars");
  const starCursor = (await mine.json()).nextCursor as string;
  expect(starCursor).toBeTruthy();
  expect(
    (
      await page.request.get(
        `/api/v1/members/u-211/stars?cursor=${encodeURIComponent(starCursor)}`,
      )
    ).status(),
  ).toBe(400);
});
