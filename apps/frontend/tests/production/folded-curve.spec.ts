import { expect, test } from "@playwright/test";
import {
  periodogramFixtureResponse,
  candidatePeaksFixture,
} from "../../dev/periodogram-fixtures";

test("built app loads its emitted Worker asset and folds intercepted API data", async ({
  page,
}) => {
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    url.pathname = url.pathname.replace(/^\/api/, "");
    if (url.pathname === "/v1/me")
      return route.fulfill({
        json: {
          memberId: "fold-test",
          nickname: "테스트",
          onboardingDone: true,
          tutorialCompleted: false,
        },
      });
    const response = periodogramFixtureResponse(url);
    return response
      ? route.fulfill({ status: response.status, json: response.body })
      : route.fulfill({ status: 404 });
  });
  await page.goto("/analysis/259377024");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await expect(page.getByTestId("fold-result")).toHaveAttribute(
    "data-period",
    String(candidatePeaksFixture().peaks[0].periodDays),
  );
  expect(workers).toHaveLength(1);
  expect(workers[0]).toMatch(/\/assets\/fold\.worker-[^/]+\.js$/);
});
