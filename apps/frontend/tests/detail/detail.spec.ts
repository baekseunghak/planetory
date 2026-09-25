import { test, expect, type Page } from "@playwright/test";
const canvas = (page: Page) => page.locator(".galaxy-scene canvas");
const camera = async (page: Page) =>
  JSON.parse((await canvas(page).getAttribute("data-camera"))!);
const panel = (page: Page) =>
  page.getByRole("complementary", { name: "별 상세" });
async function ready(page: Page) {
  await page.goto("/sky");
  await expect(canvas(page)).toHaveAttribute("data-rendered-stars", "1000");
}
async function select(page: Page, seq = 1) {
  await page.locator(`.galaxy-marker[data-marker="${seq}"]`).click();
  await expect(
    panel(page).getByRole("link", { name: /분석 시작/ }),
  ).toBeVisible();
  await expect.poll(async () => (await camera(page)).zoom).toBe(4);
}
test.beforeEach(async ({ request, page }) => {
  await request.post("/api/dev-galaxy-204/reset?count=1000");
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("NASA panel reads saved state, requests only the selected confirmed candidate and shows facts", async ({
  page,
  request,
}) => {
  const star = await (await request.get("/api/v1/me/stars/900000001")).json();
  const base = star.planets.items.map(
    (planet: { candidateId: string; kind: string }) => ({
      candidateId: planet.candidateId,
      kind: planet.kind,
      status: planet.kind === "confirmed" ? "not_requested" : "not_applicable",
      content: null,
      facts: null,
      sourceStatus: planet.kind === "confirmed" ? "not_requested" : null,
      fetchedAt: null,
      refreshStatus: null,
      generatedAt: null,
      retryAt: null,
      failure: null,
    }),
  );
  let reads = 0,
    writes = 0,
    generated = false;
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      json: {
        headerName: "X-CSRF-TOKEN",
        token: "fixture-268",
      },
    }),
  );
  await page.route(
    "**/api/v1/me/stars/900000001/planet-explanations",
    async (route) => {
      if (route.request().method() === "POST") {
        writes++;
        expect(route.request().postDataJSON()).toEqual({
          candidateId: "fixture-204-p-0",
        });
        expect(route.request().headers()["x-csrf-token"]).toBe("fixture-268");
        generated = true;
      } else reads++;
      const items = base.map((item: (typeof base)[number]) =>
        item.candidateId !== "fixture-204-p-0" || !generated
          ? item
          : {
              ...item,
              status: "ready",
              content: {
                name: "TOI-700 b를 알아볼까요?",
                orbitalPeriod: "별을 도는 데 9.97일이 걸려요.",
                radius: "반지름은 지구의 0.91배예요.",
                mass: "질량은 알 수 없어요.",
                discovery: "2020년에 발견됐어요.",
              },
              facts: {
                planetName: "TOI-700 b",
                orbitalPeriod: {
                  value: "9.97",
                  errorPlus: null,
                  errorMinus: null,
                  limit: 0,
                  unit: "days",
                  reference: null,
                },
                radius: {
                  value: "0.91",
                  errorPlus: null,
                  errorMinus: null,
                  limit: -1,
                  unit: "earth_radius",
                  reference: null,
                },
                mass: {
                  value: null,
                  errorPlus: null,
                  errorMinus: null,
                  limit: null,
                  unit: "earth_mass",
                  reference: null,
                },
                discoveryMethod: "Transit",
                discoveryYear: 2020,
                controversial: false,
                sourceTable: "ps",
                sourceUrl: "https://exoplanetarchive.ipac.caltech.edu/",
              },
              sourceStatus: "ready",
              fetchedAt: "2026-09-25T05:20:00Z",
              refreshStatus: "ok",
              generatedAt: "2026-09-25T05:21:00Z",
            },
      );
      await route.fulfill({
        json: { ticId: star.ticId, version: star.version, items },
      });
    },
  );
  await ready(page);
  await select(page);
  await panel(page)
    .getByRole("button", { name: "행성 1 fixture-204-p-0" })
    .click();
  expect(reads).toBe(0);
  await panel(page)
    .getByRole("button", { name: "NASA 행성 자료 보기" })
    .click();
  await expect(panel(page)).toContainText(
    "아직 요청한 NASA 행성 자료가 없습니다.",
  );
  expect(reads).toBe(1);
  expect(writes).toBe(0);
  await panel(page).getByRole("button", { name: "NASA 자료 요청" }).click();
  await expect(panel(page)).toContainText("TOI-700 b를 알아볼까요?");
  await expect(panel(page)).toContainText("0.91 지구 반지름 미만");
  await expect(
    panel(page).getByRole("link", { name: "NASA Exoplanet Archive (PS)" }),
  ).toHaveAttribute("href", "https://exoplanetarchive.ipac.caltech.edu/");
  expect(writes).toBe(1);
  await page.screenshot({
    path: "test-results/detail/268-planet.png",
    fullPage: true,
  });
  await panel(page)
    .locator(".planet-explanation-text")
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/detail/268-explanation.png",
    fullPage: true,
  });
  await panel(page)
    .getByRole("button", { name: "행성 2 fixture-204-p-1" })
    .click();
  await expect(panel(page)).toContainText(
    "아직 확인되지 않은 후보에는 NASA 확정 행성 설명이 없습니다.",
  );
  await expect(
    panel(page).getByRole("button", { name: "NASA 행성 자료 보기" }),
  ).toHaveCount(0);
});

