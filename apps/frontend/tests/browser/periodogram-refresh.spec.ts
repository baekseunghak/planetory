import { selectPeak, openData } from "../analysis-ui";
import { test, expect } from "@playwright/test";
import type { Request } from "@playwright/test";
import {
  candidatePeaksFixture,
  periodContextFixture,
  periodCurveFixture,
  periodogramFixture,
  PERIODOGRAM_FIXTURE_BUNDLE,
} from "../../dev/periodogram-fixtures";

const tic = "259377024",
  nextId = "9007199254741193",
  removed = "9007199254741094";
function snapshot(next: boolean) {
  const context = periodContextFixture(tic),
    curve = periodCurveFixture(tic),
    periodogram = periodogramFixture(tic),
    peaks = candidatePeaksFixture(tic);
  if (next) {
    context.bundle.bundleId = nextId;
    context.bundle.bundleVersion = "v8";
    context.currentCurveContext.bundleId = nextId;
    context.currentCurveContext.curveStep = 1;
    context.currentCurveContext.removedCandidateIds = [removed];
    curve.bundleId = nextId;
    curve.curveContext = context.currentCurveContext;
    periodogram.curveContext = context.currentCurveContext;
    peaks.curveContext = context.currentCurveContext;
  }
  return {
    "analysis-context": context,
    curves: curve,
    periodogram,
    "candidate-peaks": peaks,
  };
}
const old = snapshot(false),
  next = snapshot(true);
type Resource = keyof typeof old;

