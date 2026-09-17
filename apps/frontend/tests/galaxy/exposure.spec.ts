import { test, expect } from "@playwright/test";

test("dense map restores starlight on approach while retaining every requested star", async ({
  page,
  request,
}) => {
  await request.post("/api/dev-galaxy-204/reset?count=2501");
  await page.goto("/sky");
  const metrics = async () =>
    JSON.parse(
      (await page.getByTestId("render-stats").textContent()) || "{}",
    ) ?? {};
  await expect.poll(async () => (await metrics()).stars).toBe(2501);
  const far = (await metrics()).exposure;
  expect(far).toBeGreaterThan(0);
  expect(far).toBeLessThan(1);
  await page.getByText("204 렌더 검증 도구", { exact: true }).click();
  await page
    .getByRole("button", { name: /^LOD \d+$/ })
    .last()
    .click();
  await expect
    .poll(async () => (await metrics()).exposure)
    .toBeGreaterThan(far);
  expect((await metrics()).exposure).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("sky-total")).toHaveText("2,501");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