test("NASA facts remain visible when explanation fails, and the latest read can recover", async ({
  page,
  request,
}) => {
  const star = await (await request.get("/api/v1/me/stars/900000001")).json();
  let recovered = false;
  await page.route(
    "**/api/v1/me/stars/900000001/planet-explanations",
    async (route) => {
      const items = star.planets.items.map(
        (planet: { candidateId: string; kind: string }) => ({
          candidateId: planet.candidateId,
          kind: planet.kind,
          status:
            planet.kind === "unconfirmed"
              ? "not_applicable"
              : planet.candidateId === "fixture-204-p-0"
                ? recovered
                  ? "ready"
                  : "failed"
                : "not_requested",
          content:
            planet.candidateId === "fixture-204-p-0" && recovered
              ? {
                  name: "행성 설명",
                  orbitalPeriod: "주기 설명",
                  radius: "반지름 설명",
                  mass: "질량 설명",
                  discovery: "발견 설명",
                }
              : null,
          facts:
            planet.candidateId === "fixture-204-p-0"
              ? {
                  planetName: "TOI-700 b",
                  orbitalPeriod: { value: "9.97", limit: 0, unit: "days" },
                  radius: { value: "0.91", limit: 0, unit: "earth_radius" },
                  mass: null,
                  discoveryMethod: null,
                  discoveryYear: null,
                  controversial: null,
                  sourceTable: "ps",
                  sourceUrl: "https://exoplanetarchive.ipac.caltech.edu/",
                }
              : null,
          sourceStatus:
            planet.candidateId === "fixture-204-p-0" ? "ready" : null,
          fetchedAt:
            planet.candidateId === "fixture-204-p-0"
              ? "2026-09-25T05:20:00Z"
              : null,
          refreshStatus:
            planet.candidateId === "fixture-204-p-0" ? "timeout" : null,
          generatedAt:
            recovered && planet.candidateId === "fixture-204-p-0"
              ? "2026-09-25T05:21:00Z"
              : null,
          retryAt: null,
          failure: null,
        }),
      );
      await route.fulfill({
        json: { ticId: star.ticId, version: star.version, items },
      });
    },
  );
  await ready(page);
  await select(page);
  await panel(page)
    .getByRole("button", { name: "행성 1 fixture-204-p-0" })
    .click();
  await panel(page)
    .getByRole("button", { name: "NASA 행성 자료 보기" })
    .click();
  await expect(panel(page)).toContainText(
    "NASA 자료는 유지되지만 쉬운 설명을 만들지 못했습니다.",
  );
  await expect(panel(page)).toContainText("저장 자료를 표시합니다.");
  await expect(panel(page)).toContainText("9.97일");
  recovered = true;
  await panel(page).getByRole("button", { name: "상태 다시 확인" }).click();
  await expect(panel(page)).toContainText("행성 설명");
});

