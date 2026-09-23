import { test, expect, type Page } from "@playwright/test";
import { quests, current } from "./fixtures";
import {
  challengeSeenKey,
  type Quests,
  type CurrentChallenge,
} from "../../src/features/quests/contracts";
const member = "galaxy-fixture-204-member";
const tutorial = (p: Page) => p.locator(".quest-tutorial");
const challenge = (p: Page) => p.locator(".quest-challenge");
async function notify(
  page: Page,
  reason: "submission" | "tutorial-skipped" | "guide-closed" = "submission",
  owner = member,
) {
  await page.evaluate(
    async ({ reason, owner }) => {
      const modulePath = "/src/features/quests/events.ts";
      const { publishQuestChange } = await import(modulePath);
      publishQuestChange(owner, { reason });
    },
    { reason, owner },
  );
}
test.beforeEach(async ({ request }) => {
  await request.post("/api/dev-galaxy-204/reset?count=1000");
});
test("independently collapsed regions, all five goals, locked target privacy, selected TIC/camera and return", async ({
  page,
}) => {
  await page.route("**/api/v1/me/quests", (r) => r.fulfill({ json: quests() }));
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ json: current(false) }),
  );
  await page.goto("/sky");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await expect(
    challenge(page).locator(":scope > summary:first-child"),
  ).toHaveCount(1);
  await expect(tutorial(page).locator("summary")).toContainText("0 / 5");
  expect(await tutorial(page).getAttribute("open")).toBeNull();
  expect(await challenge(page).getAttribute("open")).toBeNull();
  await expect(page.locator("canvas")).toHaveAttribute(
    "data-rendered-stars",
    "1000",
  );
  await page.screenshot({
    path: test.info().outputPath("208-collapsed.png"),
    fullPage: true,
  });
  await tutorial(page).locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(tutorial(page).getByRole("button")).toHaveCount(5);
  await expect(tutorial(page).getByRole("button").nth(1)).toBeDisabled();
  await expect(tutorial(page)).not.toContainText("900000002");
  await expect(tutorial(page)).toContainText("남은 곡선에서 반복 탐색");
  expect(await challenge(page).getAttribute("open")).toBeNull();
  await page.screenshot({
    path: test.info().outputPath("208-tutorial.png"),
    fullPage: true,
  });
  await tutorial(page).getByRole("button").first().click();
  await expect(page).toHaveURL(/star=900000001/);
  await expect(
    page.getByRole("complementary", { name: "별 상세" }),
  ).toContainText("TIC 900000001");
  await page.getByRole("button", { name: "별지도" }).click();
  await expect(
    page.getByRole("button", { name: "퀘스트", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", {
      name: /다음 튜토리얼로|건너뛰기/,
      exact: false,
    }),
  ).toHaveCount(0);
});
test("server progress 1→5 and skip, badge retirement, reopening and same-version refresh share one source", async ({
  page,
}) => {
  let q = quests(),
    c = current(false);
  await page.route("**/api/v1/me/quests", (r) => r.fulfill({ json: q }));
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ json: c }),
  );
  await page.goto("/sky");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await tutorial(page).locator("summary").click();
  for (let done = 1; done <= 5; done++) {
    q = quests(done, done === 2);
    if (done === 5) c = current();
    await notify(page, done === 2 ? "tutorial-skipped" : "submission");
    await expect(tutorial(page).locator("summary")).toContainText(
      `${done} / 5`,
    );
    await expect(
      page.locator(`.galaxy-marker[data-marker="${done}"]:visible`),
    ).toHaveCount(0);
    if (done < 5)
      await expect(tutorial(page).getByRole("button").nth(done)).toBeEnabled();
    if (done === 2) await expect(tutorial(page)).toContainText("건너뛰기 완료");
  }
  await challenge(page).locator("summary").click();
  await expect(
    challenge(page).getByRole("link", { name: "챌린지 별 분석하기" }),
  ).toBeVisible();
  q.reopened = [
    { ticId: "900000001", reopenedAt: q.asOf, newDiscoverableCount: null },
  ];
  await notify(page);
  await page.locator(".quest-reopened summary").click();
  await expect(page.locator(".quest-reopened")).toContainText(
    "새 자료 확인하기",
  );
  await expect(page.locator(".quest-reopened")).not.toContainText("신호 0개");
  await expect(tutorial(page).locator("summary")).toContainText("5 / 5");
  await expect(
    page.locator('.galaxy-marker[data-marker="1"]:visible'),
  ).toHaveCount(0);
  q.reopened = [];
  await notify(page);
  await expect(page.locator(".quest-reopened")).toHaveCount(0);
});
test("guide closure and another member's events do not advance tutorials or write APIs", async ({
  page,
}) => {
  let reads = 0;
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/") && r.method() !== "GET")
      writes.push(r.method() + r.url());
  });
  await page.route("**/api/v1/me/quests", (r) => {
    reads++;
    return r.fulfill({ json: quests() });
  });
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ json: current(false) }),
  );
  await page.goto("/sky");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await expect(tutorial(page).locator("summary")).toContainText("0 / 5");
  const before = reads;
  await notify(page, "guide-closed");
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(tutorial(page).locator("summary")).toContainText("0 / 5");
  const after = reads;
  await notify(page, "submission", "different-member");
  await expect(tutorial(page).locator("summary")).toContainText("0 / 5");
  expect(reads).toBe(after);
  expect(writes).toEqual([]);
});
test("round notice is stored after visible paint, once per member/round, new round and closed round", async ({
  page,
}) => {
  let q = quests(5),
    c = current();
  await page.route("**/api/v1/me/quests", (r) => r.fulfill({ json: q }));
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ json: c }),
  );
  // Observation at setItem verifies that a real visible notice exists at the write, not at GET.
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    (window as any).noticeWrites = [];
    Storage.prototype.setItem = function (k, v) {
      if (k.startsWith("planetory.challenge")) {
        const e = document.querySelector(".quest-round-notice");
        const r = e?.getBoundingClientRect();
        (window as any).noticeWrites.push(
          !!r && r.height > 0 && r.top < innerHeight && !document.hidden,
        );
      }
      return set.call(this, k, v);
    };
  });
  await page.goto("/sky");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await expect(page.locator(".quest-round-notice")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((k) => localStorage.getItem(k), challengeSeenKey(member)),
    )
    .toBe("cr-208");
  expect(await page.evaluate(() => (window as any).noticeWrites)).toEqual([
    true,
  ]);
  await page.reload();
  await expect(tutorial(page).locator("summary")).toContainText("5 / 5");
  await expect(page.locator(".quest-round-notice")).toHaveCount(0);
  c = { ...c, round: { ...c.round!, roundId: "cr-209", roundNo: 3 } };
  q = {
    ...q,
    challenge: {
      ...q.challenge,
      round: { ...q.challenge.round!, roundId: "cr-209", roundNo: 3 },
    },
  };
  await notify(page);
  await expect(page.locator(".quest-round-notice")).toContainText("3회차");
  await page.getByRole("button", { name: "챌린지 보기", exact: true }).click();
  await expect(challenge(page).locator("summary")).toBeFocused();
  c = { round: null, eligible: false, participantCount: null };
  q = {
    ...q,
    challenge: {
      round: null,
      eligible: false,
      unlocked: false,
      ticId: null,
      progressStage: null,
      participantCount: null,
    },
  };
  await notify(page);
  await expect(challenge(page)).toContainText(
    "현재 진행 중인 챌린지가 없습니다",
  );
  await expect(page.locator(".quest-round-notice")).toHaveCount(0);
  await expect(
    page.locator('.galaxy-marker[data-marker="!"]:visible'),
  ).toHaveCount(0);
});
test("storage disabled still permits challenge; details contain period/TIC/count and analysis return", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
  });
  await page.route("**/api/v1/me/quests", (r) =>
    r.fulfill({ json: quests(5) }),
  );
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ json: current() }),
  );
  await page.goto("/sky?view=list");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await expect(page.locator(".quest-round-notice")).toBeVisible();
  await challenge(page).locator("summary").click();
  await expect(challenge(page)).toContainText("2026-09-14");
  await expect(challenge(page)).toContainText("TIC 900000006");
  await expect(challenge(page)).toContainText("12명");
  await challenge(page)
    .getByRole("link", { name: "챌린지 별 분석하기" })
    .click();
  await expect(page).toHaveURL(/analysis\/900000006/);
  expect(decodeURIComponent(page.url())).toContain("view=list");
});
test("partial failure/retry and denied target stay safe; no fake round notice or completion", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/v1/me/quests", (r) =>
    fail
      ? r.fulfill({
          status: 503,
          json: { code: "DEPENDENCY_UNAVAILABLE", message: "test" },
        })
      : r.fulfill({ json: quests() }),
  );
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "test" } }),
  );
  await page.goto("/sky?view=list");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await expect(page.locator(".discovered-rows button")).toHaveCount(20);
  await tutorial(page).locator("summary").click();
  await expect(tutorial(page)).toContainText("불러오지 못했습니다");
  fail = false;
  await tutorial(page)
    .getByRole("button", { name: "퀘스트 다시 불러오기" })
    .click();
  await expect(tutorial(page).locator("summary")).toContainText("0 / 5");
  await challenge(page).locator("summary").click();
  await expect(challenge(page)).toContainText("튜토리얼 다섯 별");
  await expect(challenge(page).getByRole("link")).toHaveCount(0);
  await expect(page.locator(".quest-round-notice")).toHaveCount(0);
});
test("eligible but not discovered stays pending; round API does not grant selection", async ({
  page,
}) => {
  const q = quests(5);
  q.challenge.unlocked = false;
  q.challenge.ticId = null;
  q.challenge.progressStage = null;
  await page.route("**/api/v1/me/quests", (r) => r.fulfill({ json: q }));
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ json: current() }),
  );
  await page.goto("/sky");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await challenge(page).locator("summary").click();
  await expect(challenge(page)).toContainText("대상 별이 열리기를 기다리고");
  await expect(challenge(page).getByRole("link")).toHaveCount(0);
});

