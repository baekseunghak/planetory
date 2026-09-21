import { test, expect, type Page } from "@playwright/test";

// #191 공개 분석 상세. 첨부 카드와 **같은 공개 투영**을 같은 소비 경계로 읽는다.
// 여기서는 그 경로가 실제로 서 있는지와, 없음·거절·장애가 갈리는지를 본다.

type Json = Record<string, unknown>;

const graphBand = (page: Page) => page.locator(".public-analysis");

test("허용된 공개 내용과 현재 곡선을 보여 준다", async ({ page }) => {
  await page.goto("/public-analyses/pa-1");
  await expect(graphBand(page)).toContainText("공개 분석 pa-1");
  await expect(graphBand(page)).toContainText("관측자");
  await expect(graphBand(page)).toContainText("191 합성 공개 분석 메모");
  await expect(graphBand(page)).toContainText("U형 모양 확인");
  await expect(page.getByText("현재 원본 곡선")).toBeVisible();
});

test("제출 당시로 바꾸면 당시 배열을 그린다", async ({ page }) => {
  await page.goto("/public-analyses/pa-1");
  await page.getByRole("button", { name: "제출 당시", exact: true }).click();
  await expect(
    page.getByRole("img", { name: /제출 당시 접힌 곡선.*관측점 150개/ }),
  ).toBeVisible();
  // 당시 화면에 현재 곡선을 대신 담지 않는다.
  await expect(page.getByText("현재 원본 곡선")).toHaveCount(0);
});

test("당시 배열이 없으면 토글을 잠그고 그대로라고 말하지 않는다", async ({
  page,
}) => {
  await page.goto("/public-analyses/pa-2");
  await page.getByRole("button", { name: "제출 당시", exact: true }).click();
  await expect(page.getByText(/제출 당시 스냅샷이 없습니다/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "제출 당시", exact: true }),
  ).toBeDisabled();
  await expect(graphBand(page)).toContainText(
    "당시 잔차 조합을 재현할 수 없습니다",
  );
  await expect(graphBand(page)).not.toContainText("아래 배열은 당시 그대로");
});

test("그래프 장애에도 허용된 공개 내용은 남는다", async ({ page }) => {
  await page.goto("/public-analyses/pa-3");
  // 503 뒤 같은 경로에 includeGraph=false로 다시 물어 권한을 재확인한 내용이다.
  await expect(graphBand(page)).toContainText("191 합성 공개 분석 메모");
  await expect(graphBand(page)).toContainText(
    "판이 변경되어 그래프를 불러오지 못했습니다",
  );
});

test("볼 수 없는 공개 분석은 내용을 남기지 않는다", async ({ page }) => {
  await page.goto("/public-analyses/pa-999");
  await expect(
    page.getByText("자료를 찾을 수 없거나 볼 수 없습니다."),
  ).toBeVisible();
  await expect(graphBand(page)).not.toContainText("합성 공개 분석 메모");
});

for (const status of ["QUEUED", "COMPLETED"] as const) {
  test(`공개 응답에 ${status} jobId가 실려 오면 받지 않고 폴링하지 않는다`, async ({
    page,
  }) => {
    const reads: string[] = [];
    page.on("request", (r) => {
      const url = r.url();
      if (/\/v1\/public-analyses\/|\/histories\/|residual-jobs/.test(url))
        reads.push(url);
    });
    await page.route("**/v1/public-analyses/**", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Json;
      const graph = body.graph as Json | null;
      if (!graph) return route.fulfill({ response, json: body });
      const curve = graph.curve as Json;
      return route.fulfill({
        response,
        json: {
          ...body,
          // 서비스 API 7.2가 금지한 모양이다. 서버가 어겨도 화면이 따라가면 안 된다.
          graph: {
            ...graph,
            curve: { ...curve, residual: { status, jobId: "rj-9" } },
          },
        },
      });
    });
    await page.goto("/public-analyses/pa-1");
    await expect(
      page.getByText("자료 응답을 확인할 수 없습니다.", { exact: true }),
    ).toBeVisible();
    await expect(graphBand(page)).not.toContainText("191 합성 공개 분석 메모");

    const settled = reads.length;
    await page.waitForTimeout(6000);
    expect(reads.length).toBe(settled);
  });
}
