import { test, expect } from "@playwright/test";

const member = {
  memberId: "logout-test-member",
  nickname: "로그아웃 확인 회원",
  onboardingDone: true,
  tutorialCompleted: true,
};

test("logout waits for CSRF and backend success, disables duplicates, and stays signed out on reload", async ({
  page,
}) => {
  let authenticated = true;
  let writes = 0;
  let tokenRequested!: () => void;
  let releaseToken!: () => void;
  const tokenStarted = new Promise<void>(
    (resolve) => (tokenRequested = resolve),
  );
  const tokenGate = new Promise<void>((resolve) => (releaseToken = resolve));
  await page.route("**/api/v1/me", (route) =>
    route.fulfill(
      authenticated
        ? { json: member }
        : { status: 401, json: { code: "AUTH_REQUIRED" } },
    ),
  );
  await page.route("**/api/v1/auth/csrf", async (route) => {
    tokenRequested();
    await tokenGate;
    await route.fulfill({
      json: { headerName: "X-CSRF-TOKEN", token: "test-token" },
    });
  });
  await page.route("**/api/v1/auth/logout", async (route) => {
    writes++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe("test-token");
    authenticated = false;
    await route.fulfill({ status: 204 });
  });
  await page.goto("/sky");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await tokenStarted;
  await expect(
    page.getByRole("button", { name: "로그아웃 중…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: member.nickname, exact: true }),
  ).toBeVisible();
  expect(writes).toBe(0);
  releaseToken();
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await expect(
    page.getByRole("link", { name: member.nickname, exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
});

test("rejected logout preserves identity and only retries on a new user click", async ({
  page,
}) => {
  let writes = 0;
  await page.route("**/api/v1/me", (route) => route.fulfill({ json: member }));
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      json: { headerName: "X-CSRF-TOKEN", token: "test-token" },
    }),
  );
  await page.route("**/api/v1/auth/logout", (route) => {
    writes++;
    return route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
  });
  await page.goto("/sky");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "로그아웃하지 못했습니다",
  );
  await expect(
    page.getByRole("link", { name: member.nickname, exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect.poll(() => writes).toBe(2);
});

test("lost logout response offers an explicit session check without replaying logout", async ({
  page,
}) => {
  let authenticated = true;
  let writes = 0;
  await page.route("**/api/v1/me", (route) =>
    route.fulfill(
      authenticated
        ? { json: member }
        : { status: 401, json: { code: "AUTH_REQUIRED" } },
    ),
  );
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      json: { headerName: "X-CSRF-TOKEN", token: "test-token" },
    }),
  );
  await page.route("**/api/v1/auth/logout", (route) => {
    writes++;
    authenticated = false;
    return route.abort("failed");
  });
  await page.goto("/sky");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "로그아웃 결과를 확인하지 못했습니다",
  );
  await page
    .getByRole("button", { name: "로그인 상태 확인", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
});