test("hidden tab never records the notice until it becomes visible", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).questHidden = true;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => (window as any).questHidden,
    });
  });
  await page.route("**/api/v1/me/quests", (r) =>
    r.fulfill({ json: quests(5) }),
  );
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ json: current() }),
  );
  await page.goto("/sky");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await expect(page.locator(".quest-round-notice")).toBeVisible();
  expect(
    await page.evaluate(
      (k) => localStorage.getItem(k),
      challengeSeenKey(member),
    ),
  ).toBeNull();
  await page.evaluate(() => {
    (window as any).questHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() =>
      page.evaluate((k) => localStorage.getItem(k), challengeSeenKey(member)),
    )
    .toBe("cr-208");
});

test("service round closure hides stale challenge action and marker until quests catch up", async ({
  page,
}) => {
  const c = current();
  c.eligible = false;
  c.round!.status = "closed";
  c.round!.ticId = null;
  await page.route("**/api/v1/me/quests", (r) =>
    r.fulfill({ json: quests(5) }),
  );
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ json: c }),
  );
  await page.goto("/sky");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await challenge(page).locator("summary").click();
  await expect(challenge(page)).toContainText("회차가 변경되었습니다");
  await expect(challenge(page).getByRole("link")).toHaveCount(0);
  await expect(
    page.locator('.galaxy-marker[data-marker="!"]:visible'),
  ).toHaveCount(0);
});

