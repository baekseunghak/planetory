import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  cinemaFixturePlugin,
  CINEMA_CSRF,
  CINEMA_SESSION_COOKIE,
} from "../../dev/cinema-fixture-plugin";
import { DEMO_MEMBERS } from "../../dev/cinema-scenarios";
import {
  REAL_SAMPLE_FORMAT,
  type RealCandidate,
  type RealSample,
  type RealSampleStar,
} from "../../dev/real-sample";
import { decodeSubmissionReceipt } from "../../src/features/analysis/submission-data";
import {
  readSkyMeta,
  readSkyTiles,
} from "../../src/features/sky-data/contracts";
import {
  publicTiles,
  readPublicMeta,
  readPublicSystem,
} from "../../src/features/public-sky/contracts";
import { readFollowing } from "../../src/features/follow/contracts";
import { readMember } from "../../src/auth/member";
import {
  readMyHistories,
  readMyStars,
} from "../../src/features/my-lists/my-lists-data";
import { readProfile } from "../../src/features/profile/contracts";
import { readStarResult } from "../../src/features/analysis/star-result";
import { readHistoryDetail } from "../../src/features/analysis/history-data";
import { readHistoryGraphView } from "../../src/features/analysis/history-graph";
import {
  readPlanetExplanations,
  readStarDetail,
} from "../../src/features/sky-renderer/detail";
import { readPersonalStatistics } from "../../src/features/statistics/contracts";
import { readGlobalStatistics } from "../../src/features/statistics/global-contracts";
import { readNotices } from "../../src/features/notifications/contracts";

// The demo scenarios of `npm run dev:cinema`, driven through the plugin's
// middleware without HTTP. The sample below is made up in the test (one box
// transit per star on a flat curve), in the real-sample format.
const GRID = { periodMinDays: 0.5, periodMaxDays: 40, nPeriods: 5000 };
const cell = (period: number) =>
  Math.round(
    (Math.log(period / GRID.periodMinDays) /
      Math.log(GRID.periodMaxDays / GRID.periodMinDays)) *
      (GRID.nPeriods - 1),
  );
const REFERENCE = 1330;
function star(
  ticId: string,
  role: RealSampleStar["role"],
  candidate: RealCandidate,
  tutorialSeq?: number,
): RealSampleStar {
  const binMinutes = 10,
    n = 12 * 144,
    startBtjd = 1325;
  const flux = Array.from({ length: n }, (_, i) => {
    const t = startBtjd + (i * binMinutes) / 1440;
    const d = Math.abs(
      t -
        candidate.epochBtjd -
        Math.round((t - candidate.epochBtjd) / candidate.periodDays) *
          candidate.periodDays,
    );
    return d <= candidate.durationHours / 48 ? 1 - candidate.depthPpm / 1e6 : 1;
  });
  const phase =
    ((((candidate.epochBtjd - REFERENCE) / candidate.periodDays) % 1) + 1) % 1;
  return {
    ticId,
    role,
    ...(tutorialSeq ? { tutorialSeq } : {}),
    tmag: 9.3,
    teffK: 5700,
    radiusRsun: 1.01,
    sectors: [3],
    foldReferenceTimeBtjd: REFERENCE,
    segments: [{ sector: 3, startBtjd, binMinutes, flux, fluxScatter: 1e-4 }],
    periodograms: [
      {
        removedCandidateIds: [],
        ...GRID,
        power: Array.from(
          { length: GRID.nPeriods },
          (_, i) =>
            Math.exp(-(((i - cell(candidate.periodDays)) / 6) ** 2)) + 0.02,
        ),
        peaks: [
          {
            rank: 1,
            gridIndex: cell(candidate.periodDays),
            suggestedDurationHours: candidate.durationHours,
            suggestedPhaseCenter: phase,
          },
        ],
      },
    ],
    candidates: [
      {
        ...candidate,
        peaks: [{ gridIndex: cell(candidate.periodDays), multiplier: 1 }],
      },
    ],
  };
}
const planet = (id: string, periodDays: number): RealCandidate => ({
  candidateId: id,
  kind: "confirmed",
  periodDays,
  epochBtjd: 1326.2,
  durationHours: 2.4,
  depthPpm: 5000,
  planetName: `TEST-${id.slice(-2)} b`,
  radiusEarth: 1.7,
  discoveryYear: 2021,
});
const TUTORIALS = [1, 2, 3, 4, 5].map((seq) =>
  star(
    `1500000${seq}0`,
    "tutorial",
    planet(`90071992549000${seq}0`, 2 + seq),
    seq,
  ),
);
const EXPLORE = [1, 2].map((k) =>
  star(`1600000${k}0`, "explore", planet(`90071992549100${k}0`, 3.4 + k)),
);
const SAMPLE: RealSample = {
  format: REAL_SAMPLE_FORMAT,
  generatedAt: "2026-09-26T00:00:00Z",
  source: "unit test (made up)",
  stars: [...TUTORIALS, ...EXPLORE],
};