test("missing NASA records, unresolved identity and temporary outage have distinct actions", async ({
  page,
  request,
}) => {
  const star = await (await request.get("/api/v1/me/stars/900000001")).json();
  let sourceStatus = "not_found";
  let refreshStatus: string | null = null;
  let rechecks = 0;
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      json: { headerName: "X-CSRF-TOKEN", token: "fixture-268" },
    }),
  );
  await page.route(
    "**/api/v1/me/stars/900000001/planet-explanations",
    async (route) => {
      if (route.request().method() === "POST") {
        rechecks++;
        expect(route.request().postDataJSON()).toEqual({
          candidateId: "fixture-204-p-0",
        });
      }
      await route.fulfill({
        json: {
          ticId: star.ticId,
          version: star.version,
          items: star.planets.items.map(
            (planet: { candidateId: string; kind: string }) => ({
              candidateId: planet.candidateId,
              kind: planet.kind,
              status:
                planet.kind === "unconfirmed"
                  ? "not_applicable"
                  : "source_unavailable",
              content: null,
              facts: null,
              sourceStatus: planet.kind === "unconfirmed" ? null : sourceStatus,
              fetchedAt: null,
              refreshStatus,
              generatedAt: null,
              retryAt: null,
              failure: null,
            }),
          ),
        },
      });
    },
  );
  await ready(page);
  await select(page);
  await panel(page)
    .getByRole("button", { name: "행성 1 fixture-204-p-0" })
    .click();
  await panel(page)
    .getByRole("button", { name: "NASA 행성 자료 보기" })
    .click();
  await expect(panel(page)).toContainText("실제 행성이 없다는 뜻은 아닙니다.");
  await expect(
    panel(page).getByRole("button", { name: "NASA 자료 재확인" }),
  ).toBeVisible();
  await expect(panel(page)).toContainText(
    "재확인해도 같은 결과가 나올 수 있습니다.",
  );
  await panel(page).getByRole("button", { name: "NASA 자료 재확인" }).click();
  await expect.poll(() => rechecks).toBe(1);
  sourceStatus = "identity_unresolved";
  await panel(page).getByRole("button", { name: "상태 다시 확인" }).click();
  await expect(panel(page)).toContainText("연결을 확인해야 합니다.");
  await panel(page).getByRole("button", { name: "NASA 자료 재확인" }).click();
  await expect.poll(() => rechecks).toBe(2);
  sourceStatus = "temporarily_unavailable";
  await panel(page).getByRole("button", { name: "상태 다시 확인" }).click();
  await expect(panel(page)).toContainText(
    "일시적으로 NASA 자료를 확인하지 못했습니다.",
  );
  await expect(
    panel(page).getByRole("button", { name: "자료 다시 요청" }),
  ).toBeVisible();
  refreshStatus = "disabled";
  await panel(page).getByRole("button", { name: "상태 다시 확인" }).click();
  await expect(panel(page)).toContainText("운영 설정으로 중지돼 있습니다.");
  await expect(
    panel(page).getByRole("button", { name: "자료 다시 요청" }),
  ).toHaveCount(0);
  sourceStatus = "not_eligible";
  await panel(page).getByRole("button", { name: "상태 다시 확인" }).click();
  await expect(panel(page)).toContainText("현재 NASA 설명 대상이 아닙니다.");
  await expect(
    panel(page).getByRole("button", { name: "별 정보 다시 불러오기" }),
  ).toBeVisible();
});