test("late old read cannot undo completed state and foreground return refreshes without changing camera", async ({
  page,
}) => {
  let delayed = false,
    completed = 0,
    release: (() => void) | undefined,
    calls = 0;
  await page.route("**/api/v1/me/quests", async (route) => {
    calls++;
    if (delayed) {
      delayed = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ json: quests(0) }).catch(() => {});
    } else await route.fulfill({ json: quests(completed) });
  });
  await page.route("**/api/v1/challenges/current", (r) =>
    r.fulfill({ json: current(false) }),
  );
  await page.goto("/sky");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await expect(tutorial(page).locator("summary")).toContainText("0 / 5");
  await expect(page.locator("canvas")).not.toHaveAttribute(
    "data-camera",
    "null",
  );
  const camera = await page.locator("canvas").getAttribute("data-camera");
  delayed = true;
  await notify(page);
  await expect.poll(() => !!release).toBe(true);
  completed = 2;
  await notify(page);
  await expect(tutorial(page).locator("summary")).toContainText("2 / 5");
  release!();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => calls).toBeGreaterThan(3);
  await expect(tutorial(page).locator("summary")).toContainText("2 / 5");
  expect(await page.locator("canvas").getAttribute("data-camera")).toBe(camera);
});

test("tab return events and polling do not replace an in-flight quest read", async ({
  page,
}) => {
  let requests = 0,
    hold = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/me/quests", async (route) => {
    requests++;
    if (hold) await barrier;
    await route.fulfill({ json: quests() });
  });
  await page.route("**/api/v1/challenges/current", (route) =>
    route.fulfill({ json: current(false) }),
  );
  await page.goto("/sky");
  await page.getByRole("button", { name: "퀘스트", exact: true }).click();
  await expect(tutorial(page).locator("summary")).toContainText("0 / 5");
  const initial = requests;
  hold = true;
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => requests).toBe(initial + 1);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(150);
  expect(requests).toBe(initial + 1);
  release();
  await expect(tutorial(page).locator("summary")).toContainText("0 / 5");
});
