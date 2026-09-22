import { test, expect, type Page } from "@playwright/test";

// 222의 실제 화면·API 클라이언트를 검사한다. 로컬 합성 응답이며 운영 정책,
// S27의 DB 삭제·모든 기기 세션 폐기·영수증 쿠키 권한 인수를 대신하지 않는다.
const policy = (version = "test-contract-v1") => ({
  available: true,
  version,
  effects: ["검증용 계정 이용 안내 A"],
  retention: ["검증용 데이터 처리 안내 B — 운영 정책 아님"],
  rejoining: ["검증용 재가입 안내 C — 운영 정책 아님"],
});
const receipt = (status = "READY", requestId = "receipt-222") => ({
  requestId,
  status,
  message: `검증용 처리 상태: ${status}`,
});
const apply = (page: Page) =>
  page.getByRole("button", { name: "탈퇴 신청", exact: true });
const confirmation = (page: Page) =>
  page.getByRole("textbox", { name: "확인을 위해" });
const statusLink = (page: Page) =>
  page.getByRole("link", { name: "탈퇴 처리 상태 확인", exact: true });
async function consent(page: Page) {
  await page.getByRole("checkbox").check();
  await confirmation(page).fill("탈퇴");
}

async function setup(page: Page) {
  const state = {
    prepares: [] as { policyVersion: string }[],
    confirms: [] as { policyVersion: string; confirmation: string }[],
    reads: 0,
    ended: false,
    preparedStatus: "READY",
    confirmedStatus: "COMPLETED",
    currentStatus: "READY",
    currentPolicy: policy(),
  };
  // 테스트마다 계정을 격리해 다른 시험의 탈퇴 fixture 상태에 의존하지 않는다.
  await page.route("**/api/v1/me", (route) =>
    route.fulfill(
      state.ended
        ? {
            status: 401,
            json: { code: "UNAUTHENTICATED", message: "검증 계정 종료" },
          }
        : {
            json: {
              memberId: "test-member-222",
              nickname: "검증용 탐사자",
              onboardingDone: true,
              tutorialCompleted: true,
            },
          },
    ),
  );
  await page.route("**/api/v1/me/withdrawal-policy", (route) =>
    route.fulfill({ json: state.currentPolicy }),
  );
  await page.route("**/api/v1/me/withdrawal-requests", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    state.prepares.push(route.request().postDataJSON());
    state.currentStatus = state.preparedStatus;
    return route.fulfill({ json: receipt(state.preparedStatus) });
  });
  await page.route(
    "**/api/v1/me/withdrawal-requests/receipt-222/confirm",
    (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
      state.confirms.push(route.request().postDataJSON());
      state.currentStatus = state.confirmedStatus;
      state.ended = state.confirmedStatus === "COMPLETED";
      return route.fulfill({ json: receipt(state.confirmedStatus) });
    },
  );
  await page.route("**/api/v1/withdrawal-requests/receipt-222", (route) => {
    expect(route.request().method()).toBe("GET");
    state.reads++;
    return route.fulfill({ json: receipt(state.currentStatus) });
  });
  return state;
}

test("222: 서버 정책 원문·새 동의·준비 완료 뒤 확정과 세션 정리를 확인한다", async ({
  page,
}) => {
  const state = await setup(page);
  let release!: () => void;
  let started = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/me/withdrawal-requests", async (route) => {
    started = true;
    await gate;
    await route.fallback();
  });
  try {
    await page.goto("/settings/withdrawal");
    for (const line of [
      ...state.currentPolicy.effects,
      ...state.currentPolicy.retention,
      ...state.currentPolicy.rejoining,
    ])
      await expect(page.getByText(line, { exact: true })).toBeVisible();
    await expect(apply(page)).toBeDisabled();
    await page.getByRole("checkbox").check();
    await expect(apply(page)).toBeDisabled();
    await confirmation(page).fill("탈퇴");
    await page.evaluate(() => {
      sessionStorage.setItem(
        'planetory:analysis-draft:["test-member-222","1"]',
        "synthetic-draft",
      );
      sessionStorage.setItem("unrelated-test-222", "keep");
    });
    await apply(page).click();
    await expect.poll(() => started).toBe(true);
    await expect(
      page.getByRole("button", { name: "처리 확인 중…", exact: true }),
    ).toBeDisabled();
    await expect(confirmation(page)).toBeDisabled();
    expect(state.confirms).toHaveLength(0);
    release();
    await expect(
      page.getByRole("heading", { name: "탈퇴가 완료되었습니다", exact: true }),
    ).toBeVisible();
    expect(state.prepares).toEqual([{ policyVersion: "test-contract-v1" }]);
    expect(state.confirms).toEqual([
      { policyVersion: "test-contract-v1", confirmation: "탈퇴" },
    ]);
    expect(
      await page.evaluate(() =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("planetory:analysis-draft:"),
        ),
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(() => sessionStorage.getItem("unrelated-test-222")),
    ).toBe("keep");
    await page.goto("/sky");
    await expect(page).toHaveURL(/\/login/);
  } finally {
    release();
  }
});

