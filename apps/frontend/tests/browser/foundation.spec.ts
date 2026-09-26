import { openData } from "../analysis-ui";
import { test, expect } from "@playwright/test";
import { pagePath } from "../../src/app/paths";
const member = {
  memberId: "test-member",
  nickname: "검증회원",
  onboardingDone: true,
  tutorialCompleted: false,
};

test("authenticated cookie, shared identity and TIC/History return context survive reload", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "test-session",
      value: "fixture-only",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const cookieReceipts: string[] = [];
  // No route interception: use the serve-only fixture's real HTTP response.
  // Firefox BiDi's intercepted request headers can omit browser-added Cookie.
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/v1/me")
      cookieReceipts.push(
        response.headers()["x-fixture-session-received"] ?? "missing",
      );
  });
  await page.goto("/sky?focus=259377017");
  await expect(
    page.getByRole("link", { name: "연결 확인 계정", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "TIC 259377017 분석으로 이동" }).click();
  await expect(
    page.getByRole("heading", { name: /TIC 259377017/ }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /TIC 259377017/ }),
  ).toBeVisible();
  await openData(page);
  await expect(
    page.getByRole("region", { name: "분석 데이터 요약" }),
  ).toBeVisible();
  const analysisUrl = new URL(page.url());
  await page.getByRole("link", { name: "← 이전 화면", exact: true }).click();
  await expect(page).toHaveURL(/\/sky\?focus=259377017$/);
  // History remains a fixture page; analysis no longer links to a fake record.
  await page.goto(
    pagePath(
      "historyDetail",
      { historyId: "fixture-history-201" },
      {
        ticId: "259377017",
        returnTo: analysisUrl.pathname + analysisUrl.search,
      },
    ),
  );
  await page.reload();
  await expect(
    page.getByText("분석 기록 fixture-history-201", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "분석으로 돌아가기" }).click();
  await page.getByRole("link", { name: "← 이전 화면", exact: true }).click();
  await expect(page).toHaveURL(/\/sky\?focus=259377017$/);
  expect(cookieReceipts.length).toBeGreaterThan(0);
  expect(cookieReceipts.every((received) => received === "true")).toBeTruthy();
});
test("401 protects direct routes, preserves destination and clears identity after expiry", async ({
  page,
}) => {
  let expired = true;
  await page.route("**/api/v1/me", (route) =>
    route.fulfill(
      expired
        ? {
            status: 401,
            json: { code: "AUTH_REQUIRED", message: "로그인 필요" },
          }
        : { json: member },
    ),
  );
  await page.goto("/analysis/259377017?historyId=h-123");
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다" }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
    "/analysis/259377017?historyId=h-123",
  );
  await expect(
    page.getByRole("heading", { name: "분석 · TIC 259377017", exact: true }),
  ).toHaveCount(0);
  expired = false;
  // No standing re-check button: a reload runs the session read again
  // (the same path as a restored page), and the login page forwards.
  await page.reload();
  await expect(page).toHaveURL(/\/analysis\/259377017\?historyId=h-123$/);
  await page.route("**/api/v1/members/fixture-probe", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "AUTH_REQUIRED", message: "로그인 만료" },
    }),
  );
  await page.goto("/members/fixture-probe");
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "검증회원", exact: true }),
  ).toHaveCount(0);
});
test("403, 404 and field reasons are distinct from login failure; GET retry recovers", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) => route.fulfill({ json: member }));
  let status = 403;
  await page.route("**/api/v1/members/fixture-probe", (route) =>
    route.fulfill({
      status,
      json:
        status === 200
          ? { nickname: "복구된 회원" }
          : {
              code: "TEST_ERROR",
              message: "자료 확인 안내",
              fieldErrors:
                status === 400
                  ? [
                      {
                        field: "nickname",
                        reason: "닉네임 형식을 확인해 주세요.",
                      },
                    ]
                  : [],
            },
    }),
  );
  await page.goto("/members/fixture-probe");
  await expect(
    page.getByRole("heading", { name: "접근 권한이 없습니다" }),
  ).toBeVisible();
  for (const [next, title] of [
    [404, "자료를 찾을 수 없거나 볼 수 없습니다"],
    [400, "정보를 불러오지 못했습니다"],
  ] as const) {
    status = next;
    await page.getByRole("button", { name: "다시 불러오기" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "검증회원", exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByText("닉네임 형식을 확인해 주세요.", { exact: true }),
  ).toBeVisible();
  status = 200;
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(page.getByTestId("probe-result")).toHaveText("복구된 회원");
});
test("a late response for the previous route cannot replace the current member", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/members/fixture-probe", async (route) => {
    await hold;
    await route.fulfill({ json: { nickname: "이전 회원" } }).catch(() => {});
  });
  await page.route("**/api/v1/members/fixture-next", (route) =>
    route.fulfill({ json: { nickname: "현재 회원" } }),
  );
  await page.goto("/members/fixture-probe");
  await expect(page.getByRole("status")).toContainText("불러오고");
  await page.getByRole("link", { name: "다음 회원 확인" }).click();
  await expect(page.getByTestId("probe-result")).toHaveText("현재 회원");
  release();
  await page.getByRole("button", { name: "메뉴", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("probe-result")).toHaveText("현재 회원");
  await expect(page.getByText("이전 회원", { exact: true })).toHaveCount(0);
});
test("menu traps keyboard focus and returns it; small screens get the desktop notice", async ({
  page,
}) => {
  await page.goto("/sky");
  const trigger = page.getByRole("button", { name: "메뉴", exact: true });
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "메뉴", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "메뉴 닫기" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "로그아웃", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "메뉴 닫기" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1023, height: 800 });
  await expect(
    page.getByRole("heading", { name: "데스크톱에서 이용해 주세요" }),
  ).toBeVisible();
  await expect(trigger).toHaveCount(0);
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.setViewportSize({ width: 767, height: 800 });
  await expect(page.locator(".desktop-notice")).toBeVisible();
  await expect(page.locator("dialog.navigation")).toBeHidden();
  await expect(page.getByRole("button", { name: "메뉴 닫기" })).toHaveCount(0);
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(
    page.getByRole("dialog", { name: "메뉴", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
test("missing fields never count as a successful session; account demo routes do not exist", async ({
  page,
}) => {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({ json: { member } }),
  );
  await page.goto("/sky");
  await expect(page.getByRole("alert")).toContainText("회원 정보의 응답 형식");
  await expect(
    page.getByRole("link", { name: "TIC 259377017 분석으로 이동" }),
  ).toHaveCount(0);
  await page.unroute("**/api/v1/me");
  await page.goto("/accounts");
  await expect(
    page.getByRole("heading", { name: "페이지를 찾을 수 없습니다" }),
  ).toBeVisible();
});
