import {
  selectPeak,
  beginRange,
  tune,
  showJudgment,
  logout,
} from "../analysis-ui";
import { expect, test, type Page } from "@playwright/test";
const url = "/analysis/259377024?returnTo=%2Fsky";
const memo = (page: Page) => page.getByLabel("메모 (선택)", { exact: true });
async function save(page: Page) {
  await page.goto(url);
  await selectPeak(page, 1);
  await beginRange(page);
  await showJudgment(page);
  await page.getByRole("radio", { name: "모르겠음", exact: true }).check();
  await page.getByRole("checkbox", { name: "홀짝 깊이", exact: true }).check();
  await memo(page).fill("세션 초안 🌌");
}
async function stored(page: Page) {
  return page.evaluate(() =>
    Object.keys(sessionStorage).filter((key) =>
      key.startsWith("planetory:analysis-draft:["),
    ),
  );
}
test("reload and same-tab return restore original inputs only after refolding and require confirmation", async ({
  page,
}) => {
  await save(page);
  const phase = await page
    .getByTestId("phase-selection-value")
    .getAttribute("data-start");
  const epoch = await page
    .getByTestId("phase-epoch")
    .getAttribute("data-value");
  await expect.poll(() => stored(page)).toHaveLength(1);
  for (const leave of ["reload", "route"]) {
    if (leave === "reload") await page.reload();
    else {
      await page
        .getByRole("link", { name: "← 이전 화면", exact: true })
        .click();
      await page.goto(url);
    }
    await expect(memo(page)).toHaveValue("");
    await page
      .getByRole("button", { name: "초안 불러오기", exact: true })
      .click();
    await expect(memo(page)).toHaveValue("세션 초안 🌌");
    await expect(memo(page)).toBeDisabled();
    await expect(page.getByTestId("phase-selection-value")).toHaveAttribute(
      "data-start",
      phase!,
    );
    await expect(page.getByTestId("phase-epoch")).toHaveAttribute(
      "data-value",
      epoch!,
    );
    await expect(page.getByTestId("candidate-review")).toHaveCount(0);
    await showJudgment(page);
    await expect(
      page.getByRole("radio", { name: "모르겠음", exact: true }),
    ).toBeChecked();
    await page
      .getByRole("button", { name: "제출값 확인", exact: true })
      .click();
    await expect(page.getByTestId("candidate-review")).toContainText(
      "세션 초안 🌌",
    );
  }
});
test("reloading during an unfinished refold restores the last successful period and draft together", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let count = 0;
    window.Worker = class extends NativeWorker {
      override postMessage(message: unknown) {
        if ((message as { type: string }).type === "fold" && ++count === 2)
          return;
        super.postMessage(message);
      }
    };
  });
  await save(page);
  const period = await page
    .getByTestId("selected-period")
    .getAttribute("data-period");
  await tune(page, "ArrowRight");
  await expect(page.getByTestId("fold-panel")).toHaveAttribute(
    "data-fold-ready",
    "false",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "초안 불러오기", exact: true })
    .click();
  await expect(memo(page)).toHaveValue("세션 초안 🌌");
  await expect(page.getByTestId("selected-period")).toHaveAttribute(
    "data-period",
    period!,
  );
});
test("changed observation revision discards the old draft instead of restoring it", async ({
  page,
}) => {
  await save(page);
  await page.route("**/api/v1/stars/259377024/curves?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // 이 fixture의 기존 개정값(10m-v2)과 다른 값이어야 변경이 감지된다.
    body.segments[0].binningRevision = "10m-v3";
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(
    page.getByRole("region", { name: "분석 초안", exact: true }),
  ).toContainText("복원하지 않았습니다");
  await expect(
    page.getByRole("button", { name: "초안 불러오기", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => stored(page)).toHaveLength(0);
});
test("unavailable storage does not prevent editing or review and explains the limit", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("disabled", "QuotaExceededError");
    };
  });
  await save(page);
  await expect(
    page.getByRole("region", { name: "분석 초안", exact: true }),
  ).toContainText("초안을 저장하지 못했습니다");
  await page.getByRole("button", { name: "제출값 확인", exact: true }).click();
  await expect(page.getByTestId("candidate-review")).toContainText(
    "세션 초안 🌌",
  );
});
for (const reason of ["logout", "expiry", "account-change"] as const)
  test(`${reason} clears only application drafts and cannot re-save them during unmount`, async ({
    page,
  }) => {
    await save(page);
    await page.evaluate(() =>
      sessionStorage.setItem("unrelated-test-value", "keep"),
    );
    if (reason === "logout") {
      await page.route("**/api/v1/auth/csrf", (route) =>
        route.fulfill({
          json: { headerName: "X-CSRF-TOKEN", token: "test-draft-token" },
        }),
      );
      await page.route("**/api/v1/auth/logout", (route) =>
        route.fulfill({ status: 204 }),
      );
      await logout(page);
      await expect(
        page.getByRole("heading", { name: "로그인이 필요합니다", exact: true }),
      ).toBeVisible();
    } else {
      await page.route("**/api/v1/me", (route) =>
        route.fulfill(
          reason === "expiry"
            ? { status: 401, json: { code: "AUTH_REQUIRED" } }
            : {
                json: {
                  memberId: "different-member",
                  nickname: "다른 회원",
                  onboardingDone: true,
                  tutorialCompleted: true,
                },
              },
        ),
      );
      await page.reload();
    }
    await expect.poll(() => stored(page)).toHaveLength(0);
    expect(
      await page.evaluate(() => sessionStorage.getItem("unrelated-test-value")),
    ).toBe("keep");
  });
