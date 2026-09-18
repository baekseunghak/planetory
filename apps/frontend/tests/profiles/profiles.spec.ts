import { test, expect, type Locator } from "@playwright/test";
async function enter(target: Locator, value: string) {
  await target.fill(value);
  if (test.info().project.name === "firefox") {
    await target.press("End");
    await target.press("Space");
    await target.press("Backspace");
  }
}
test("server field errors keep draft and pending save disables duplicates at 20 characters", async ({
  page,
}) => {
  await page.goto("/me");
  await page.getByRole("button", { name: "닉네임 변경" }).click();
  const input = page.getByRole("textbox", { name: "새 닉네임" });
  await page.route("**/v1/me/profile", (route) =>
    route.fulfill({
      status: 400,
      json: {
        code: "VALIDATION_FAILED",
        message: "입력 확인",
        fieldErrors: [{ field: "nickname", reason: "서버 추가 금칙어" }],
      },
    }),
  );
  await enter(input, "서버금칙어");
  await page.getByRole("button", { name: "닉네임 저장", exact: true }).click();
  await expect(
    page.getByText("서버 추가 금칙어", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("서버금칙어");
  await page.unroute("**/v1/me/profile");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let writes = 0;
  await page.route("**/v1/me/profile", async (route) => {
    writes++;
    await gate;
    await route.continue();
  });
  await enter(input, "가".repeat(20));
  await page.getByRole("button", { name: "닉네임 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "저장 확인 중…", exact: true }),
  ).toBeDisabled();
  await expect(input).toBeDisabled();
  release();
  await expect(
    page.getByRole("heading", { name: "가".repeat(20), exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
});
test("own summary uses server counts; public whitelist and private stars stay distinct", async ({
  page,
}) => {
  await page.goto("/me");
  await expect(page.locator(".profile-summary")).toContainText("57");
  await expect(page.locator(".profile-summary")).toContainText("5");
  await expect(page.locator(".profile-summary")).toContainText("9");
  await expect(page.locator(".profile-meta time")).toHaveText(
    "2026년 9월 15일",
  );
  await expect(page.locator(".profile-meta time")).toHaveAttribute(
    "datetime",
    "2026-09-14T15:30:00Z",
  );
  await expect(
    page.getByRole("button", { name: "내 분석 기록", exact: true }),
  ).toBeVisible();
  await page.goto("/members/u-210");
  await expect(page.getByRole("heading", { name: "다른탐사자" })).toBeVisible();
  await expect(page.getByText(/가입일/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "닉네임 변경" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "내 분석 기록", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".profile-summary")).toContainText("7");
  await page.getByRole("button", { name: "공개한 별", exact: true }).click();
  await expect(page.getByText(/이 회원의 별 목록은 비공개/)).toBeVisible();
  await page.goto("/members/u-211");
  await page.getByRole("button", { name: "공개한 별", exact: true }).click();
  await expect(page.getByText(/별 목록 화면은 연결 준비 중/)).toBeVisible();
  await page.goto("/members/u-209");
  await expect(page).toHaveURL(/\/me$/);
  await page.goto("/members/u-999");
  await expect(page.getByText(/회원을 찾을 수 없습니다/)).toBeVisible();
});
test("missing or invalid own joinedAt shows a recoverable contract error, not a fabricated date", async ({
  page,
}) => {
  for (const joinedAt of [undefined, "2026-13-01T00:00:00Z"]) {
    await page.route("**/api/v1/me", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...(await response.json()), joinedAt } });
    });
    await page.goto("/me");
    await expect(page.getByRole("alert")).toContainText(
      "프로필 정보를 확인할 수 없습니다.",
    );
    await expect(page.locator(".profile-meta time")).toHaveCount(0);
    await page.unroute("**/api/v1/me");
  }
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(page.locator(".profile-meta time")).toHaveText(
    "2026년 9월 15일",
  );
});
test("nickname validation, conflict, NFC save and author/header refresh", async ({
  page,
}) => {
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "PATCH") writes++;
  });
  await page.goto("/me");
  await page.getByRole("button", { name: "닉네임 변경" }).click();
  const input = page.getByRole("textbox", { name: "새 닉네임" });
  for (const value of ["a", "a".repeat(21), "system", "bad!"]) {
    await enter(input, value);
    await page
      .getByRole("button", { name: "닉네임 저장", exact: true })
      .click();
    await expect(page.getByRole("alert").first()).toBeVisible();
  }
  expect(writes).toBe(0);
  await enter(input, "이미사용중");
  await page.getByRole("button", { name: "닉네임 저장", exact: true }).click();
  await expect(
    page.getByText("이미 사용 중인 닉네임입니다.", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("이미사용중");
  await enter(input, "가나");
  await page.getByRole("button", { name: "닉네임 저장", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "가나", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(2);
  const me = await (await page.request.get("/api/v1/me")).json();
  expect(me.nickname).toBe("가나");
  await page.goto("/posts/p-201");
  await expect(
    page.getByRole("link", { name: "가나", exact: true }).first(),
  ).toBeVisible();
  const post = await (await page.request.get("/api/v1/posts/p-201")).json();
  expect(post.author.nickname).toBe("가나");
});
test("unknown nickname response keeps input, blocks duplicate writes and recovers with GET", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const native = window.fetch.bind(window);
    let lost = false;
    window.fetch = async (...args) => {
      const res = await native(...args);
      if (
        !lost &&
        String(args[0]).endsWith("/v1/me/profile") &&
        args[1]?.method === "PATCH"
      ) {
        lost = true;
        throw new TypeError("simulated response lost after HTTP");
      }
      return res;
    };
  });
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "PATCH") writes++;
  });
  await page.goto("/me");
  await page.getByRole("button", { name: "닉네임 변경" }).click();
  const input = page.getByRole("textbox", { name: "새 닉네임" });
  await enter(input, "유실확인");
  await page.getByRole("button", { name: "닉네임 저장", exact: true }).click();
  await expect(page.getByText(/저장 여부를 확인할 수 없습니다/)).toBeVisible();
  await expect(input).toHaveValue("유실확인");
  await expect(input).toBeDisabled();
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "현재 닉네임 확인" }).click();
  await expect(page.getByText("현재 서버 닉네임: 유실확인")).toBeVisible();
  await page.getByRole("button", { name: "현재 닉네임 사용" }).click();
  await expect(
    page.getByRole("heading", { name: "유실확인", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
});
test("guide five steps, image loading, keyboard and focus restoration; no state writes", async ({
  page,
}) => {
  const before = await (await page.request.get("/api/v1/me")).json();
  const writes: string[] = [];
  page.on("request", (r) => {
    if (!["GET", "HEAD"].includes(r.method())) writes.push(r.url());
  });
  await page.goto("/me");
  const trigger = page.getByRole("button", { name: "사용법 다시 보기" });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  const titles = [
    "별 선택",
    "봉우리 선택",
    "구간 선택",
    "판단과 근거",
    "검토 후 제출",
  ];
  for (let i = 0; i < 5; i++) {
    await expect(
      dialog.getByRole("heading", { name: titles[i] }),
    ).toBeVisible();
    await expect
      .poll(() =>
        dialog
          .locator("img")
          .evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    if (i < 4)
      await dialog.getByRole("button", { name: "다음", exact: true }).click();
  }
  await dialog.getByRole("button", { name: "안내 마치고 닫기" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    dialog.getByRole("heading", { name: "별 선택", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(
    dialog.getByRole("heading", { name: "봉우리 선택", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(
    dialog.getByRole("heading", { name: "별 선택", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(writes).toEqual([]);
  expect(await (await page.request.get("/api/v1/me")).json()).toEqual(before);
});
test("guide still images for reduced motion and readable fallback after image failure", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/me");
  await page.getByRole("button", { name: "사용법 다시 보기" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("img")).toHaveAttribute("src", /\.png$/);
  await expect
    .poll(() =>
      dialog
        .locator("img")
        .evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0),
    )
    .toBe(true);
  await expect(dialog.getByRole("button", { name: "움직임 멈춤" })).toHaveCount(
    0,
  );
  await page.route("**/guides/02-bls-peak.png", (route) => route.abort());
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(dialog.getByText(/이미지를 불러오지 못했습니다/)).toBeVisible();
  await expect(dialog.getByText(/주기도에서 반복 신호/)).toBeVisible();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "구간 선택", exact: true }),
  ).toBeVisible();
});