type Reply = {
  status: number;
  headers: Record<string, string>;
  body: any;
  passed: boolean;
};
function server(options: Parameters<typeof cinemaFixturePlugin>[0] = {}) {
  const fixture = cinemaFixturePlugin(options);
  let handler: any;
  (fixture.plugin.configureServer as any).call(
    {},
    {
      middlewares: { use: (_mount: string, next: unknown) => (handler = next) },
    },
  );
  let session = "member";
  const call = (
    method: string,
    path: string,
    json?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = Readable.from(
        json === undefined ? [] : [JSON.stringify(json)],
      ) as unknown as IncomingMessage;
      Object.assign(req, {
        method,
        url: path,
        headers: {
          cookie: `${CINEMA_SESSION_COOKIE}=${session}`,
          "x-csrf-token": CINEMA_CSRF,
          ...headers,
        },
      });
      const out: Record<string, string> = {};
      let status = 200;
      const res = {
        headersSent: false,
        statusCode: 200,
        setHeader: (k: string, v: string) => (out[k.toLowerCase()] = v),
        removeHeader: () => undefined,
        writeHead(code: number, h: Record<string, string> = {}) {
          status = code;
          for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
          return res;
        },
        write: () => true,
        destroy: () => undefined,
        end(chunk?: string) {
          const text = chunk === undefined ? "" : String(chunk);
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            /* html */
          }
          const cookie = /planetory-cinema-session=(\w+)/.exec(
            out["set-cookie"] ?? "",
          );
          if (cookie) session = cookie[1];
          resolve({ status, headers: out, body, passed: false });
        },
      };
      handler(req, res as unknown as ServerResponse, (error?: unknown) =>
        error
          ? reject(error)
          : resolve({ status: 0, headers: out, body: null, passed: true }),
      );
    });
  return { fixture, call, res: () => undefined };
}

async function submitOverDip(
  call: ReturnType<typeof server>["call"],
  tic: string,
) {
  const context = (await call("GET", `/v1/stars/${tic}/analysis-context`)).body;
  const current = context.currentCurveContext;
  const query = new URLSearchParams({
    bundleId: current.bundleId,
    curveStep: String(current.curveStep),
  });
  const top = (await call("GET", `/v1/stars/${tic}/candidate-peaks?${query}`))
    .body.peaks[0];
  const center = top.suggestedPhaseCenter;
  const half = top.suggestedDurationHours / 24 / top.periodDays;
  const start = center - half < 0 ? center - half + 1 : center - half;
  return call("POST", `/v1/stars/${tic}/submissions`, {
    requestId: randomUUID(),
    submissionKind: "candidate",
    curveContext: current,
    selection: {
      periodDays: top.periodDays,
      sourcePeakGridIndex: top.gridIndex,
      phaseStart: start,
      phaseEnd: start + 2 * half,
    },
    userJudgment: "LIKELY_PLANET",
    evidenceChecks: [],
    memo: "",
  });
}

test("switching builds a fresh world; newcomer starts at the login page", async () => {
  const { call, fixture } = server({ realSample: SAMPLE });
  assert.equal((await call("GET", "/v1/me/sky")).body.starCount, 1000);
  const list = (await call("GET", "/dev-cinema/scenarios")).body;
  assert.deepEqual(
    list.scenarios.map((s: { id: string }) => s.id),
    ["newcomer", "member", "veteran"],
  );
  assert.deepEqual(list.veteranStarOptions, [5000, 10000]);
  assert.deepEqual(list.current.realSample, { loaded: true, stars: 7 });

  const page = await call("GET", "/dev-cinema/session?as=newcomer&start=login");
  assert.equal(page.status, 200);
  assert.match(page.headers["set-cookie"], /=anonymous/);
  assert.match(String(page.body), /planetory:analysis-draft:/);
  assert.match(String(page.body), /location\.replace\("\/login"\)/);
  assert.equal((await call("GET", "/v1/me/sky")).status, 401);
  // The login button signs in to the world that was just built.
  await call("GET", "/dev-cinema/oauth/ssafy");
  const meta = readSkyMeta((await call("GET", "/v1/me/sky")).body);
  assert.equal(meta.starCount, 5);
  const quests = (await call("GET", "/v1/me/quests")).body;
  assert.deepEqual(
    quests.tutorial.items.map((item: { ticId: string }) => item.ticId),
    TUTORIALS.map((s) => s.ticId),
  );
  assert.equal(quests.tutorial.completedCount, 0);
  const me = { memberId: "u-209", nickname: "x", ...fixture.member() };
  assert.equal(readMember(me).onboardingDone, false);
});

