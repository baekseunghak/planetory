import { expect, test, type Page } from "@playwright/test";
import { beginRange, selectPeak, showJudgment } from "../analysis-ui";

async function account(page: Page, initiallyDone = false) {
  const state = {
    done: initiallyDone,
    id: "onboarding-197",
    fail: false,
    writes: [] as unknown[],
  };
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        memberId: state.id,
        nickname: "안내 테스트",
        onboardingDone: state.done,
        tutorialCompleted: false,
      },
    }),
  );
  await page.route("**/api/v1/me/onboarding", (route) => {
    state.writes.push(route.request().postDataJSON());
    if (state.fail)
      return route.fulfill({
        status: 503,
        json: { code: "DEPENDENCY_UNAVAILABLE", message: "unavailable" },
      });
    state.done = true;
    return route.fulfill({ json: { onboardingDone: true } });
  });
  return state;
}
const guide = (page: Page) =>
  page.getByRole("complementary", { name: "첫 방문 분석 안내" });

test("guide fits the supported narrow analysis viewport and closes by keyboard", async ({
  page,
}) => {
  await account(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/analysis/259377024?returnTo=%2Fsky");
  await expect(guide(page)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const close = guide(page).getByRole("button", { name: "안내 닫기" });
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(guide(page)).toHaveCount(0);
  await expect(page.locator("#main-content")).toBeFocused();
});

test("first visit closes with true only, survives reload, and remains separate from tutorial completion", async ({
  page,
}) => {
  const state = await account(page);
  await page.goto("/sky");
  await expect(guide(page)).toContainText("1/5 · 별 선택");
  expect(state.writes).toEqual([]);
  await guide(page).getByRole("button", { name: "안내 닫기" }).click();
  await expect(guide(page)).toHaveCount(0);
  expect(state.writes).toEqual([{ onboardingDone: true }]);
  await page.reload();
  await expect(page.getByRole("link", { name: "안내 테스트" })).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  state.id = "other-197";
  state.done = false;
  await page.reload();
  await expect(guide(page)).toContainText("별 선택");
});

test("real analysis stages follow input without writing and failed closure preserves the memo", async ({
  page,
}) => {
  const state = await account(page);
  await page.goto("/analysis/259377024?returnTo=%2Fsky");
  await expect(guide(page)).toContainText("2/5 · 봉우리 선택");
  await selectPeak(page);
  await beginRange(page);
  await expect(guide(page)).toContainText("3/5 · 구간 선택");
  await showJudgment(page);
  await expect(guide(page)).toContainText("4/5 · 판단과 근거");
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByRole("textbox", { name: /메모/ }).fill("작성 내용 유지");
  state.fail = true;
  await guide(page).getByRole("button", { name: "안내 닫기" }).click();
  await expect(guide(page).getByRole("alert")).toContainText(
    "저장하지 못했습니다",
  );
  await expect(page.getByRole("textbox", { name: /메모/ })).toHaveValue(
    "작성 내용 유지",
  );
  state.fail = false;
  await guide(page)
    .getByRole("button", { name: "안내 완료 다시 저장" })
    .click();
  await expect(guide(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /메모/ })).toHaveValue(
    "작성 내용 유지",
  );
  await expect(page.locator("#main-content")).toBeFocused();
  expect(state.writes).toEqual([
    { onboardingDone: true },
    { onboardingDone: true },
  ]);
});

test("successful submission observes server completion without resetting the editor or patching settings", async ({
  page,
}) => {
  const state = await account(page);
  await page.goto("/analysis/259377024");
  await selectPeak(page);
  await beginRange(page);
  await showJudgment(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(guide(page)).toContainText("5/5 · 검토 후 제출");
  state.done = true;
  await page.getByRole("button", { name: "제출하기", exact: true }).click();
  await expect(page.getByTestId("submission-result")).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("account departure cannot leak a delayed successful close to another account", async ({
  page,
}) => {
  const state = await account(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/me/onboarding", async (route) => {
    await held;
    await route.fulfill({ json: { onboardingDone: true } }).catch(() => {});
  });
  await page.goto("/sky");
  await guide(page).getByRole("button", { name: "안내 닫기" }).click();
  await expect(guide(page).getByRole("button")).toBeDisabled();
  state.id = "next-account";
  await page.reload();
  release();
  await expect(
    guide(page).getByRole("button", { name: "안내 닫기" }),
  ).toBeEnabled();
});
