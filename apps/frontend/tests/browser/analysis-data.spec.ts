import { openData } from "../analysis-ui";
import { test, expect } from "@playwright/test";

test("analysis requests its current Bundle then displays all segment metadata and preserved gaps", async ({
  page,
}) => {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/stars/")) reads.push(request.url());
  });
  await page.goto("/analysis/259377017?returnTo=%2Fsky%3Ffocus%3D259377017");
  await openData(page);
  await expect(
    page.getByRole("region", { name: "분석 데이터 요약" }),
  ).toContainText("9007199254740993");
  await openData(page);
  await expect(page.locator(".analysis-secondary")).toContainText(
    "관측 구간 2개 · 전체 14점 · 유효 11점 · 결측 3점",
  );
  await expect(
    page.getByRole("table", { name: "관측 세그먼트" }).getByRole("row"),
  ).toHaveCount(3);
  await page.getByText("합성 샘플 · 상세 안내", { exact: true }).click();
  await expect(
    page.getByText("개발용 합성 응답입니다. 실제 관측 데이터가 아닙니다."),
  ).toBeVisible();
  expect(reads[0]).toContain("/analysis-context");
  const curves = reads.filter((url) =>
    new URL(url).pathname.endsWith("/curves"),
  );
  expect(curves.length).toBeGreaterThan(0);
  for (const value of curves) {
    const url = new URL(value);
    expect(url.searchParams.get("bundleId")).toBe("9007199254740993");
    expect(url.searchParams.get("curveStep")).toBe("0");
    expect(url.searchParams.has("removed")).toBe(false);
  }
  await page.reload();
  await openData(page);
  await expect(page.locator(".analysis-secondary")).toContainText("유효 11점");
  await page.getByRole("link", { name: "← 이전 화면", exact: true }).click();
  await expect(page).toHaveURL(/\/sky\?focus=259377017$/);
});
test("refused, unavailable and malformed responses do not become successful empty curves", async ({
  page,
}) => {
  for (const [tic, message] of [
    ["259377018", "아직 열리지 않은 별입니다."],
    ["259377019", "이 별의 분석 자료를 볼 수 없습니다."],
    ["259377020", "nPoints/flux.length"],
    ["259377021", "분석 자료를 불러오지 못했습니다."],
  ]) {
    await page.goto(`/analysis/${tic}`);
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "분석 데이터 요약" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "← 이전 화면", exact: true }),
    ).toBeVisible();
  }
});
test("manual retry recovers through the current analysis context", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/v1/stars/259377017/analysis-context", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: {
            code: "DEPENDENCY_UNAVAILABLE",
            message: "일시적인 로드 실패",
          },
        })
      : route.continue(),
  );
  await page.goto("/analysis/259377017");
  await expect(page.getByRole("alert")).toContainText("일시적인 로드 실패");
  fail = false;
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await openData(page);
  await expect(page.locator(".analysis-secondary")).toContainText("유효 11점");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("an uncomputed residual has no fake chart or background job request", async ({
  page,
}) => {
  const writes: string[] = [],
    jobs: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url());
    if (request.url().includes("residual-jobs")) jobs.push(request.url());
  });
  await page.goto("/analysis/259377022");
  await expect(page.getByRole("status")).toContainText(
    "이 단계의 계산 결과가 없습니다.",
  );
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(jobs).toEqual([]);
});