test("newcomer: tutorial 1 discovery unlocks the next real star", async () => {
  const { call, fixture } = server({
    realSample: SAMPLE,
    scenario: "newcomer",
  });
  const tic = TUTORIALS[0].ticId;
  const reply = await submitOverDip(call, tic);
  assert.equal(reply.status, 201, JSON.stringify(reply.body).slice(0, 300));
  const receipt = decodeSubmissionReceipt(
    reply.body,
    { ticId: tic, requestId: reply.body.requestId },
    201,
  );
  assert.equal(receipt.matchStatus, "matched");
  assert.equal(reply.body.achievement.result, "recognized");
  assert.equal(reply.body.achievement.unlockedStars[0].ticId, EXPLORE[0].ticId);
  assert.equal(reply.body.progress.stage, "completed");
  assert.ok(Number(reply.body.submissionId.slice(4)) > 7000);

  assert.equal((await call("GET", "/v1/me/sky")).body.starCount, 6);
  assert.equal(
    (await call("GET", "/v1/me/quests")).body.tutorial.completedCount,
    1,
  );
  const member = fixture.member() as any;
  assert.equal(member.onboardingDone, true);
  assert.equal(member.achievementSummary.discoveredStarCount, 6);
  assert.equal(member.achievementSummary.byType.confirmed, 1);
  const detail = (await call("GET", `/v1/me/stars/${tic}`)).body;
  assert.deepEqual(detail.star.sectors, [3]);
  assert.equal(detail.planets.items[0].candidateId, "9007199254900010");
  const unlocked = (await call("GET", `/v1/me/stars/${EXPLORE[0].ticId}`)).body;
  assert.equal(unlocked.unlock.reason, "achievement");
  // The new star reads its own real curve.
  const context = await call(
    "GET",
    `/v1/stars/${EXPLORE[0].ticId}/analysis-context`,
  );
  assert.equal(context.status, 200);
  assert.equal(context.body.ticId, EXPLORE[0].ticId);
  // Stars not unlocked yet stay locked.
  assert.equal(
    (await call("GET", `/v1/stars/${EXPLORE[1].ticId}/analysis-context`))
      .status,
    403,
  );
});