for (const outcome of ["rejected", "unknown-ended"] as const)
  test(`${outcome}: logout hides the editor, preserves drafts until session end is confirmed and never retries the write`, async ({
    page,
  }) => {
    await save(page);
    await expect.poll(() => stored(page)).toHaveLength(1);
    let writes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/auth/csrf", (route) =>
      route.fulfill({
        json: { headerName: "X-CSRF-TOKEN", token: "test-draft-token" },
      }),
    );
    await page.route("**/api/v1/auth/logout", async (route) => {
      writes++;
      await gate;
      return outcome === "rejected"
        ? route.fulfill({ status: 403, json: { code: "FORBIDDEN" } })
        : route.abort("failed");
    });
    await logout(page);
    await expect(
      page.getByRole("heading", { name: "로그아웃하고 있습니다", exact: true }),
    ).toBeVisible();
    await expect(memo(page)).toHaveCount(0);
    await expect.poll(() => stored(page)).toHaveLength(1);
    release();
    if (outcome === "rejected") {
      await expect(
        page.getByRole("heading", {
          name: "로그아웃하지 못했습니다",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "서비스로 돌아가기", exact: true })
        .click();
      await page
        .getByRole("button", { name: "초안 불러오기", exact: true })
        .click();
      await expect(memo(page)).toHaveValue("세션 초안 🌌");
      await expect(page.getByTestId("candidate-review")).toHaveCount(0);
    } else {
      await expect(
        page.getByRole("heading", {
          name: "로그아웃 여부를 확인해 주세요",
          exact: true,
        }),
      ).toBeVisible();
      await expect.poll(() => stored(page)).toHaveLength(1);
      await page.route("**/api/v1/me", (route) =>
        route.fulfill({ status: 401, json: { code: "AUTH_REQUIRED" } }),
      );
      await page
        .getByRole("button", { name: "로그인 상태 확인", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "로그인이 필요합니다", exact: true }),
      ).toBeVisible();
      await expect.poll(() => stored(page)).toHaveLength(0);
    }
    expect(writes).toBe(1);
  });

test("discard removes the saved draft; malformed JSON never crashes analysis", async ({
  page,
}) => {
  await save(page);
  await page.reload();
  await page
    .getByRole("button", { name: "저장된 초안 지우기", exact: true })
    .click();
  await expect.poll(() => stored(page)).toHaveLength(0);
  await save(page);
  await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((item) =>
      item.startsWith("planetory:analysis-draft:["),
    )!;
    sessionStorage.setItem(key, "{broken");
  });
  await page.reload();
  await expect(
    page.getByRole("region", { name: "분석 초안", exact: true }),
  ).toContainText("복원하지 않았습니다");
  await expect(
    page.getByRole("button", { name: "1위 봉우리 선택", exact: true }),
  ).toBeEnabled();
});
