import { expect, test } from "@playwright/test";

// #190 기록 상세. 불변과 현재를 가르는지, 같은 값이 모드마다 다른 말을
// 하는지, 없는 것을 0으로 바꾸지 않는지 본다.

test("the stored verdict and the current state are kept apart", async ({
  page,
}) => {
  await page.goto("/history/h-501");
  const then = page
    .locator(".history-band")
    .filter({ has: page.getByRole("heading", { name: "그때 낸 것" }) });
  const now = page
    .locator(".history-band")
    .filter({ has: page.getByRole("heading", { name: "지금" }) });

  // 당시 값. 다시 계산하지 않는다.
  await expect(then).toContainText("고른 주기의 배수가 신호와 맞았습니다");
  await expect(then).toContainText("11.802일");
  await expect(then).toContainText(
    "아직 확정되지 않은 신호라 채점하지 않습니다",
  );
  // 조회 시점 값. 8.2절에만 오는 공개 상태다.
  await expect(now).toContainText("공개되어 있습니다");
  await expect(now).toContainText("이 별 성과 2건");
  // 보관하지 않은 버전을 꾸며 채우지 않는다.
  await expect(page.locator(".history-detail")).toContainText("rule-3");
});

test("the two modes are the same graph on different footing", async ({
  page,
}) => {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (/\/graph\?/.test(request.url())) calls.push(request.url());
  });
  await page.goto("/history/h-501");
  await expect(page.locator(".history-curve svg")).toBeVisible();
  // 생략은 CURRENT다. 화면은 그것을 먼저 보여 준다.
  await expect(
    page.getByRole("button", { name: "현재 판 기준" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".history-curve figcaption")).toContainText(
    "현재 판으로 다시 접은 곡선",
  );

  await page.getByRole("button", { name: "제출 당시 기준" }).click();
  await expect(page.locator(".history-curve figcaption")).toContainText(
    "제출 당시 접힌 곡선",
  );
  // 당시 배열은 150칸이고 값이 없는 칸 하나는 건너뛴다. 0으로 그리지 않는다.
  await expect(page.locator(".history-curve figcaption")).toContainText(
    "149개",
  );
  expect(calls.some((url) => url.includes("mode=SUBMITTED"))).toBe(true);

  // 상세는 불변이라 모드를 바꿔도 다시 부르지 않는다.
  const details = calls.filter((url) => !/\/graph/.test(url));
  expect(details).toHaveLength(0);
});

test("the same reason says different things on the two modes", async ({
  page,
}) => {
  // h-502는 은퇴 후보가 있는 옛 판 기록이다.
  await page.goto("/history/h-502");
  const note = page.locator(".history-graph-band .submission-note");
  await expect(note).toContainText("원본 곡선으로 대체했습니다");

  await page.getByRole("button", { name: "제출 당시 기준" }).click();
  // 당시 배열이 손상됐다는 뜻이 아니다. 「원본 대체」로 적으면 거짓이 된다.
  await expect(note).toContainText("당시 잔차 조합을 재현할 수 없습니다");
  await expect(note).not.toContainText("원본 곡선으로 대체했습니다");
});

test("an array without a version is drawn but not promised", async ({
  page,
}) => {
  await page.goto("/history/h-502");
  await page.getByRole("button", { name: "제출 당시 기준" }).click();
  await expect(page.locator(".history-curve svg")).toBeVisible();
  await expect(page.locator(".history-curve-warning")).toContainText(
    "정렬을 보장할 수 없습니다",
  );
  // 옛 판 기록이라는 사실도 함께 말한다.
  await expect(page.locator(".history-detail")).toContainText(
    "지금 판이 아닌 자료 판에서 낸 것입니다",
  );
});

test("a record without its first response says so instead of guessing", async ({
  page,
}) => {
  await page.goto("/history/h-503");
  await expect(page.getByRole("alert")).toContainText(
    "최초 응답이 없어 상세를 제공할 수 없는 기록입니다",
  );
  // 상세가 없으면 그래프도 그리지 않는다. 절반만 보여 주지 않는다.
  await expect(page.locator(".history-curve")).toHaveCount(0);
  // 그래서 안내도 그렇게 말해야 한다. 기다리면 나올 것처럼 적지 않는다.
  await expect(page.getByRole("alert")).toContainText(
    "이 화면에서는 그래프도 볼 수 없습니다",
  );
});

test("a record that is not there is not invented", async ({ page }) => {
  await page.goto("/history/h-000");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".history-band")).toHaveCount(0);
});