test("veteran: counts in the sky and the summary agree", async () => {
  const { call, fixture } = server({ realSample: SAMPLE });
  await call("GET", "/dev-cinema/session?as=veteran&stars=10000");
  const meta = readSkyMeta((await call("GET", "/v1/me/sky")).body);
  assert.equal(meta.starCount, 10000);
  const b = meta.bounds;
  let planets = 0,
    completed = 0,
    loaded = 0;
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({
      level: "0",
      x: String(Math.floor(b.minX)),
      y: String(Math.floor(b.minY)),
      w: String(Math.ceil(b.maxX - b.minX) + 1),
      h: String(Math.ceil(b.maxY - b.minY) + 1),
      version: meta.version,
      limit: "2000",
    });
    if (cursor) query.set("cursor", cursor);
    const page = readSkyTiles(
      (await call("GET", `/v1/me/sky/tiles?${query}`)).body,
    );
    assert.equal(page.versionChanged, false);
    for (const s of page.stars) {
      planets += s.planetCount;
      loaded += 1;
      if (s.progressStage === "completed") completed += 1;
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(loaded, 10000);
  const summary = (fixture.member() as any).achievementSummary;
  assert.equal(summary.discoveredStarCount, 10000);
  assert.equal(summary.completedStarCount, completed);
  assert.equal(summary.byType.confirmed + summary.byType.unconfirmed, planets);
  assert.ok(completed > 1000 && completed < 1400, `completed ${completed}`);
  assert.equal(
    (await call("GET", "/v1/me/quests")).body.tutorial.completedCount,
    5,
  );
});

test("other explorers: public galaxies, private one, star list", async () => {
  const { call } = server({ realSample: SAMPLE });
  const sizes = Object.fromEntries(
    DEMO_MEMBERS.map((m) => [m.memberId, m.starCount]),
  );
  assert.equal(sizes["u-301"], 50);
  assert.equal(sizes["u-303"], 10000);
  const meta = readPublicMeta(
    (await call("GET", "/v1/members/u-301/sky")).body,
    "u-301",
  );
  assert.equal(meta.owner.nickname, "별지기");
  assert.equal(meta.starCount, 50);
  const query = new URLSearchParams({
    level: "0",
    x: String(Math.floor(meta.bounds.minX)),
    y: String(Math.floor(meta.bounds.minY)),
    w: String(Math.ceil(meta.bounds.maxX - meta.bounds.minX) + 1),
    h: String(Math.ceil(meta.bounds.maxY - meta.bounds.minY) + 1),
    version: meta.version,
    limit: "1000",
  });
  const tiles = publicTiles(
    (await call("GET", `/v1/members/u-301/sky/tiles?${query}`)).body,
  );
  assert.equal(tiles.stars.length, 50);
  assert.ok(tiles.stars.every((s) => s.marker === null));
  // Tutorial stars are shared: real TIC with its real planet.
  const first = tiles.stars.find((s) => s.layoutOrdinal === 0)!;
  assert.equal(first.ticId, TUTORIALS[0].ticId);
  const system = readPublicSystem(
    (await call("GET", `/v1/members/u-301/stars/${first.ticId}`)).body,
    meta,
    first.ticId,
    "u-301",
    first,
  );
  assert.equal(system.items[0].candidateId, "9007199254900010");
  assert.equal((await call("GET", "/v1/members/u-210/sky")).status, 404);
  const profile = readProfile(
    (await call("GET", "/v1/members/u-303")).body,
    "u-303",
    false,
  );
  assert.equal(profile.starListVisibility, "PUBLIC");
  const list = readMyStars(
    (await call("GET", "/v1/members/u-303/stars?size=20")).body,
  );
  assert.equal(list.items.length, 20);
  assert.ok(list.nextCursor);
  // Unknown ids fall through to the next fixture.
  assert.equal((await call("GET", "/v1/members/nobody/sky")).passed, true);
});

test("follows are the explorer list; onboarding takes true only", async () => {
  const { call } = server();
  const following = readFollowing(
    (await call("GET", "/v1/me/following/members?size=20")).body,
  );
  assert.deepEqual(
    following.items.map((t) => t.id),
    ["u-301", "u-211", "u-303"],
  );
  const put = await call("PUT", "/v1/me/following/members/u-302");
  assert.deepEqual(put.body, { kind: "MEMBER", id: "u-302", following: true });
  assert.equal(
    (await call("GET", "/v1/me/following/members")).body.items.length,
    4,
  );
  assert.equal(
    (await call("PATCH", "/v1/me/onboarding", { onboardingDone: false }))
      .status,
    400,
  );
  assert.deepEqual(
    (await call("PATCH", "/v1/me/onboarding", { onboardingDone: true })).body,
    { onboardingDone: true },
  );
  await call("GET", "/dev-cinema/session?as=newcomer");
  assert.equal(
    (await call("GET", "/v1/me/following/members")).body.items.length,
    0,
  );
});

test("community replies behind the plugin get explorer authors", async () => {
  const { fixture } = server();
  let handler: any;
  (fixture.plugin.configureServer as any).call(
    {},
    { middlewares: { use: (_m: string, h: unknown) => (handler = h) } },
  );
  let written = "";
  const res: any = {
    headersSent: false,
    removeHeader: () => undefined,
    end: (chunk: string) => {
      written = chunk;
    },
  };
  await new Promise<void>((resolve) =>
    handler(
      {
        method: "GET",
        url: "/v1/community/feed",
        headers: { cookie: "" },
      },
      res,
      () => resolve(),
    ),
  );
  res.end(
    JSON.stringify({
      items: [
        { postId: "p-202", author: { memberId: "u-209", nickname: "관측자" } },
        { postId: "p-206", author: { memberId: "u-209", nickname: "관측자" } },
        { id: "pa-601", author: { memberId: "u-301", nickname: "탐사자 1" } },
      ],
    }),
  );
  const items = JSON.parse(written).items;
  assert.equal(items[0].author.memberId, "u-301");
  assert.equal(items[1].author.memberId, "u-209");
  assert.equal(items[2].author.nickname, "별지기");
});

// A tutorial star with three real signals (like L 98-59), explored before
// the member world starts.
const THREE = {
  ...TUTORIALS[1],
  candidates: [0, 1, 2].map((k) => ({
    ...planet(`9007199254902${k}00`, 2.1 + k * 1.7),
    planetName: `TEST-3 ${"bcd"[k]}`,
  })),
};
const SAMPLE_THREE: RealSample = {
  ...SAMPLE,
  stars: SAMPLE.stars.map((s) => (s.ticId === THREE.ticId ? THREE : s)),
};

test("star result: every found signal has its own submissions", async () => {
  const { call } = server({ realSample: SAMPLE_THREE });
  const reply = await call("GET", `/v1/stars/${THREE.ticId}/result`);
  assert.equal(reply.status, 200);
  const result = readStarResult(reply.body, THREE.ticId);
  assert.equal(result.signals.length, 3);
  assert.equal(result.submissionCount, 3);
  assert.deepEqual(
    result.signals.map((s) => s.curveStepAtMatch),
    [0, 1, 2],
  );
  // Explored before the world: each signal was submitted once, in order.
  assert.ok(result.signals.every((s) => s.statistics === null));
  for (const signal of result.signals) {
    const history = readHistoryDetail(
      (await call("GET", `/v1/histories/${signal.latestHistoryId}`)).body,
      { historyId: signal.latestHistoryId! },
    );
    assert.equal(history.ticId, THREE.ticId);
    assert.equal(history.matchStatus, "matched");
  }
  const rows = readMyHistories((await call("GET", "/v1/me/histories")).body);
  assert.ok(rows.items.length >= 4);
  assert.ok(Date.parse(rows.items[0].submittedAt) < Date.now());
  assert.equal(result.progress.stage, "completed");
  assert.equal(result.curveSteps.length, 3);
  assert.equal(result.nextActions.includes("PUBLISH_ALL"), false);
});

test("newcomer: a discovery shows up in history, detail, graph and result", async () => {
  const { call } = server({ realSample: SAMPLE, scenario: "newcomer" });
  const tic = TUTORIALS[0].ticId;
  assert.equal(
    readMyStars((await call("GET", "/v1/me/stars")).body).items.length,
    0,
  );
  const before = Date.now();
  const sent = await submitOverDip(call, tic);
  assert.equal(sent.status, 201);
  // Received now; nobody else judged this signal in a demo world.
  assert.ok(Date.parse(sent.body.submittedAt) >= before - 1000);
  assert.equal(sent.body.judgmentStatistics, null);

  const stars = readMyStars((await call("GET", "/v1/me/stars")).body);
  assert.deepEqual(
    stars.items.map((s) => s.ticId),
    [tic],
  );
  const histories = readMyHistories(
    (await call("GET", "/v1/me/histories")).body,
  );
  assert.equal(histories.items.length, 1);
  const row = histories.items[0];
  assert.equal(row.ticId, tic);
  assert.equal(row.historyId, sent.body.historyId);
  assert.equal(row.detailAvailable, true);

  const detail = readHistoryDetail(
    (await call("GET", `/v1/histories/${row.historyId}`)).body,
    { historyId: row.historyId },
  );
  assert.equal(detail.ticId, tic);
  for (const mode of ["CURRENT", "SUBMITTED"] as const) {
    const graph = await call(
      "GET",
      `/v1/histories/${row.historyId}/graph?mode=${mode}`,
    );
    assert.equal(graph.status, 200);
    const view = readHistoryGraphView(graph.body, row.historyId, tic, mode);
    if (mode === "CURRENT") assert.ok(view.dto.curve?.segments?.length);
    else {
      const flux = view.dto.snapshot!.foldedFlux.filter(
        (v): v is number => v !== null,
      );
      // The transit is in the fold: the lowest bin is well below the rest.
      assert.ok(Math.min(...flux) < 0.997, `min ${Math.min(...flux)}`);
    }
  }

  const result = readStarResult(
    (await call("GET", `/v1/stars/${tic}/result`)).body,
    tic,
  );
  assert.deepEqual(result.signals[0].submissionIds, [sent.body.submissionId]);
  assert.equal(result.signals[0].latestHistoryId, sent.body.historyId);
  assert.equal(result.discoveredStars[0].ticId, EXPLORE[0].ticId);

  const personal = readPersonalStatistics(
    (await call("GET", "/v1/me/statistics")).body,
  );
  assert.equal(personal.metrics.discoveredStarCount.value, 6);
  assert.equal(personal.weeks[7].submissionCount, 1);
});

test("synthetic planets: plausible numbers, no NASA claim, no dev text", async () => {
  const { call } = server({ realSample: SAMPLE });
  await call("GET", "/dev-cinema/session?as=veteran");
  const meta = readSkyMeta((await call("GET", "/v1/me/sky")).body);
  const list = readMyStars((await call("GET", "/v1/me/stars?size=100")).body);
  const explored = list.items.find(
    (s) =>
      s.planetCount > 0 && !SAMPLE.stars.some((real) => real.ticId === s.ticId),
  )!;
  assert.ok(explored, "a synthetic star with planets");
  const raw = (await call("GET", `/v1/me/stars/${explored.ticId}`)).body;
  const detail = readStarDetail(raw, meta, explored.ticId);
  assert.ok(
    detail.system.items.every(
      (p) =>
        p.candidateId.startsWith(`s-${explored.ticId}-`) &&
        p.periodDays !== null &&
        (p.depthPpm ?? 0) > 0,
    ),
  );
  const explained = await call(
    "GET",
    `/v1/me/stars/${explored.ticId}/planet-explanations`,
  );
  assert.doesNotMatch(JSON.stringify(explained.body), /개발용|fixture-204-p/);
  for (const item of readPlanetExplanations(explained.body, detail))
    assert.equal(item.facts, null);

  const global = readGlobalStatistics(
    (await call("GET", "/v1/statistics")).body,
  );
  const mine = readPersonalStatistics(
    (await call("GET", "/v1/me/statistics")).body,
  );
  assert.equal(mine.metrics.discoveredStarCount.value, 5000);
  assert.ok(
    global.data!.metrics.discoveredStars.value! >
      mine.metrics.discoveredStarCount.value! + 13_000,
  );
  assert.ok(
    global.data!.metrics.startedStars.value! <=
      global.data!.metrics.discoveredStars.value!,
  );
});

test("notifications point at this world's stars", async () => {
  const { fixture } = server({ realSample: SAMPLE, scenario: "newcomer" });
  let handler: any;
  (fixture.plugin.configureServer as any).call(
    {},
    { middlewares: { use: (_m: string, h: unknown) => (handler = h) } },
  );
  const rewritten = async (url: string, body: unknown) => {
    let written = "";
    const res: any = {
      headersSent: false,
      removeHeader: () => undefined,
      end: (chunk: string) => {
        written = chunk;
      },
    };
    await new Promise<void>((resolve) =>
      handler({ method: "GET", url, headers: { cookie: "" } }, res, () =>
        resolve(),
      ),
    );
    res.end(JSON.stringify(body));
    return JSON.parse(written);
  };
  const list = readNotices(
    await rewritten("/v1/me/notifications", {
      items: [
        {
          notificationId: "n-achievement",
          kind: "ACHIEVEMENT",
          createdAt: "2026-09-21T01:00:00Z",
          read: false,
          available: true,
          title: "새로운 성과가 인정되었습니다",
          body: "TOI-270에서 발견한 행성을 확인하세요.",
        },
      ],
      hasNext: false,
      nextCursor: null,
      readBoundary: "preview-boundary-1",
    }),
  );
  // A newcomer has no achievement yet: a welcome to tutorial 1 instead.
  assert.equal(list.items[0].title, "첫 번째 별이 열렸습니다");
  assert.match(list.items[0].body, new RegExp(TUTORIALS[0].ticId));
  const target = await rewritten("/v1/me/notifications/n-achievement/target", {
    notificationId: "n-achievement",
    available: true,
    target: { kind: "STAR", ticId: "259377017" },
  });
  assert.equal(target.target.ticId, TUTORIALS[0].ticId);
});

test("a synthetic star's submission has a readable history and result", async () => {
  const { call } = server({ realSample: SAMPLE });
  const tic = "900000007";
  const sent = await submitOverDip(call, tic);
  assert.equal(sent.status, 201, JSON.stringify(sent.body).slice(0, 200));
  const historyId = sent.body.historyId;
  const detail = readHistoryDetail(
    (await call("GET", `/v1/histories/${historyId}`)).body,
    { historyId },
  );
  assert.equal(detail.ticId, tic);
  for (const mode of ["CURRENT", "SUBMITTED"] as const)
    readHistoryGraphView(
      (await call("GET", `/v1/histories/${historyId}/graph?mode=${mode}`)).body,
      historyId,
      tic,
      mode,
    );
  const result = readStarResult(
    (await call("GET", `/v1/stars/${tic}/result`)).body,
    tic,
  );
  assert.ok(result.submissionCount >= 1);
});
