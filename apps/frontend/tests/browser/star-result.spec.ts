import { expect, test } from "@playwright/test";
import { starResultFixture } from "../../dev/star-result-fixtures";
const url = "/results/259377024?returnTo=%2Fsky";
test("read-only aggregate keeps completion, unpublished records and reopening independent", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/") && r.method() !== "GET") writes.push(r.url());
  });
  await page.goto(url);
  const result = page.locator(".star-result");
  await expect(result).toContainText("탐색 완료 · 미게시 분석 있음");
  await expect(result).toContainText("새 데이터로 다시 탐색");
  await expect(result.locator("dd").nth(0)).toHaveText("1개");
  await expect(result.locator("dd").nth(1)).toHaveText("3건");
  await expect(result).toContainText("아직 공개된 분석이 없습니다");
  await expect(result).toContainText(
    "현재 데이터의 준비 상태를 뜻하지 않습니다",
  );
  await expect(
    result.getByRole("link", { name: "최신 기록과 곡선 보기" }),
  ).toHaveAttribute("href", /\/history\/h-501\?.*ticId=259377024/);
  await result.getByRole("link", { name: "모두 게시 검토" }).click();
  expect(new URL(page.url()).pathname).toBe("/publication");
  expect(new URL(page.url()).searchParams.get("ticId")).toBe("259377024");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(url);
  await page.goBack();
  await expect(result).toContainText("탐색 완료");
  await result.getByRole("link", { name: "나중에 게시하기" }).click();
  expect(new URL(page.url()).searchParams.get("star")).toBe("259377024");
  expect(writes).toEqual([]);
});
test("publication return fetches again and carries representative History", async ({
  page,
}) => {
  let calls = 0;
  let published = false;
  await page.route("**/api/v1/stars/259377024/result", (route) => {
    const body = starResultFixture();
    calls++;
    if (published) {
      body.unpublishedSignalCount = 0;
      body.signals[0].publication.state = "PUBLISHED";
    }
    return route.fulfill({ json: body });
  });
  await page.goto(url);
  await page.getByRole("link", { name: "분석 공개 검토", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "분석 공개 검토", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/publication/h-501");
  expect(new URL(page.url()).searchParams.get("ticId")).toBe("259377024");
  published = true;
  await page.goBack();
  await expect(page.locator(".star-result")).toContainText("게시됨");
  await expect(page.locator(".star-result")).not.toContainText(
    "미게시 분석 있음",
  );
  expect(calls).toBeGreaterThan(1);
});
test("temporary failures retry outside the alert, unavailable results do not retry", async ({
  page,
}) => {
  let failing = true;
  await page.route("**/api/v1/stars/259377024/result", (route) =>
    failing
      ? route.fulfill({ status: 500, json: { message: "failure" } })
      : route.fulfill({ json: starResultFixture() }),
  );
  await page.goto(url);
  await expect(page.getByRole("alert")).toContainText(
    "별 결과를 불러오지 못했습니다",
  );
  await expect(page.getByRole("alert").getByRole("button")).toHaveCount(0);
  failing = false;
  await page.getByRole("button", { name: "결과 다시 불러오기" }).click();
  await expect(page.locator(".star-result")).toContainText("탐색 완료");
  await page.goto("/results/999");
  await expect(page.getByRole("alert")).toContainText(
    "볼 수 있는 별 결과가 없습니다",
  );
  await expect(
    page.getByRole("button", { name: "결과 다시 불러오기" }),
  ).toHaveCount(0);
});
test("empty result and unavailable current bundle remain readable", async ({
  page,
}) => {
  const body = starResultFixture();
  await page.route("**/api/v1/stars/259377024/result", (route) =>
    route.fulfill({
      json: {
        ...body,
        bundle: null,
        signals: [],
        progress: { ...body.progress, matchedCandidateIds: [] },
        links: { boardOpen: false, threadIds: [] },
        nextActions: [],
      },
    }),
  );
  await page.goto(url);
  await expect(page.locator(".star-result")).toContainText(
    "아직 매칭한 신호가 없습니다",
  );
  await expect(page.getByRole("link", { name: "분석 계속" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "모두 게시 검토" })).toHaveCount(
    0,
  );
});
test("older submissions resolve owned History without accepting a different TIC", async ({
  page,
}) => {
  let valid = false;
  await page.route("**/api/v1/submissions/sub-6990", (route) =>
    route.fulfill({
      json: {
        submissionId: "sub-6990",
        ticId: valid ? "259377024" : "other",
        historyId: "h-501",
      },
    }),
  );
  await page.goto(url);
  await page.getByText("제출 기록 2건 확인", { exact: true }).click();
  await page.getByRole("button", { name: "sub-6990 기록 보기" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "이 제출 기록을 열 수 없습니다",
  );
  expect(new URL(page.url()).pathname).toBe("/results/259377024");
  valid = true;
  await page.getByRole("button", { name: "sub-6990 기록 보기" }).click();
  await expect(page).toHaveURL(/\/history\/h-501\?/);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(url);
});
test("retired signals cannot retry and unknown actions do not generate controls", async ({
  page,
}) => {
  const body = starResultFixture();
  body.signals[0].status = "retired";
  body.nextActions.push("DELETE_EVERYTHING");
  await page.route("**/api/v1/stars/259377024/result", (route) =>
    route.fulfill({ json: body }),
  );
  await page.goto(url);
  const signal = page.getByRole("region", { name: "신호 c-402", exact: true });
  await expect(signal).toContainText("은퇴한 신호");
  await expect(
    signal.getByRole("link", { name: "이 제출 재분석" }),
  ).toHaveCount(0);
  await expect(page.locator(".star-result")).not.toContainText(
    "DELETE_EVERYTHING",
  );
});
test("desktop width wraps and narrow screens retain the desktop guidance", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "탐색 요약" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".star-result")).not.toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByRole("heading", { name: "탐색 요약" })).toBeVisible();
});