test("lost POST response is reconciled with GET without a second generation request", async ({
  page,
  request,
}) => {
  const star = await (await request.get("/api/v1/me/stars/900000001")).json();
  let reads = 0,
    writes = 0;
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      json: {
        headerName: "X-CSRF-TOKEN",
        token: "fixture-268",
      },
    }),
  );
  await page.route(
    "**/api/v1/me/stars/900000001/planet-explanations",
    async (route) => {
      if (route.request().method() === "POST") {
        writes++;
        await route.abort("failed");
        return;
      }
      reads++;
      await route.fulfill({
        json: {
          ticId: star.ticId,
          version: star.version,
          items: star.planets.items.map(
            (planet: { candidateId: string; kind: string }) => ({
              candidateId: planet.candidateId,
              kind: planet.kind,
              status:
                planet.kind === "unconfirmed"
                  ? "not_applicable"
                  : planet.candidateId === "fixture-204-p-0" && writes
                    ? "ready"
                    : "not_requested",
              content:
                planet.candidateId === "fixture-204-p-0" && writes
                  ? {
                      name: "저장된 설명",
                      orbitalPeriod: "주기",
                      radius: "반지름",
                      mass: "질량",
                      discovery: "발견",
                    }
                  : null,
              facts:
                planet.candidateId === "fixture-204-p-0" && writes
                  ? {
                      planetName: "TOI-700 b",
                      orbitalPeriod: null,
                      radius: null,
                      mass: null,
                      discoveryMethod: null,
                      discoveryYear: null,
                      controversial: null,
                      sourceTable: "ps",
                      sourceUrl: "https://exoplanetarchive.ipac.caltech.edu/",
                    }
                  : null,
              sourceStatus:
                planet.kind === "unconfirmed"
                  ? null
                  : planet.candidateId === "fixture-204-p-0" && writes
                    ? "ready"
                    : "not_requested",
              fetchedAt: null,
              refreshStatus: null,
              generatedAt: null,
              retryAt: null,
              failure: null,
            }),
          ),
        },
      });
    },
  );
  await ready(page);
  await select(page);
  await panel(page)
    .getByRole("button", { name: "행성 1 fixture-204-p-0" })
    .click();
  await panel(page)
    .getByRole("button", { name: "NASA 행성 자료 보기" })
    .click();
  await expect(panel(page)).toContainText(
    "아직 요청한 NASA 행성 자료가 없습니다.",
  );
  await panel(page).getByRole("button", { name: "NASA 자료 요청" }).click();
  await expect(panel(page)).toContainText("저장된 설명");
  expect(reads).toBe(2);
  expect(writes).toBe(1);
});

