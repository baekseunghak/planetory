import { test, expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    reactionDelay: boolean;
    reactionLoss: boolean;
    reactionRelease?: () => void;
    reactionWrites: number;
  }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.reactionWrites = 0;
    window.reactionDelay = false;
    window.reactionLoss = false;
    window.fetch = async (input, init) => {
      const writing =
        init?.method === "PUT" && String(input).endsWith("/my-reaction");
      if (writing) window.reactionWrites++;
      const response = await original(input, init);
      if (writing && window.reactionDelay && window.reactionWrites === 1)
        await new Promise<void>(
          (resolve) => (window.reactionRelease = resolve),
        );
      if (writing && window.reactionLoss) {
        await response.clone().text();
        throw new TypeError("Test loss after HTTP");
      }
      return response;
    };
  });
});

async function seed(page: Page) {
  const r = await page.request.post("/api/v1/posts", {
    headers: { "X-CSRF-TOKEN": "community-fixture-209" },
    data: {
      title: "반응 검사 " + Date.now(),
      body: "본인 글",
      purposeTag: "GENERAL",
      ticId: null,
    },
  });
  return (await r.json()).postId as string;
}
test("own post agree/disagree/cancel is final-state PUT, counts server-owned and repeat idempotent", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await page.getByRole("button", { name: "동의", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "동의 취소", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "동의한 회원 24명 보기" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "비동의", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "비동의한 회원 1명 보기" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "동의한 회원 23명 보기" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "비동의 취소", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "비동의한 회원 0명 보기" }),
  ).toBeVisible();
  const url = "/api/v1/posts/" + id + "/my-reaction";
  for (let i = 0; i < 2; i++) {
    const r = await page.request.put(url, {
      headers: { "X-CSRF-TOKEN": "community-fixture-209" },
      data: { reaction: "AGREE" },
    });
    expect(await r.json()).toEqual({
      postId: id,
      myReaction: "AGREE",
      agree: 24,
      disagree: 0,
    });
  }
});
test("fast cross choice is serialized and old success never replaces last wanted state", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await page.evaluate(() => (window.reactionDelay = true));
  await page.getByRole("button", { name: "동의", exact: true }).click();
  await expect(
    page.getByText("마지막 선택을 저장하고 있습니다…"),
  ).toBeVisible();
  await page.getByRole("button", { name: "비동의", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "비동의 취소", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.reactionWrites)).toBe(1);
  await expect
    .poll(() => page.evaluate(() => typeof window.reactionRelease))
    .toBe("function");
  await page.evaluate(() => window.reactionRelease?.());
  await expect(
    page.getByRole("button", { name: "비동의한 회원 1명 보기" }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.reactionWrites)).toBe(2);
});
test("reactors page all members, fresh nicknames and keyboard close restore count focus", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  const trigger = page.getByRole("button", { name: "동의한 회원 23명 보기" });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("li")).toHaveCount(20);
  await dialog.getByRole("button", { name: "다음 페이지" }).click();
  await expect(dialog.locator("li")).toHaveCount(3);
  await dialog.getByRole("button", { name: "처음 페이지" }).click();
  await expect(dialog.locator("li")).toHaveCount(20);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.route("**/api/v1/posts/" + id + "/reactions?*", (route) =>
    route.fulfill({
      json: {
        items: [{ memberId: "u-1", nickname: "변경한 최신 이름" }],
        nextCursor: null,
        hasNext: false,
      },
    }),
  );
  await trigger.click();
  await expect(dialog).toContainText("변경한 최신 이름");
});
test("lost PUT is re-read without automatic writes and malformed success is uncertain", async ({
  page,
}) => {
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await page.evaluate(() => (window.reactionLoss = true));
  await page.getByRole("button", { name: "동의", exact: true }).click();
  await expect(
    page.getByText("반응을 자동으로 다시 보내지 않습니다.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "동의", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.reactionWrites)).toBe(1);
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(
    page.getByRole("button", { name: "동의한 회원 24명 보기" }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.reactionWrites)).toBe(1);
  await page.evaluate(() => (window.reactionLoss = false));
  await page.route("**/api/v1/posts/" + id + "/my-reaction", (route) =>
    route.fulfill({
      json: { postId: "wrong", myReaction: "NONE", agree: 0, disagree: 0 },
    }),
  );
  await page.getByRole("button", { name: "동의 취소", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("반응 저장 응답");
});
test("hidden parent/401 clears reactions and official threads never contain ordinary reaction controls", async ({
  page,
}) => {
  await page.goto("/signal-threads/st-301");
  await expect(
    page.getByRole("heading", { name: "참여자 15명" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "이 글에 대한 의견" }),
  ).toHaveCount(0);
  const id = await seed(page);
  await page.goto("/posts/" + id);
  await page.route("**/api/v1/posts/" + id + "/my-reaction", (route) =>
    route.fulfill({
      status: 403,
      json: { code: "FORBIDDEN", message: "부모 숨김" },
    }),
  );
  await page.getByRole("button", { name: "동의", exact: true }).click();
  await expect(
    page.locator(".reaction-controls,.community-comments,.community-post-body"),
  ).toHaveCount(0);
  await page.unroute("**/api/v1/posts/" + id + "/my-reaction");
  await page.reload();
  await page.route("**/api/v1/posts/" + id + "/my-reaction", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "AUTH_REQUIRED", message: "만료" },
    }),
  );
  await page.getByRole("button", { name: "동의", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다" }),
  ).toBeVisible();
});