test("222: 확정 성공 후 영수증 조회가 실패해도 완료 경로와 세션 정리를 유지한다", async ({
  page,
}) => {
  const state = await setup(page);
  await page.route("**/api/v1/withdrawal-requests/receipt-222", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "DEPENDENCY_UNAVAILABLE", message: "결과 조회 일시 장애" },
    }),
  );
  await page.goto("/settings/withdrawal");
  await consent(page);
  await page.evaluate(() =>
    sessionStorage.setItem(
      "planetory:analysis-draft:confirmed-222",
      "test-only",
    ),
  );
  await apply(page).click();
  await expect(page).toHaveURL(/\/withdrawal\/status\/receipt-222$/);
  await expect(page.getByRole("alert")).toContainText("결과 조회 일시 장애");
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("planetory:analysis-draft:confirmed-222"),
    ),
  ).toBeNull();
  expect(state.confirms).toHaveLength(1);
  await expect(
    page.getByRole("heading", { name: "탈퇴가 완료되었습니다", exact: true }),
  ).toHaveCount(0);
});

test("222: 정책 조회 장애·누락 문구는 실행을 막고 읽기로 복구한다", async ({
  page,
}) => {
  const state = await setup(page);
  let mode = "unavailable";
  await page.route("**/api/v1/me/withdrawal-policy", (route) =>
    route.fulfill(
      mode === "unavailable"
        ? {
            status: 503,
            json: { code: "WITHDRAWAL_UNAVAILABLE", message: "정책 조회 장애" },
          }
        : mode === "invalid"
          ? { json: { ...policy(), rejoining: [] } }
          : { json: policy() },
    ),
  );
  await page.goto("/settings/withdrawal");
  await expect(page.getByRole("alert")).toContainText("정책 조회 장애");
  await expect(apply(page)).toHaveCount(0);
  mode = "invalid";
  await page
    .getByRole("button", { name: "다시 불러오기", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "탈퇴 처리 정보를 확인할 수 없습니다.",
  );
  await expect(apply(page)).toHaveCount(0);
  mode = "ready";
  await page
    .getByRole("button", { name: "다시 불러오기", exact: true })
    .click();
  await expect(apply(page)).toBeDisabled();
  expect(state.prepares).toHaveLength(0);
  expect(state.confirms).toHaveLength(0);
});

test("222: 준비 응답 유실은 확정을 보내지 않고 정책 재확인으로 돌아간다", async ({
  page,
}) => {
  const state = await setup(page);
  let attempts = 0;
  await page.route("**/api/v1/me/withdrawal-requests", (route) => {
    attempts++;
    return route.abort();
  });
  await page.goto("/settings/withdrawal");
  await consent(page);
  await apply(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "결과를 확인하지 못했습니다",
  );
  await expect(apply(page)).toBeDisabled();
  expect(attempts).toBe(1);
  expect(state.confirms).toHaveLength(0);
  await page
    .getByRole("button", { name: "정책 다시 확인", exact: true })
    .click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(confirmation(page)).toHaveValue("");
  expect(attempts).toBe(1);
});

test("222: 확정 POLICY_CHANGED는 새 정책 확인·새 동의 없이 재전송하지 않는다", async ({
  page,
}) => {
  const state = await setup(page);
  let attempts = 0;
  await page.route(
    "**/api/v1/me/withdrawal-requests/receipt-222/confirm",
    (route) => {
      attempts++;
      return route.fulfill({
        status: 409,
        json: {
          code: "POLICY_CHANGED",
          message: "정책 변경 — 새 안내 확인 필요",
        },
      });
    },
  );
  await page.goto("/settings/withdrawal");
  await consent(page);
  await apply(page).click();
  await expect(page.getByRole("alert")).toContainText("정책 변경");
  await expect(apply(page)).toBeDisabled();
  const recheck = page.getByRole("button", {
    name: "정책 다시 확인",
    exact: true,
  });
  await expect(recheck).toBeVisible();
  state.currentPolicy = policy("test-contract-v2");
  await recheck.click();
  await expect(
    page.getByText("안내 버전: test-contract-v2", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(confirmation(page)).toHaveValue("");
  expect(attempts).toBe(1);
  expect(state.prepares).toHaveLength(1);
  await consent(page);
  await apply(page).click();
  await expect.poll(() => attempts).toBe(2);
  expect(state.prepares.at(-1)).toEqual({ policyVersion: "test-contract-v2" });
});

test("222: 준비 요청이 기존 PROCESSING 영수증을 돌려주면 확정 없이 결과를 조회한다", async ({
  page,
}) => {
  const state = await setup(page);
  state.preparedStatus = "PROCESSING";
  await page.goto("/settings/withdrawal");
  await consent(page);
  await apply(page).click();
  await expect(page).toHaveURL(/\/withdrawal\/status\/receipt-222$/);
  await expect(
    page.getByRole("heading", {
      name: "탈퇴 처리 결과를 확인하고 있습니다",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.confirms).toHaveLength(0);
  expect(state.reads).toBeGreaterThan(0);
});

for (const [value, label] of [
  ["READY", "아직 탈퇴가 확정되지 않았습니다"],
  ["PROCESSING", "탈퇴 처리 결과를 확인하고 있습니다"],
  ["FAILED", "탈퇴가 완료되지 않았습니다"],
] as const) {
  test(`222: 확정 응답 ${value}는 성공으로 오인하거나 자동 재신청하지 않는다`, async ({
    page,
  }) => {
    const state = await setup(page);
    state.confirmedStatus = value;
    await page.goto("/settings/withdrawal");
    await consent(page);
    await apply(page).click();
    await expect(statusLink(page)).toBeVisible();
    await statusLink(page).click();
    await expect(
      page.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "탈퇴가 완료되었습니다", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "처리 상태 다시 확인", exact: true })
      .click();
    await expect.poll(() => state.reads).toBeGreaterThan(1);
    expect(state.prepares).toHaveLength(1);
    expect(state.confirms).toHaveLength(1);
  });
}

test("222: 다른 요청의 성공 응답은 현재 요청의 GET 확인으로만 복구한다", async ({
  page,
}) => {
  const state = await setup(page);
  let attempts = 0;
  await page.route(
    "**/api/v1/me/withdrawal-requests/receipt-222/confirm",
    (route) => {
      attempts++;
      state.currentStatus = "PROCESSING";
      return route.fulfill({ json: receipt("COMPLETED", "other-receipt") });
    },
  );
  await page.goto("/settings/withdrawal");
  await consent(page);
  await apply(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "결과를 확인하지 못했습니다",
  );
  await expect(apply(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "정책 다시 확인", exact: true }),
  ).toHaveCount(0);
  await statusLink(page).click();
  await expect(
    page.getByRole("heading", {
      name: "탈퇴 처리 결과를 확인하고 있습니다",
      exact: true,
    }),
  ).toBeVisible();
  state.currentStatus = "COMPLETED";
  state.ended = true;
  await page
    .getByRole("button", { name: "처리 상태 다시 확인", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "탈퇴가 완료되었습니다", exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(1);
});

for (const code of [401, 404]) {
  test(`222: 결과 조회 ${code}는 완료 근거나 다른 로그인 종료 근거가 아니다`, async ({
    page,
  }) => {
    const state = await setup(page);
    await page.goto("/settings/withdrawal");
    await expect(page.getByRole("checkbox")).toBeVisible();
    await page.evaluate(() =>
      sessionStorage.setItem(
        "planetory:analysis-draft:receipt-boundary",
        "test-only",
      ),
    );
    await page.route("**/api/v1/withdrawal-requests/receipt-222", (route) =>
      route.fulfill({
        status: code,
        json: {
          code: "NOT_FOUND",
          message: "결과 확인 권한이 없거나 만료되었습니다.",
        },
      }),
    );
    await page.goto("/withdrawal/status/receipt-222");
    await expect(page.getByRole("alert")).toContainText("만료");
    await expect(
      page.getByRole("heading", { name: "탈퇴가 완료되었습니다", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("planetory:analysis-draft:receipt-boundary"),
      ),
    ).toBe("test-only");
    expect(state.prepares).toHaveLength(0);
    expect(state.confirms).toHaveLength(0);
  });
}
