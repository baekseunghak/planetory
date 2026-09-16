import { test, expect } from "@playwright/test";
import { candidatePeaksFixture } from "../../dev/periodogram-fixtures";

test("peak selection, slider and exact numeric fine tuning preserve source and issue no analysis requests", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/"))
      requests.push(request.method() + " " + request.url());
  });
  await page.goto("/analysis/259377024");
  const peak = candidatePeaksFixture().peaks[0];
  const selected = page.getByTestId("selected-period");
  await expect(selected).toContainText("선택해 주세요");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.periodDays),
  );
  await expect(selected).toHaveAttribute("data-source", "3600");
  await expect(selected).toHaveAttribute("data-operation", "reselect");
  const loaded = requests.slice();
  const slider = page.getByRole("slider", { name: "반복 주기 미세 조정" });
  const number = page.getByRole("spinbutton", {
    name: "미세 조정 주기 (일)",
    exact: true,
  });
  await expect(number).toHaveValue(String(peak.periodDays));
  await slider.focus();
  await slider.press("ArrowRight");
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.periodDays + peak.fineTune.periodStepDays),
  );
  await expect(selected).toHaveAttribute("data-operation", "fine-tune");
  await expect(selected).toHaveAttribute("data-source", "3600");
  await slider.press("Home");
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.fineTune.periodMinDays),
  );
  await expect(
    page.getByRole("button", { name: "한 간격 줄이기" }),
  ).toBeDisabled();
  await slider.press("End");
  await expect(selected).toHaveAttribute(
    "data-period",
    String(peak.fineTune.periodMaxDays),
  );
  await expect(
    page.getByRole("button", { name: "한 간격 늘리기" }),
  ).toBeDisabled();
  const exact = peak.periodDays + peak.fineTune.periodStepDays / 7;
  await number.fill(String(exact));
  await page
    .getByRole("button", { name: "미세 조정 적용", exact: true })
    .click();
  await expect(selected).toHaveAttribute("data-period", String(exact));
  const revision = await selected.getAttribute("data-revision");
  await number.fill(String(peak.fineTune.periodMaxDays + 0.001));
  await page
    .getByRole("button", { name: "미세 조정 적용", exact: true })
    .click();
  await expect(number).toBeFocused();
  await expect(number).toHaveAttribute("aria-invalid", "true");
  await expect(selected).toHaveAttribute("data-period", String(exact));
  await expect(selected).toHaveAttribute("data-revision", revision!);
  await expect(
    page.getByRole("region", { name: "선택 주기", exact: true }),
  ).toContainText("허용 범위 안의 주기를 입력");
  const panel = page.getByRole("region", {
    name: "반복 주기 그래프",
    exact: true,
  });
  await panel.getByRole("button", { name: "확대", exact: true }).click();
  await panel.getByRole("button", { name: "전체 보기", exact: true }).click();
  await page
    .getByRole("button", { name: "2위 봉우리 위치 보기", exact: true })
    .click();
  await expect(selected).toHaveAttribute("data-revision", revision!);
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await expect(number).toHaveAttribute("aria-invalid", "false");
  await expect(selected).toHaveAttribute("data-operation", "reselect");
  expect(requests).toEqual(loaded);
});

test("arbitrary period selection has null source even on a peak; invalid and empty inputs preserve the selection", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  const selected = page.getByTestId("selected-period");
  const input = page.getByRole("spinbutton", {
    name: "새 주기 (일)",
    exact: true,
  });
  const submit = page.getByRole("button", {
    name: "새 주기 선택",
    exact: true,
  });
  for (const period of [
    "0.5",
    "40",
    "1.2345678901234567",
    String(candidatePeaksFixture().peaks[0].periodDays),
  ]) {
    await input.fill(period);
    await submit.click();
    await expect(selected).toHaveAttribute("data-period", period);
    await expect(selected).toHaveAttribute("data-source", "null");
    await expect(selected).toHaveAttribute("data-operation", "reselect");
    const slider = page.getByRole("slider", { name: "반복 주기 미세 조정" });
    await expect(slider).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "미세 조정 적용", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("직접 선택한 주기의 미세 조정은 아직 지원하지 않습니다.", {
        exact: false,
      }),
    ).toBeVisible();
  }
  const previous = await selected.getAttribute("data-period");
  for (const invalid of ["", "0", "0.49", "40.01"]) {
    await input.fill(invalid);
    await submit.click();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toBeFocused();
    await expect(selected).toHaveAttribute("data-period", previous!);
  }
  await page
    .getByRole("spinbutton", { name: "조회할 격자 번호", exact: true })
    .fill("3600");
  await page.getByRole("button", { name: "격자 값 확인", exact: true }).click();
  await page
    .getByRole("button", { name: "조회한 주기 선택", exact: true })
    .click();
  await expect(selected).toHaveAttribute("data-source", "null");
  const plot = page.getByRole("group", { name: "주기도 그래프", exact: true });
  await plot.focus();
  await plot.press("ArrowDown");
  await plot.press("Enter");
  await expect(selected).not.toHaveAttribute("data-period", previous!);
  await expect(selected).toHaveAttribute("data-source", "null");
});

test("pointer selection is explicit, dragging never reselects and slider pointer movement stays within bounds", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  const plot = page.getByRole("group", { name: "주기도 그래프", exact: true });
  const selected = page.getByTestId("selected-period");
  await plot.click();
  await expect(selected).not.toHaveAttribute("data-period");
  const picker = page.getByRole("button", {
    name: "그래프에서 주기 고르기",
    exact: true,
  });
  await picker.click();
  await plot.scrollIntoViewIfNeeded();
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(selected).not.toHaveAttribute("data-period");
  await plot.click({ position: { x: box.width * 0.4, y: box.height / 2 } });
  await expect(selected).toHaveAttribute("data-source", "null");
  await expect(picker).toHaveAttribute("aria-pressed", "false");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  const slider = page.getByRole("slider", { name: "반복 주기 미세 조정" });
  await slider.scrollIntoViewIfNeeded();
  const track = (await slider.boundingBox())!;
  await slider.click({
    position: { x: track.width * 0.8, y: track.height / 2 },
  });
  await expect(selected).toHaveAttribute("data-operation", "fine-tune");
  const period = Number(await selected.getAttribute("data-period"));
  const fine = candidatePeaksFixture().peaks[0].fineTune;
  expect(period).toBeGreaterThanOrEqual(fine.periodMinDays);
  expect(period).toBeLessThanOrEqual(fine.periodMaxDays);
  await page.setViewportSize({ width: 1024, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(slider).toBeVisible();
});

test("refresh and route change discard previous selection and unavailable responses expose no selection controls", async ({
  page,
}) => {
  await page.goto("/analysis/259377024");
  await page
    .getByRole("button", { name: "1위 봉우리 선택", exact: true })
    .click();
  await page
    .getByRole("button", { name: "최신 자료 확인", exact: true })
    .click();
  await expect(page.getByTestId("selected-period")).not.toHaveAttribute(
    "data-period",
  );
  await expect(
    page.getByRole("slider", { name: "반복 주기 미세 조정" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "2위 봉우리 선택", exact: true })
    .click();
  await page
    .getByRole("link", { name: "주기도 오류 샘플", exact: true })
    .click();
  await expect(page.getByTestId("selected-period")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "새 주기 선택", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "빈 봉우리 샘플", exact: true }).click();
  await expect(
    page.getByText("표시할 추천 봉우리 자료가 없습니다.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "새 주기 선택", exact: true }),
  ).toHaveCount(0);
});