for (const resource of ["periodogram", "candidate-peaks"] as const) {
  for (const mode of ["header", "409", "unreadable"] as const) {
    test(`${resource} ${mode} change reloads the full analysis once using the server current curve`, async ({
      page,
    }) => {
      let latest = false,
        release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: {
        name: string;
        query: URLSearchParams;
        request: Request;
      }[] = [];
      await page.route(`**/api/v1/stars/${tic}/**`, async (route) => {
        const url = new URL(route.request().url()),
          name = url.pathname.split("/").pop()! as Resource;
        calls.push({ name, query: url.searchParams, request: route.request() });
        if (
          url.searchParams.get("bundleId") === PERIODOGRAM_FIXTURE_BUNDLE &&
          name === resource
        ) {
          latest = true;
          if (mode === "409")
            await route.fulfill({
              status: 409,
              json: { code: "BUNDLE_CHANGED", currentBundleId: nextId },
            });
          else if (mode === "unreadable")
            await route.fulfill({
              body: "invalid JSON",
              headers: { "X-Current-Bundle": nextId },
            });
          else
            await route.fulfill({
              json: old[name],
              headers: { "X-Current-Bundle": nextId },
            });
          return;
        }
        if (latest && name === "analysis-context") await gate;
        await route.fulfill({
          json: (latest ? next : old)[name],
          headers: {
            "X-Current-Bundle": latest ? nextId : PERIODOGRAM_FIXTURE_BUNDLE,
          },
        });
      });
      await page.goto(`/analysis/${tic}`);
      await expect(
        page.getByText(
          "새 데이터 판이 확인되어 분석 자료를 다시 불러오고 있습니다.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("group", { name: "시간 곡선 그래프", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByTestId("selected-period")).toHaveCount(0);
      release();
      await openData(page);
      await expect(
        page.getByRole("region", { name: "분석 데이터 요약" }),
      ).toContainText(nextId);
      await openData(page);
      await expect(
        page.getByRole("region", { name: "분석 데이터 요약" }),
      ).toContainText("곡선 단계 1");
      await expect(page.getByTestId("selected-period")).toContainText(
        "선택해 주세요",
      );
      await expect(
        page.getByText("새 데이터 판으로 갱신했습니다.", { exact: false }),
      ).toBeVisible();
      // StrictMode cancels its first mount read; it is not a Bundle recovery.
      const completed = calls.filter((call) => !call.request.failure());
      expect(
        completed.filter((call) => call.name === "analysis-context"),
      ).toHaveLength(2);
      const secondContext = completed.findIndex(
        (call, index) => index > 0 && call.name === "analysis-context",
      );
      for (const call of completed.slice(secondContext + 1)) {
        expect(call.query.get("bundleId")).toBe(nextId);
        expect(call.query.get("curveStep")).toBe("1");
        expect(call.query.get("removed")).toBe(removed);
      }
      expect(
        completed.filter((call) => call.name === "candidate-peaks"),
      ).toHaveLength(resource === "periodogram" ? 1 : 2);
    });
  }
}

for (const sequence of [
  "periodogram-periodogram",
  "curves-periodogram",
  "periodogram-curves",
] as const) {
  test(`${sequence} shares one automatic recovery budget; manual retry starts a new attempt`, async ({
    page,
  }) => {
    const phases = sequence.split("-");
    const contexts: Request[] = [],
      mismatches: Request[] = [];
    let failing = true,
      latest = false;
    await page.route(`**/api/v1/stars/${tic}/**`, async (route) => {
      const url = new URL(route.request().url());
      const name = url.pathname.split("/").pop()! as Resource;
      if (name === "analysis-context") contexts.push(route.request());
      const oldQuery =
        url.searchParams.get("bundleId") === PERIODOGRAM_FIXTURE_BUNDLE;
      if (failing && name === phases[oldQuery ? 0 : 1]) {
        latest = true;
        mismatches.push(route.request());
        return route.fulfill({ status: 409, json: { code: "BUNDLE_CHANGED" } });
      }
      await route.fulfill({ json: (latest ? next : old)[name] });
    });
    await page.goto(`/analysis/${tic}`);
    await expect(page.getByRole("alert")).toContainText(
      "데이터 판이 계속 바뀌어",
    );
    expect(contexts.filter((request) => !request.failure())).toHaveLength(2);
    expect(mismatches.filter((request) => !request.failure())).toHaveLength(2);
    await expect(
      page.getByRole("group", { name: "시간 곡선 그래프", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("selected-period")).toHaveCount(0);
    failing = false;
    await page
      .getByRole("button", { name: "다시 불러오기", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "1위 봉우리 선택", exact: true }),
    ).toBeVisible();
    expect(contexts.filter((request) => !request.failure())).toHaveLength(3);
  });
}

test("service errors and body-only context mismatch do not trigger automatic context reload", async ({
  page,
}) => {
  let contexts: Request[] = [],
    mode: number | "mismatch" = 403;
  await page.route(`**/api/v1/stars/${tic}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname
      .split("/")
      .pop()! as Resource;
    if (name === "analysis-context") contexts.push(route.request());
    if (name === "periodogram") {
      if (mode === "mismatch") return route.fulfill({ json: next.periodogram });
      return route.fulfill({
        status: mode,
        json: { code: "OTHER_ERROR", message: "fixture error" },
        headers: { "X-Current-Bundle": nextId },
      });
    }
    await route.fulfill({ json: old[name] });
  });
  for (const failure of [403, 404, 503, 409, "mismatch"] as const) {
    mode = failure;
    contexts = [];
    await page.goto(`/analysis/${tic}`);
    const panel = page.getByRole("region", {
      name: "반복 주기 그래프",
      exact: true,
    });
    await expect(panel.getByRole("button")).toBeVisible();
    expect(contexts.filter((request) => !request.failure())).toHaveLength(1);
    await expect(
      page.getByRole("group", { name: "시간 곡선 그래프", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("selected-period")).toHaveCount(0);
  }
});

test("selected period is cleared while refreshing; an aborted old peaks response cannot overwrite new selection", async ({
  page,
}) => {
  await page.goto(`/analysis/${tic}`);
  await selectPeak(page, 1);
  let latest = false,
    held = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/v1/stars/${tic}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname
      .split("/")
      .pop()! as Resource;
    const body = (latest ? next : old)[name];
    if (!latest && name === "candidate-peaks") {
      held = true;
      await gate;
    }
    await route.fulfill({ json: body }).catch(() => {});
  });
  await openData(page);
  await page
    .getByRole("button", { name: "최신 자료 확인", exact: true })
    .click();
  await expect.poll(() => held).toBe(true);
  await expect(page.getByTestId("selected-period")).toHaveCount(0);
  latest = true;
  await openData(page);
  await page
    .getByRole("button", { name: "최신 자료 확인", exact: true })
    .click();
  await expect(page.getByTestId("selected-period")).toContainText(
    "선택해 주세요",
  );
  await selectPeak(page, 2);
  release();
  await openData(page);
  await expect(
    page.getByRole("region", { name: "분석 데이터 요약" }),
  ).toContainText(nextId);
  await expect(page.getByTestId("selected-period")).toHaveAttribute(
    "data-source",
    "2500",
  );
});
