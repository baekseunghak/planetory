import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { OBSERVATION_TARGETS } from "../../dev/observation-data";

test("three exported stars load via real HTTP, preserve gaps, switch routes and support chart interaction", async ({
  page,
  request,
}) => {
  const manifest = JSON.parse(
    await readFile("dev/observations/manifest.json", "utf8"),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/analysis/259377017?returnTo=%2Fsky");
  for (const target of OBSERVATION_TARGETS) {
    if (target.id !== "toi270")
      await page
        .getByRole("navigation", { name: "관측 데이터 항성 선택" })
        .getByRole("link", { name: target.label, exact: true })
        .click();
    const expected = manifest.targets.find(
      (item: { ticId: string }) => item.ticId === target.ticId,
    );
    const file = JSON.parse(
      await readFile(`dev/observations/${target.ticId}.json`, "utf8"),
    );
    const response = await request.get(
      `/api/v1/stars/${target.ticId}/curves?bundleId=${expected.bundleId}&curveStep=0`,
    );
    expect(response.status()).toBe(200);
    expect(response.headers()["x-current-bundle"]).toBe(expected.bundleId);
    expect(await response.json()).toEqual(file.curve);
    // Unverified prototype BLS must not be substituted for these rebinned curves.
    for (const resource of ["periodogram", "candidate-peaks"]) {
      const missing = await request.get(
        `/api/v1/stars/${target.ticId}/${resource}?bundleId=${expected.bundleId}&curveStep=0`,
      );
      expect(missing.status()).toBe(503);
      expect(missing.headers()["x-current-bundle"]).toBe(expected.bundleId);
      expect((await missing.json()).code).toBe("DEPENDENCY_UNAVAILABLE");
    }
    await expect(
      page.getByRole("region", { name: "분석 데이터 요약" }),
    ).toContainText(expected.bundleId);
    await expect(page.getByRole("status")).toContainText(
      `전체 ${expected.total}점 · 유효 ${expected.valid}점 · 결측 ${expected.missing}점`,
    );
    await expect(
      page.getByText("프로토타입 관측 데이터입니다.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "분석 데이터 요약" }),
    ).toContainText("미연결");
    const plot = page.getByRole("group", {
      name: "시간 곡선 그래프",
      exact: true,
    });
    await expect(plot).toHaveAttribute(
      "data-point-count",
      String(expected.valid),
    );
    await plot.focus();
    await page.keyboard.press("+");
    await expect(page.getByTestId("time-zoom")).toHaveText("×2");
    await page.keyboard.press("0");
    await expect(page.getByTestId("time-zoom")).toHaveText("×1");
    await page.getByRole("button", { name: "최신 자료 확인" }).click();
    await expect(plot).toHaveAttribute(
      "data-point-count",
      String(expected.valid),
    );
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
