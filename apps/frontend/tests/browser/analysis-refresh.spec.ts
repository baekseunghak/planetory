import { openData } from "../analysis-ui";
import { test, expect } from "@playwright/test";
import {
  analysisContextFixture,
  analysisCurveFixture,
} from "../../dev/analysis-fixtures";

const tic = "259377017",
  oldId = "9007199254740993",
  newId = "9007199254740997";
function nextSnapshot() {
  const context = analysisContextFixture();
  context.bundle.bundleId = newId;
  context.bundle.bundleVersion = 8;
  context.currentCurveContext.bundleId = newId;
  context.currentCurveContext.curveStep = 1;
  context.currentCurveContext.removedCandidateIds = ["9007199254740994"];
  const curve = analysisCurveFixture();
  curve.bundleId = newId;
  curve.curveContext = context.currentCurveContext;
  return { context, curve };
}

for (const mode of ["header", "409"] as const)
  test(`Bundle ${mode} race shows reload notice, then only the new matching chart`, async ({
    page,
  }) => {
    const next = nextSnapshot();
    let latest = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const curves: string[] = [];
    await page.route(
      `**/api/v1/stars/${tic}/analysis-context`,
      async (route) => {
        if (!latest) return route.continue();
        await gate;
        await route.fulfill({
          json: next.context,
          headers: { "X-Current-Bundle": newId },
        });
      },
    );
    await page.route(`**/api/v1/stars/${tic}/curves?*`, async (route) => {
      curves.push(route.request().url());
      if (!latest) {
        latest = true;
        await route.fulfill(
          mode === "409"
            ? {
                status: 409,
                json: { code: "BUNDLE_CHANGED", currentBundleId: newId },
              }
            : {
                json: analysisCurveFixture(),
                headers: { "X-Current-Bundle": newId },
              },
        );
        return;
      }
      await route.fulfill({
        json: next.curve,
        headers: { "X-Current-Bundle": newId },
      });
    });
    await page.goto(`/analysis/${tic}`);
    await expect(page.getByRole("status")).toContainText(
      "새 데이터 판이 확인되어",
    );
    await expect(
      page.getByRole("group", { name: "시간 곡선 그래프" }),
    ).toHaveCount(0);
    release();
    await openData(page);
    await expect(
      page.getByRole("region", { name: "분석 데이터 요약" }),
    ).toContainText(newId);
    await expect(
      page.getByText("새 데이터 판으로 갱신했습니다.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "시간 곡선 그래프" }),
    ).toHaveAttribute("data-point-count", "11");
    expect(curves).toHaveLength(2);
    const query = new URL(curves[1]).searchParams;
    expect(query.get("bundleId")).toBe(newId);
    expect(query.get("curveStep")).toBe("1");
    expect(query.get("removed")).toBe("9007199254740994");
  });

test("persistent fixture race is bounded and manual retry can recover", async ({
  page,
}) => {
  const curves: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/curves?")) curves.push(request.url());
  });
  await page.goto("/analysis/259377023");
  await expect(page.getByRole("alert")).toContainText(
    "데이터 판이 계속 바뀌어",
  );
  expect(curves).toHaveLength(2);
  await expect(
    page.getByRole("group", { name: "시간 곡선 그래프" }),
  ).toHaveCount(0);
  await page.route("**/api/v1/stars/259377023/curves?*", (route) =>
    route.fulfill({
      json: analysisCurveFixture("259377023"),
      headers: { "X-Current-Bundle": oldId },
    }),
  );
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(
    page.getByRole("group", { name: "시간 곡선 그래프" }),
  ).toHaveAttribute("data-point-count", "11");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(curves).toHaveLength(3);
});

test("manual current-data check clears old chart and applies server restoration notice", async ({
  page,
}) => {
  await page.goto(`/analysis/${tic}`);
  await expect(
    page.getByRole("group", { name: "시간 곡선 그래프" }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "시간 곡선 그래프", exact: true })
    .press("+");
  await expect(page.getByTestId("time-zoom")).toHaveText("×2");
  const next = nextSnapshot();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/v1/stars/${tic}/analysis-context`, async (route) => {
    await gate;
    await route.fulfill({
      json: { ...next.context, notice: "STEP_NOT_RESTORABLE" },
      headers: { "X-Current-Bundle": newId },
    });
  });
  await page.route(`**/api/v1/stars/${tic}/curves?*`, (route) =>
    route.fulfill({ json: next.curve, headers: { "X-Current-Bundle": newId } }),
  );
  await openData(page);
  await page.getByRole("button", { name: "최신 자료 확인" }).click();
  await expect(
    page.getByRole("group", { name: "시간 곡선 그래프" }),
  ).toHaveCount(0);
  release();
  await openData(page);
  await expect(
    page.getByRole("region", { name: "분석 데이터 요약" }),
  ).toContainText(newId);
  await expect(
    page.getByText("이전 제거 조합을 복원할 수 없어", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("time-zoom")).toHaveText("×1");
});

test("leaving during a curve request ignores its late result after re-entry", async ({
  page,
}) => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let lateFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    lateFinished = resolve;
  });
  let first = true;
  await page.route(`**/api/v1/stars/${tic}/curves?*`, async (route) => {
    if (!first) return route.continue();
    first = false;
    entered();
    await gate;
    try {
      await route.fulfill({
        json: nextSnapshot().curve,
        headers: { "X-Current-Bundle": newId },
      });
    } finally {
      lateFinished();
    }
  });
  await page.goto(`/analysis/${tic}?returnTo=%2Fsky`);
  await requested;
  await page.getByRole("link", { name: "← 이전 화면", exact: true }).click();
  await page.getByRole("link", { name: "TIC 259377017 분석으로 이동" }).click();
  await openData(page);
  await expect(
    page.getByRole("region", { name: "분석 데이터 요약" }),
  ).toContainText(oldId);
  release();
  await finished;
  await expect(
    page.getByRole("region", { name: "분석 데이터 요약" }),
  ).not.toContainText(newId);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