test("a transient daily limit still blocks repeated clicks after a read", async ({
  page,
  request,
}) => {
  const star = await (await request.get("/api/v1/me/stars/900000001")).json();
  const retryAt = "2099-01-01T00:00:00Z";
  let writes = 0;
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({
      json: {
        headerName: "X-CSRF-TOKEN",
        token: "fixture-268",
      },
    }),
  );
  await page.route(
    "**/api/v1/me/stars/900000001/planet-explanations",
    async (route) => {
      const quota = route.request().method() === "POST";
      if (quota) writes++;
      await route.fulfill({
        json: {
          ticId: star.ticId,
          version: star.version,
          items: star.planets.items.map(
            (planet: { candidateId: string; kind: string }) => ({
              candidateId: planet.candidateId,
              kind: planet.kind,
              status:
                planet.kind === "unconfirmed"
                  ? "not_applicable"
                  : planet.candidateId === "fixture-204-p-0" && quota
                    ? "quota_exceeded"
                    : "not_requested",
              content: null,
              facts:
                planet.candidateId === "fixture-204-p-0"
                  ? {
                      planetName: "TOI-700 b",
                      orbitalPeriod: null,
                      radius: null,
                      mass: null,
                      discoveryMethod: null,
                      discoveryYear: null,
                      controversial: null,
                      sourceTable: "ps",
                      sourceUrl: "https://exoplanetarchive.ipac.caltech.edu/",
                    }
                  : null,
              sourceStatus:
                planet.kind === "unconfirmed"
                  ? null
                  : planet.candidateId === "fixture-204-p-0"
                    ? "ready"
                    : "not_requested",
              fetchedAt:
                planet.candidateId === "fixture-204-p-0"
                  ? "2026-09-25T05:20:00Z"
                  : null,
              refreshStatus: null,
              generatedAt: null,
              retryAt:
                quota && planet.candidateId === "fixture-204-p-0"
                  ? retryAt
                  : null,
              failure:
                quota && planet.candidateId === "fixture-204-p-0"
                  ? "daily_limit"
                  : null,
            }),
          ),
        },
      });
    },
  );
  await ready(page);
  await select(page);
  await panel(page)
    .getByRole("button", { name: "행성 1 fixture-204-p-0" })
    .click();
  await panel(page)
    .getByRole("button", { name: "NASA 행성 자료 보기" })
    .click();
  await panel(page).getByRole("button", { name: "쉬운 설명 요청" }).click();
  await expect(panel(page)).toContainText(
    "현재 쉬운 설명 요청 한도에 도달했습니다.",
  );
  await panel(page).getByRole("button", { name: "상태 다시 확인" }).click();
  await expect(panel(page)).toContainText("설명 요청 한도로");
  await expect(
    panel(page).getByRole("button", { name: "쉬운 설명 요청" }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
});

test("late NASA response for another star cannot enter the current detail", async ({
  page,
  request,
}) => {
  const star = await (await request.get("/api/v1/me/stars/900000001")).json();
  let release!: () => void,
    requested = false;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/v1/me/stars/900000001/planet-explanations",
    (route) => {
      requested = true;
      void released.then(() =>
        route
          .fulfill({
            json: {
              ticId: star.ticId,
              version: star.version,
              items: star.planets.items.map(
                (planet: { candidateId: string; kind: string }) => ({
                  candidateId: planet.candidateId,
                  kind: planet.kind,
                  status:
                    planet.kind === "confirmed" ? "ready" : "not_applicable",
                  content:
                    planet.kind === "confirmed"
                      ? {
                          name: "이전 별의 행성 설명",
                          orbitalPeriod: "주기",
                          radius: "반지름",
                          mass: "질량",
                          discovery: "발견",
                        }
                      : null,
                  facts: null,
                  sourceStatus: null,
                  fetchedAt: null,
                  refreshStatus: null,
                  generatedAt: null,
                  retryAt: null,
                  failure: null,
                }),
              ),
            },
          })
          .catch(() => {}),
      );
    },
  );
  await ready(page);
  await select(page);
  await panel(page)
    .getByRole("button", { name: "행성 1 fixture-204-p-0" })
    .click();
  await panel(page)
    .getByRole("button", { name: "NASA 행성 자료 보기" })
    .click();
  await expect(panel(page)).toContainText(
    "NASA 행성 자료를 확인하고 있습니다.",
  );
  await expect.poll(() => requested).toBe(true);
  await page.getByText("별 목록으로 선택하기", { exact: true }).click();
  await page
    .locator('.discovered-rows button[data-tic-id="900000002"]')
    .click();
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText(
    "TIC 900000002",
  );
  release();
  await expect(panel(page)).not.toContainText("이전 별의 행성 설명");
});
test("same canvas focuses all five owned planets, reads values, and exactly restores the rotated camera", async ({
  page,
}) => {
  await ready(page);
  const originalCanvas = await canvas(page).elementHandle();
  await canvas(page).focus();
  await canvas(page).press("Shift+ArrowRight");
  await canvas(page).press("ArrowLeft");
  await canvas(page).press("+");
  const before = await camera(page);
  await select(page);
  expect(await originalCanvas!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "5");
  await expect(panel(page)).toContainText("내 행성 5개");
  await expect(panel(page)).toContainText("인정된 성과 1건");
  await page.screenshot({
    path: "test-results/detail/206-system.png",
    fullPage: true,
  });
  await panel(page)
    .getByRole("button", { name: "행성 1 fixture-204-p-0", exact: true })
    .click();
  await expect(canvas(page)).toHaveAttribute(
    "data-focused-planet",
    "fixture-204-p-0",
  );
  await expect(page.locator(".planet-information")).toContainText("정보 없음");
  await expect(page.locator(".planet-information")).toContainText("0 ppm (0%)");
  await panel(page)
    .getByRole("button", { name: "행성 2 fixture-204-p-1", exact: true })
    .click();
  await expect(page.locator(".planet-information")).toContainText("5.25일");
  await expect(page.locator(".planet-information")).toContainText(
    "400 ppm (0.04%)",
  );
  await page.screenshot({
    path: "test-results/detail/206-planet.png",
    fullPage: true,
  });
  await panel(page)
    .getByRole("button", { name: "항성계", exact: true })
    .click();
  await expect(canvas(page)).toHaveAttribute("data-focused-planet", "");
  await panel(page).getByRole("button", { name: "별지도" }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(await camera(page)).toEqual(before);
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "0");
});
test("prototype body hit matches candidate; empty sky keeps detail until explicit return, keyboard list works", async ({
  page,
}) => {
  await ready(page);
  const before = await camera(page);
  await select(page);
  const box = (await canvas(page).boundingBox())!;
  await page
    .getByRole("button", { name: "행성 1 가까이 보기", exact: true })
    .click();
  await expect(canvas(page)).toHaveAttribute(
    "data-focused-planet",
    "fixture-204-p-0",
  );
  await page.mouse.click(box.x + 15, box.y + 160);
  await expect(panel(page)).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "별지도", exact: false })
    .click();
  await expect(panel(page)).toHaveCount(0);
  expect(await camera(page)).toEqual(before);
  await page.getByText("별 목록으로 선택하기", { exact: true }).click();
  await expect(
    page.locator('.discovered-rows button[data-tic-id="900000002"]'),
  ).toHaveCount(1);
  const choice = page.locator(
    '.discovered-rows button[data-tic-id="900000002"]',
  );
  await choice.focus();
  await choice.press("Enter");
  await expect(panel(page)).toContainText("아직 표시할 내 행성이 없어요");
  await panel(page).getByRole("heading", { level: 2 }).press("Escape");
  await expect(choice).toBeFocused();
});
test("actions use server flags, routes preserve TIC and return refetches detail/quests/tiles/meta", async ({
  page,
}) => {
  const counts = { meta: 0, tiles: 0, quests: 0, detail: 0 };
  page.on("request", (req) => {
    const p = new URL(req.url()).pathname;
    if (p === "/api/v1/me/sky") counts.meta++;
    if (p.endsWith("/tiles")) counts.tiles++;
    if (p.endsWith("/quests")) counts.quests++;
    if (p.endsWith("/stars/900000001")) counts.detail++;
  });
  await ready(page);
  await select(page);
  await expect(
    panel(page).getByRole("button", { name: "분석 결과 보기" }),
  ).toBeDisabled();
  const before = { ...counts };
  await panel(page)
    .getByRole("link", { name: /분석 시작/ })
    .click();
  await expect(page).toHaveURL(/\/analysis\/900000001\?returnTo=/);
  await expect(
    page.getByRole("heading", { name: "분석 · TIC 900000001", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "← 이전 화면", exact: true }).click();
  await expect(panel(page)).toContainText("내 행성 5개");
  for (const key of Object.keys(counts) as (keyof typeof counts)[])
    expect(counts[key]).toBeGreaterThan(before[key]);
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    const response = await route.fetch(),
      json = await response.json();
    json.actions = {
      analysis: "review",
      resultAvailable: true,
      boardOpen: false,
      threadCount: 0,
    };
    await route.fulfill({ json });
  });
  await page.reload();
  await expect(
    panel(page).getByRole("link", { name: /분석 다시 보기/ }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "별 게시판 잠김" }),
  ).toBeDisabled();
  await panel(page).getByRole("link", { name: "분석 결과 보기" }).click();
  await expect(page).toHaveURL(/\/results\/900000001\?returnTo=/);
});
test("locked, delayed, stale A and failed responses never masquerade as an empty owned list", async ({
  page,
}) => {
  let finishA: (() => void) | undefined;
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    const response = await route.fetch();
    await new Promise<void>((r) => {
      finishA = r;
    });
    await route.fulfill({ response }).catch(() => {});
  });
  await ready(page);
  await page.locator('.galaxy-marker[data-marker="1"]').click();
  await expect(panel(page)).toContainText("불러오고 있습니다");
  await expect(panel(page)).not.toContainText("아직 표시할 내 행성");
  await page.getByText("별 목록으로 선택하기", { exact: true }).click();
  await expect(
    page.locator('.discovered-rows button[data-tic-id="900000002"]'),
  ).toHaveCount(1);
  await page
    .locator('.discovered-rows button[data-tic-id="900000002"]')
    .click();
  await expect(panel(page)).toContainText("아직 표시할 내 행성이 없어요");
  finishA?.();
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText(
    "TIC 900000002",
  );
  await page.goto("/sky?star=999999999");
  await expect(panel(page)).toContainText("아직 발견하지 않은 별이에요");
  await expect(
    panel(page).getByRole("link", { name: /분석 시작/ }),
  ).toHaveCount(0);
  await panel(page).getByRole("button", { name: "별지도" }).click();
  await page.unroute("**/api/v1/me/stars/900000001");
});
test("malformed count/duplicates fail closed and retry loads valid detail; null catalogue stays unknown", async ({
  page,
}) => {
  let bad = "count";
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    const response = await route.fetch(),
      json = await response.json();
    if (bad === "count") json.planets.count = 6;
    if (bad === "duplicate") json.planets.items[1] = json.planets.items[0];
    json.progress.currentCurveStep = null;
    await route.fulfill({ json });
  });
  await page.goto("/sky?star=900000001");
  await expect(panel(page).getByRole("alert")).toBeVisible();
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "0");
  bad = "duplicate";
  await panel(page)
    .getByRole("button", { name: "별 정보 다시 불러오기" })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("중복");
  bad = "none";
  await panel(page)
    .getByRole("button", { name: "별 정보 다시 불러오기" })
    .click();
  await expect(panel(page)).toContainText("내 행성 5개");
  await panel(page).getByText("관측·발견 정보", { exact: true }).click();
  await expect(page.locator(".star-observations")).toContainText("정보 없음");
});
test("version mismatch refreshes once and never renders stale planets", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    reads++;
    const response = await route.fetch(),
      json = await response.json();
    json.version = "stale-detail";
    await route.fulfill({ json });
  });
  await page.goto("/sky?star=900000001");
  await expect(panel(page).getByRole("alert")).toBeVisible();
  // StrictMode may dispatch an initial request before aborting its mount probe.
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(reads).toBeLessThanOrEqual(3);
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "0");
});
test("1024px docking never overlaps canvas and WebGL failure keeps detail, planets and analysis accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      options?: unknown,
    ) {
      return type === "webgl2"
        ? null
        : original.call(this, type as "2d", options);
    } as typeof original;
  });
  await page.goto("/sky?star=900000001");
  await expect(panel(page)).toContainText("내 행성 5개");
  await expect(
    page.getByRole("heading", { name: "발견한 별 목록" }),
  ).toBeVisible();
  const c = (await page.locator(".discovered-stars").boundingBox())!,
    p = (await panel(page).boundingBox())!;
  expect(p.x + p.width).toBeLessThanOrEqual(c.x + 1);
  await panel(page)
    .getByRole("button", { name: "행성 5 fixture-204-p-4", exact: true })
    .click();
  await expect(page.locator(".planet-information")).toContainText(
    "fixture-204-p-4",
  );
  await panel(page)
    .getByRole("link", { name: /분석 시작/ })
    .click();
  await expect(page).toHaveURL(/\/analysis\/900000001/);
});

