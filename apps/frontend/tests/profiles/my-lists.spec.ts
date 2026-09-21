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

test("이 티켓 범위 밖의 조건을 목록이 보내지 않는다", async ({ page }) => {
  const urls = watch(page, /\/stars(\?|$)/);
  await page.goto("/me");
  await page.getByRole("button", { name: "내 별", exact: true }).click();
  await expect(stars(page)).toBeVisible();
  await page.goto("/members/u-211");
  await page.getByRole("button", { name: "공개한 별", exact: true }).click();
  await expect(stars(page)).toBeVisible();

  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    // P1이라 구현돼 있지 않은 필터. 보내면 400이다.
    expect(url).not.toMatch(/[?&](stage|grade|ticId|size)=/);
    // 타인에게 쓰면 400이다.
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
  await page.goto("/me?section=stars");
  await expect(stars(page).getByRole("listitem")).toHaveCount(3);
  await page.route("**/v1/me/stars*", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "잠시 후 다시" },
    }),
  );
  await page.getByRole("button", { name: "별 더 보기" }).click();
  await expect(page.getByRole("alert")).toContainText("잠시 후 다시");
  // 권한 철회와 다르다. 보고 있던 별은 그대로 둔다.
  await expect(stars(page).getByRole("listitem")).toHaveCount(3);
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
