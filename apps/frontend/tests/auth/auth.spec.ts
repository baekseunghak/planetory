import { test, expect, type Page } from "@playwright/test";
async function login(page: Page, provider = "Google") {
  await page.goto("/sky");
  await page
    .getByRole("button", { name: `${provider} 계정으로 로그인`, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "메뉴", exact: true }),
  ).toBeVisible();
}
async function logout(page: Page) {
  await page.getByRole("button", { name: "메뉴", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "로그아웃", exact: true })
    .click();
}
test("both provider entries, protected deep return, reload, logout/back and new identity", async ({
  page,
  context,
}) => {
  await page.goto("/analysis/259377017?historyId=000123");
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Google 계정으로 로그인", exact: true })
    .click();
  await expect(page).toHaveURL(/\/analysis\/259377017\?historyId=000123$/);
  await expect(
    page.getByRole("link", { name: "구글탐사자", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("분석 기록 000123", { exact: true }),
  ).toBeVisible();
  const cookies = await context.cookies();
  expect(
    cookies.find((c) => c.name === "auth-fixture-202-session")?.httpOnly,
  ).toBe(true);
  await logout(page);
  await expect(
    page.getByText("로그아웃되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.goBack();
  await page.goto("/analysis/259377017?historyId=000123");
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "구글탐사자", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "SSAFY 계정으로 로그인", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "싸피탐사자", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "구글탐사자", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("planetory.oauth.returnTo"),
    ),
  ).toBeNull();
});
test("cancellation and provider failure differ from a failed /me after callback; retry preserves return", async ({
  page,
}) => {
  await page.goto("/login?returnTo=%2Fme");
  await page.route("**/api/dev-auth-202/google", (route) =>
    route.fulfill({
      status: 302,
      headers: { location: "/oauth/callback?error=access_denied" },
    }),
  );
  await page
    .getByRole("button", { name: "Google 계정으로 로그인", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "로그인이 취소되었습니다" }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/error=/);
  await page.getByRole("button", { name: "로그인 화면으로" }).click();
  await page.goto("/oauth/callback?error=server_error&returnTo=%2Fme");
  await expect(
    page.getByRole("heading", { name: "로그인을 완료하지 못했습니다" }),
  ).toBeVisible();
  await page.unroute("**/api/dev-auth-202/google");
  await page.getByRole("button", { name: "로그인 화면으로" }).click();
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "UNAVAILABLE", message: "회원 조회 지연" },
    }),
  );
  await page
    .getByRole("button", { name: "Google 계정으로 로그인", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "회원 정보를 확인하지 못했습니다" }),
  ).toBeVisible();
  await page.unroute("**/api/v1/me");
  await page.getByRole("button", { name: "로그인 상태 다시 확인" }).click();
  await expect(page).toHaveURL(/\/me$/);
});
test("first nickname validation, duplicate reason and successful /me confirmation", async ({
  page,
}) => {
  await page.goto("/api/dev-auth-202/google?scenario=first");
  await expect(
    page.getByRole("heading", { name: "어떤 이름으로 탐사할까요?" }),
  ).toBeVisible();
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH") writes++;
  });
  const input = page.getByLabel("닉네임", { exact: true });
  await input.fill("Admin");
  await page.getByRole("button", { name: "이 이름으로 시작하기" }).click();
  await expect(page.getByRole("alert")).toContainText("사용할 수 없는 닉네임");
  expect(writes).toBe(0);
  await input.fill("이미사용중");
  await page.getByRole("button", { name: "이 이름으로 시작하기" }).click();
  await expect(page.getByRole("alert")).toContainText("이미 사용 중인 닉네임");
  await expect(input).toHaveValue("이미사용중");
  await input.fill("  새탐사자  ");
  await page.getByRole("button", { name: "이 이름으로 시작하기" }).click();
  await expect(
    page.getByRole("link", { name: "새탐사자", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(2);
});
test("nickname write with lost reply is verified with GET, never automatically submitted twice", async ({
  page,
}) => {
  await page.goto("/api/dev-auth-202/ssafy?scenario=first");
  let writes = 0;
  await page.route("**/api/v1/me/profile", async (route) => {
    writes++;
    await route.fetch(); // server accepted the write; browser did not receive the result
    await route.abort("failed");
  });
  await page.getByLabel("닉네임", { exact: true }).fill("응답확인탐사자");
  await page.getByRole("button", { name: "이 이름으로 시작하기" }).click();
  await expect(
    page.getByRole("button", { name: "저장 여부 확인" }),
  ).toBeVisible();
  await expect(page.getByLabel("닉네임", { exact: true })).toHaveValue(
    "응답확인탐사자",
  );
  await page.getByRole("button", { name: "저장 여부 확인" }).click();
  await expect(
    page.getByRole("link", { name: "응답확인탐사자", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
});
test("nickname write success does not bypass failed member lookup; draft and return survive retry", async ({
  page,
}) => {
  await page.goto("/oauth/callback?returnTo=%2Fcommunity%3Fq%3Dfirst");
  await page.evaluate(() =>
    sessionStorage.setItem("planetory.oauth.returnTo", "/community?q=first"),
  );
  await page.goto("/api/dev-auth-202/google?scenario=first");
  await page.getByLabel("닉네임", { exact: true }).fill("저장검증");
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "UNAVAILABLE", message: "확인 지연" },
    }),
  );
  await page.getByRole("button", { name: "이 이름으로 시작하기" }).click();
  await expect(
    page.getByRole("heading", { name: "회원 정보를 확인하지 못했습니다" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "메뉴", exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/v1/me");
  await page.getByRole("button", { name: "로그인 상태 다시 확인" }).click();
  await expect(page).toHaveURL(/\/community\?q=first$/);
});
test("ambiguous logout hides private UI, no automatic retry, GET confirms the ended session", async ({
  page,
}) => {
  await login(page);
  let posts = 0;
  await page.route("**/api/v1/auth/logout", async (route) => {
    posts++;
    await route.fetch();
    await route.abort("failed");
  });
  await logout(page);
  await expect(
    page.getByRole("heading", { name: "로그아웃 여부를 확인해 주세요" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "구글탐사자", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "로그인 상태 확인", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다" }),
  ).toBeVisible();
  expect(posts).toBe(1);
});
test("logout failure still active on server permits explicit retry only; CSRF is included", async ({
  page,
}) => {
  await login(page);
  let posts = 0;
  await page.route("**/api/v1/auth/logout", async (route) => {
    posts++;
    expect(route.request().headers()["x-fixture-202-csrf"]).toBeTruthy();
    if (posts === 1)
      await route.fulfill({
        status: 503,
        json: { code: "UNAVAILABLE", message: "응답 지연" },
      });
    else await route.continue();
  });
  await logout(page);
  await page
    .getByRole("button", { name: "로그인 상태 확인", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "로그아웃하지 못했습니다" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "구글탐사자", exact: true }),
  ).toHaveCount(0);
  expect(posts).toBe(1);
  await page
    .getByRole("button", { name: "다시 로그아웃", exact: true })
    .click();
  await expect(
    page.getByText("로그아웃되었습니다.", { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(2);
});
test("ordinary 403 is not first nickname; raw OAuth code is removed without granting access", async ({
  page,
}) => {
  await page.goto(
    "/oauth/callback?code=not-a-session&returnTo=https%3A%2F%2Fevil.test",
  );
  await expect(
    page.getByRole("heading", { name: "로그인을 완료하지 못했습니다" }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/code=/);
  await expect(page).toHaveURL(/returnTo=%2Fsky$/);
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 403,
      json: { code: "FORBIDDEN", message: "권한 확인 필요" },
    }),
  );
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "회원 정보를 확인하지 못했습니다" }),
  ).toBeVisible();
  await expect(page.getByLabel("닉네임", { exact: true })).toHaveCount(0);
});

test("elapsed browser time never renews a server session; expiry on request removes private identity", async ({
  page,
  context,
}) => {
  await page.clock.install();
  await login(page);
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/")) requests.push(req.url());
  });
  await page.clock.fastForward(31 * 60 * 1000);
  expect(requests).toEqual([]);
  await context.clearCookies();
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(
    page.getByText("로그인이 만료되었습니다. 다시 로그인해 주세요.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "구글탐사자", exact: true }),
  ).toHaveCount(0);
});