test("session expiration removes an in-flight private detail and late data cannot restore it", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  await page.route("**/api/v1/me/stars/900000001", async (route) => {
    const response = await route.fetch();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response }).catch(() => {});
  });
  await page.route("**/api/v1/me/stars/900000002", (route) =>
    route.fulfill({
      status: 401,
      json: { code: "UNAUTHENTICATED", message: "세션이 만료되었습니다." },
    }),
  );
  await ready(page);
  await page.locator('.galaxy-marker[data-marker="1"]').click();
  await expect(panel(page)).toContainText("불러오고 있습니다");
  await page.getByText("별 목록으로 선택하기", { exact: true }).click();
  await expect(
    page.locator('.discovered-rows button[data-tic-id="900000002"]'),
  ).toHaveCount(1);
  await page
    .locator('.discovered-rows button[data-tic-id="900000002"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  release?.();
  await expect(panel(page)).toHaveCount(0);
  await expect(canvas(page)).toHaveCount(0);
});

test("successful change notification refreshes metadata, pages, quests and selected detail without awarding client achievements", async ({
  page,
  request,
}) => {
  let questReads = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.endsWith("/quests")) questReads++;
  });
  await ready(page);
  await select(page);
  const before = await camera(page),
    questsBefore = questReads;
  const response = await request.post("/api/dev-galaxy-204/status"),
    change = await response.json();
  await page.evaluate(async (change) => {
    const modulePath = "/src/features/sky-data/events.ts";
    const { publishSkyChange } = await import(modulePath);
    publishSkyChange("galaxy-fixture-204-member", change);
  }, change);
  await expect(panel(page)).toContainText("아직 표시할 내 행성이 없어요");
  await expect(panel(page)).toContainText("인정된 성과 0건");
  await expect(canvas(page)).toHaveAttribute("data-rendered-planets", "0");
  expect(questReads).toBeGreaterThan(questsBefore);
  expect(await camera(page)).toEqual(before);
});
