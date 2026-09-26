// Cinematic build review only. All data is synthetic and kept in this dev
// process. Loaded by scripts/cinema-server.mjs, never by vite.config.ts or a
// production build. See scripts/cinema-server.mjs for the fixture guide.
//
// **Composes the existing fixtures instead of re-implementing them.** The
// galaxy fixture is captured in-process and wrapped; analysis, periodogram,
// submission, residual, history, publication and star-result replies come from
// their own modules. What this file adds is only what the end-to-end flow
// needs and no single fixture has:
//
// - a member/anonymous session toggle (login page, logout, OAuth-like return),
// - one CSRF token for every fixture (each one checks its own constant),
// - analysis data for every galaxy star (the synthetic FOLD_SAMPLE curve),
// - a submission outcome that changes the sky: the member's planets appear in
//   the star detail and a recognized achievement unlocks a real new star,
// - NASA-style planet explanations for confirmed planets.
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LAYOUT_VERSION } from "../src/features/sky-data/contracts.ts";
import { galaxyFixturePlugin } from "./galaxy-fixture-plugin.ts";
import {
  ANALYSIS_FIXTURE_BUNDLE,
  ANALYSIS_FIXTURE_TICS,
  analysisFixtureResponse,
} from "./analysis-fixtures.ts";
import {
  FOLD_SAMPLE,
  PERIODOGRAM_FIXTURE_TICS,
  periodogramFixtureResponse,
} from "./periodogram-fixtures.ts";
import {
  readOutcome,
  readScenario,
  resetSubmissionFixtures,
  SUBMISSION_FIXTURE_CSRF,
  SUBMISSION_FIXTURE_HEADER,
  SUBMISSION_OUTCOME_HEADER,
  submissionFixtureResponse,
  type SubmissionOutcomeKind,
} from "./submission-fixtures.ts";
import { candidateOutcome } from "./submission-outcome-fixtures.ts";
import {
  pollResidualJobFixture,
  readResidualScenario,
  requestResidualJobFixture,
  resetResidualFixture,
  RESIDUAL_FIXTURE_HEADER,
} from "./residual-job-fixtures.ts";
import { historyFixtureResponse } from "./history-fixtures.ts";
import { createPublicationFixture } from "./publication-fixtures.ts";
import { starResultFixture } from "./star-result-fixtures.ts";

export const CINEMA_SESSION_COOKIE = "planetory-cinema-session";
export const CINEMA_CSRF = "cinema-fixture-csrf";
/** Every galaxy star serves this fixture's analysis data under its own TIC. */
export const CINEMA_SAMPLE_TIC = PERIODOGRAM_FIXTURE_TICS.normal;
/** Rank-1 peak. The only signal whose dip position in the sample is known. */
export const CINEMA_DIP_PEAK = 3600;
const COMMUNITY_CSRF = "community-fixture-209";
const BODY_LIMIT = 100_000;
// The galaxy fixture names stars `900000001 + index` (sky-reference exampleStar).
const GALAXY_TIC_BASE = 900000001;

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;
type Reply = { status: number; body: any };
type Json = Record<string, any>;
type Stage = "unexplored" | "in_progress" | "completed";
type OwnedPlanet = {
  candidateId: string;
  kind: "confirmed" | "unconfirmed";
  periodDays: number | null;
  depthPpm: number | null;
};
type StarOverlay = {
  stage: Stage;
  planets: Map<string, OwnedPlanet>;
  achievements: number;
  byType: { confirmed: number; unconfirmed: number; fp: number };
};

export type CinemaFixtureOptions = {
  /** Initial galaxy size. The galaxy fixture itself accepts any count here. */
  starCount?: number;
  /** Tutorial seqs completed at start and after reset. Markers show the rest. */
  completedTutorials?: number[];
  /**
   * Rank-1 peak submissions must include the synthetic dip (phase 0/1) in the
   * selected window, otherwise the result is `not_matched`. Off keeps the
   * submission fixture's peak-only table.
   */
  windowRule?: boolean;
};

const STAGE_ORDER: Stage[] = ["unexplored", "in_progress", "completed"];
const fixtureTics = new Set<string>([
  ...Object.values(ANALYSIS_FIXTURE_TICS),
  ...Object.values(PERIODOGRAM_FIXTURE_TICS),
]);
const tinyCurveTics = new Set<string>(Object.values(ANALYSIS_FIXTURE_TICS));

function captureGalaxy(starCount: number): Handler {
  const plugin = galaxyFixturePlugin(false, starCount);
  const holder: { handler?: Handler } = {};
  const hook = plugin.configureServer as unknown as (
    this: unknown,
    server: unknown,
  ) => void;
  hook.call(
    {},
    {
      middlewares: {
        use: (_mount: string, handler: Handler) => {
          holder.handler = handler;
        },
      },
    },
  );
  if (!holder.handler) throw new Error("galaxy fixture did not register");
  return holder.handler;
}

/** The galaxy fixture answers synchronously; call it without HTTP. */
function invoke(handler: Handler, method: string, path: string): Reply {
  const holder: { reply?: Reply } = {};
  let status = 200;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    setHeader() {
      return res;
    },
    end(chunk?: string) {
      holder.reply = { status, body: chunk ? JSON.parse(chunk) : null };
    },
  };
  handler(
    { method, url: path, headers: {} } as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    () => undefined,
  );
  if (!holder.reply) throw new Error(`galaxy fixture did not answer ${path}`);
  return holder.reply;
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
const failure = (code: string, message: string) => ({
  code,
  message,
  fieldErrors: [],
});
async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > BODY_LIMIT) throw new Error("too large");
  }
  return raw ? JSON.parse(raw) : null;
}
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
const safePath = (value: string | null, fallback: string) =>
  value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;

export function cinemaFixturePlugin(options: CinemaFixtureOptions = {}) {
  const starCount = options.starCount ?? 1000;
  const completedTutorials = options.completedTutorials ?? [1, 2];
  const windowRule = options.windowRule ?? true;

  let galaxy = captureGalaxy(starCount);
  // Cinema revision. Appended to every sky version the galaxy fixture reports
  // so planets/stages added here change the version too. Never reset: a reset
  // must not hand out a version string the browser has already seen.
  let revision = 0;
  const overlay = new Map<string, StarOverlay>();
  const recognized = new Set<string>();
  const residualTics = new Map<string, string>();
  const unlocked: string[] = [];
  let publication = createPublicationFixture();

  const seed = () => {
    for (const seq of completedTutorials)
      invoke(galaxy, "POST", `/dev-galaxy-204/complete-tutorial?seq=${seq}`);
  };
  seed();

  const innerVersion = (): string =>
    invoke(galaxy, "GET", "/v1/me/sky").body.version;
  const outward = (inner: string) => `${inner}~c${revision}`;
  const isGalaxyStar = (tic: string) =>
    /^\d+$/.test(tic) &&
    invoke(galaxy, "GET", `/v1/me/sky/locate?ticId=${tic}`).status === 200;

  const stageOf = (star: Json): Stage => {
    const extra = overlay.get(String(star.ticId))?.stage ?? "unexplored";
    const base = (star.progressStage ?? star.stage ?? "unexplored") as Stage;
    return STAGE_ORDER[
      Math.max(STAGE_ORDER.indexOf(base), STAGE_ORDER.indexOf(extra))
    ];
  };
  const extraPlanets = (tic: string) => [
    ...(overlay.get(tic)?.planets.values() ?? []),
  ];
  const ensure = (tic: string): StarOverlay => {
    let item = overlay.get(tic);
    if (!item) {
      item = {
        stage: "unexplored",
        planets: new Map(),
        achievements: 0,
        byType: { confirmed: 0, unconfirmed: 0, fp: 0 },
      };
      overlay.set(tic, item);
    }
    return item;
  };

  /** Tile/list star with the member's cinema progress applied. */
  const patchStar = (star: Json): Json => {
    const tic = String(star.ticId);
    if (!overlay.has(tic)) return star;
    const planetCount = star.planetCount + extraPlanets(tic).length;
    const progressStage = stageOf(star);
    return {
      ...star,
      planetCount,
      progressStage,
      completedWithoutPlanets:
        progressStage === "completed" && planetCount === 0,
    };
  };
  const patchListItem = (item: Json): Json => {
    const tic = String(item.ticId);
    const extra = overlay.get(tic);
    if (!extra) return item;
    const star = patchStar(item);
    return {
      ...star,
      achievementCount: item.achievementCount + extra.achievements,
      grade: item.achievementCount + extra.achievements > 0 ? "A" : null,
      currentCurveStep: star.progressStage === "unexplored" ? null : 0,
    };
  };
  const patchDetail = (body: Json): Json => {
    const tic = String(body.ticId);
    body.version = outward(body.version);
    const extra = overlay.get(tic);
    if (!extra) return body;
    const stage = stageOf({ ticId: tic, progressStage: body.progress.stage });
    const items = [
      ...body.planets.items.filter(
        (item: OwnedPlanet) => !extra.planets.has(item.candidateId),
      ),
      ...extra.planets.values(),
    ].sort((a: OwnedPlanet, b: OwnedPlanet) =>
      a.candidateId < b.candidateId
        ? -1
        : a.candidateId > b.candidateId
          ? 1
          : 0,
    );
    body.planets = {
      count: items.length,
      completedWithoutPlanets: stage === "completed" && items.length === 0,
      items,
    };
    body.progress = { ...body.progress, stage };
    const count = body.achievement.count + extra.achievements;
    body.achievement = {
      count,
      grade: count > 0 ? "A" : null,
      byType: {
        confirmed: body.achievement.byType.confirmed + extra.byType.confirmed,
        unconfirmed:
          body.achievement.byType.unconfirmed + extra.byType.unconfirmed,
        fp: body.achievement.byType.fp + extra.byType.fp,
      },
    };
    body.actions = {
      ...body.actions,
      analysis:
        stage === "completed"
          ? "review"
          : stage === "in_progress"
            ? "continue"
            : "start",
      resultAvailable: stage !== "unexplored",
    };
    return body;
  };

  /** Galaxy routes, with the cinema revision and overlay applied. */
  const galaxyRoute = (method: string, url: URL): Reply | null => {
    const path = url.pathname;
    if (path.startsWith("/dev-galaxy-204/")) {
      const reply = invoke(galaxy, method, path + url.search);
      if (path.endsWith("/reset")) {
        overlay.clear();
        recognized.clear();
        revision++;
      }
      if (reply.body?.skyVersion)
        reply.body.skyVersion = outward(reply.body.skyVersion);
      return reply;
    }
    if (path === "/v1/me/sky") {
      const reply = invoke(galaxy, method, path);
      if (reply.status === 200)
        reply.body.version = outward(reply.body.version);
      return reply;
    }
    if (path === "/v1/me/sky/tiles") {
      const asked = /^(.*)~c(\d+)$/.exec(url.searchParams.get("version") ?? "");
      if (!asked || Number(asked[2]) !== revision)
        return {
          status: 200,
          body: {
            representation: "individual-stars",
            version: outward(innerVersion()),
            level: Number(url.searchParams.get("level")),
            versionChanged: true,
            stars: [],
            nextCursor: null,
            asOf: new Date().toISOString(),
          },
        };
      const inner = new URL(url);
      inner.searchParams.set("version", asked[1]);
      const reply = invoke(galaxy, method, path + inner.search);
      if (reply.status === 200) {
        reply.body.version = outward(reply.body.version);
        reply.body.stars = reply.body.stars.map(patchStar);
      }
      return reply;
    }
    if (path === "/v1/me/sky/locate") {
      const reply = invoke(galaxy, method, path + url.search);
      if (reply.status === 200)
        reply.body.version = outward(reply.body.version);
      return reply;
    }
    if (
      path === "/v1/me/stars" &&
      url.searchParams.get("scope") === "discovered"
    ) {
      const reply = invoke(galaxy, method, path + url.search);
      if (reply.status === 200)
        reply.body.items = reply.body.items.map(patchListItem);
      return reply;
    }
    if (/^\/v1\/me\/stars\/[^/]+$/.test(path)) {
      const reply = invoke(galaxy, method, path);
      if (reply.status === 200) patchDetail(reply.body);
      return reply;
    }
    if (path === "/v1/me/quests" || path === "/v1/challenges/current")
      return invoke(galaxy, method, path);
    return null;
  };

  /** 4.2.1 planet explanations for the member's current planets. */
  const explanations = (tic: string): Reply => {
    const detail = invoke(galaxy, "GET", `/v1/me/stars/${tic}`);
    if (detail.status !== 200) return detail;
    const body = patchDetail(detail.body);
    const at = "2026-09-25T05:20:00Z";
    const items = body.planets.items.map(
      (planet: OwnedPlanet, index: number) => {
        const confirmed = planet.kind === "confirmed";
        const letter = String.fromCharCode(98 + index);
        const period = planet.periodDays ?? 9.97;
        return {
          candidateId: planet.candidateId,
          kind: planet.kind,
          status: confirmed ? "ready" : "not_applicable",
          content: confirmed
            ? {
                name: `TIC ${tic} ${letter}를 알아볼까요?`,
                orbitalPeriod: `별을 한 바퀴 도는 데 ${period.toFixed(2)}일이 걸려요.`,
                radius: "반지름은 지구의 1.12배예요.",
                mass: "질량은 아직 알 수 없어요.",
                discovery: "개발용 합성 설명이에요. 실제 발견 기록이 아닙니다.",
              }
            : null,
          facts: confirmed
            ? {
                planetName: `TIC ${tic} ${letter}`,
                orbitalPeriod: {
                  value: period.toFixed(4),
                  errorPlus: null,
                  errorMinus: null,
                  limit: 0,
                  unit: "days",
                  reference: null,
                },
                radius: {
                  value: "1.12",
                  errorPlus: null,
                  errorMinus: null,
                  limit: 0,
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
                discoveryYear: 2026,
                controversial: false,
                sourceTable: "ps",
                sourceUrl: "https://exoplanetarchive.ipac.caltech.edu/",
              }
            : null,
          sourceStatus: confirmed ? "ready" : null,
          fetchedAt: confirmed ? at : null,
          refreshStatus: confirmed ? "ok" : null,
          generatedAt: confirmed ? at : null,
          retryAt: null,
          failure: null,
        };
      },
    );
    return { status: 200, body: { ticId: tic, version: body.version, items } };
  };

  /** Analysis reads. Galaxy stars get the synthetic sample under their TIC. */
  const analysisReply = (
    url: URL,
  ): { status: number; body: unknown; currentBundleId?: string } | null => {
    const match =
      /^\/v1\/stars\/([^/]+)\/(analysis-context|curves|periodogram|candidate-peaks)$/.exec(
        url.pathname,
      );
    if (!match) return null;
    const tic = decodeURIComponent(match[1]);
    if (fixtureTics.has(tic))
      return periodogramFixtureResponse(url) ?? analysisFixtureResponse(url);
    if (!isGalaxyStar(tic))
      return {
        status: 403,
        body: failure("STAR_LOCKED", "아직 열리지 않은 별입니다."),
      };
    const mapped = new URL(url);
    mapped.pathname = `/v1/stars/${CINEMA_SAMPLE_TIC}/${match[2]}`;
    const reply = periodogramFixtureResponse(mapped);
    const body = record(reply?.body);
    if (body && "ticId" in body) body.ticId = tic;
    return reply;
  };
  const contextFor = (tic: string) =>
    analysisReply(
      new URL(`/v1/stars/${tic}/analysis-context`, "http://fixture.invalid"),
    );

  /** Rank-1 dip sits at phase 0 (= 1 = 2 on the two-cycle display). */
  const coversDip = (selection: Json) => {
    const { phaseStart: s, phaseEnd: e, periodDays: p } = selection;
    if (![s, e, p].every((v) => typeof v === "number" && Number.isFinite(v)))
      return true;
    const half = FOLD_SAMPLE.durationHours / 48 / p;
    return [0, 1, 2].some((k) => s <= k + half && e >= k - half);
  };

  const toNotMatched = (result: Json, contextMatched: string[]) => {
    result.match = { status: "not_matched", candidateId: null };
    result.signal = null;
    result.judgment = {
      value: result.judgment?.value ?? null,
      evaluation: "NOT_APPLICABLE",
    };
    result.achievement = {
      result: "none",
      newlyRecognized: false,
      unlockedStars: [],
      star: {
        count: 0,
        grade: null,
        byType: { confirmed: 0, unconfirmed: 0, fp: 0 },
      },
    };
    result.publication = { state: "NOT_ELIGIBLE", publicAnalysisId: null };
    result.judgmentStatistics = null;
    result.detail = {
      available: true,
      targetKind: "CURRENT_CURVE_HINT",
      answerViewed: false,
    };
    result.nextActions = ["NEXT_CURVE", "DISCUSS", "LATER"];
    result.progress.matchedCandidateIds = [...new Set(contextMatched)].sort();
  };

  /**
   * A new (201) submission changes the member's sky the way the service does:
   * stage, the member's planets (4.2 HOME-05), and a recognized achievement
   * unlocks one new star. Mutates the stored result in place so replays and
   * by-request recovery return exactly what was first sent.
   */
  const applySubmission = (
    tic: string,
    input: Json,
    result: Json,
    windowMiss: boolean,
  ) => {
    const galaxyStar = !fixtureTics.has(tic);
    if (windowMiss) {
      const context = record(contextFor(tic)?.body);
      toNotMatched(
        result,
        (record(context?.progress)?.matchedCandidateIds as string[]) ?? [],
      );
    }
    if (galaxyStar) {
      const item = ensure(tic);
      const stage = (result.progress?.stage ?? "in_progress") as Stage;
      if (STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(item.stage))
        item.stage = stage;
      if (item.stage === "unexplored") item.stage = "in_progress";
      const signal = record(result.signal);
      const status = String(record(result.match)?.status);
      if (
        signal &&
        ["matched", "matched_harmonic", "duplicate"].includes(status)
      ) {
        const planet: OwnedPlanet = {
          candidateId: String(signal.candidateId),
          kind:
            signal.disposition === "CONFIRMED" ? "confirmed" : "unconfirmed",
          periodDays: Number(Number(signal.bls.periodDays).toFixed(4)),
          depthPpm: Number(signal.bls.depthPpm),
        };
        if (signal.disposition === "CONFIRMED")
          item.planets.set(planet.candidateId, planet);
        else if (signal.disposition === "UNCONFIRMED") {
          if (input.userJudgment === "LIKELY_PLANET")
            item.planets.set(planet.candidateId, planet);
          else item.planets.delete(planet.candidateId);
        }
      }
      const achievement = record(result.achievement);
      if (achievement?.result === "recognized" && signal) {
        recognized.add(`${tic}:${signal.candidateId}`);
        item.achievements += 1;
        const type =
          signal.disposition === "CONFIRMED"
            ? "confirmed"
            : signal.disposition === "FP"
              ? "fp"
              : "unconfirmed";
        item.byType[type] += 1;
        const before = invoke(galaxy, "GET", "/v1/me/sky").body.starCount;
        invoke(galaxy, "POST", "/dev-galaxy-204/change");
        const newTic = String(GALAXY_TIC_BASE + before);
        const located = invoke(
          galaxy,
          "GET",
          `/v1/me/sky/locate?ticId=${newTic}`,
        );
        achievement.unlockedStars =
          located.status === 200
            ? [
                {
                  ticId: newTic,
                  position: {
                    worldX: located.body.x,
                    worldY: located.body.y,
                    depthZ: located.body.depthZ,
                    layoutVersion: LAYOUT_VERSION,
                  },
                },
              ]
            : [];
        if (located.status === 200) unlocked.push(newTic);
        achievement.star = {
          ...achievement.star,
          count: item.achievements,
          grade: "A",
        };
      } else if (achievement) achievement.unlockedStars = [];
      revision++;
    }
    result.skyVersion = outward(innerVersion());
  };

  const handleSubmission = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const post = /^\/v1\/stars\/([^/]+)\/submissions$/.exec(url.pathname);
    if (!url.pathname.startsWith("/v1/submissions/") && !post) return false;
    let body: unknown = null;
    if (req.method !== "GET") {
      try {
        body = await readJson(req);
      } catch {
        body = null;
      }
    }
    const tic = post ? decodeURIComponent(post[1]) : null;
    let outcome: SubmissionOutcomeKind | null = readOutcome(
      req.headers[SUBMISSION_OUTCOME_HEADER],
    );
    let windowMiss = false;
    const input = record(body);
    const selection = record(input?.selection);
    if (
      tic &&
      req.method === "POST" &&
      input?.submissionKind === "candidate" &&
      selection
    ) {
      const grid =
        typeof selection.sourcePeakGridIndex === "number"
          ? selection.sourcePeakGridIndex
          : null;
      windowMiss =
        windowRule &&
        grid === CINEMA_DIP_PEAK &&
        !tinyCurveTics.has(tic) &&
        !coversDip(selection);
      if (!outcome && !windowMiss && typeof input.userJudgment === "string") {
        const preview = candidateOutcome({
          sourcePeakGridIndex: grid,
          periodDays: Number(selection.periodDays),
          userJudgment: input.userJudgment as
            "LIKELY_PLANET" | "UNLIKELY_PLANET" | "UNSURE",
        });
        const candidate = preview.match.candidateId;
        if (candidate && recognized.has(`${tic}:${candidate}`))
          outcome = "duplicate";
      }
    }
    const reply = submissionFixtureResponse({
      method: req.method ?? "GET",
      url,
      csrf: req.headers["x-csrf-token"],
      scenario: readScenario(req.headers[SUBMISSION_FIXTURE_HEADER]),
      outcome,
      body,
      contextFor,
    });
    if (!reply) return false;
    if (reply.kind === "drop") {
      if (reply.reset) {
        res.destroy();
        return true;
      }
      res.writeHead(500, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.write('{"code":"SERVER_ERROR"', () =>
        setTimeout(() => res.destroy(), 20),
      );
      return true;
    }
    if (tic && reply.status === 201 && input) {
      const result = record(reply.body);
      if (result) applySubmission(tic, input, result, windowMiss);
    }
    send(res, reply.status, reply.body, {
      "X-Current-Bundle": reply.currentBundleId ?? ANALYSIS_FIXTURE_BUNDLE,
    });
    return true;
  };

  const reset = () => {
    galaxy = captureGalaxy(starCount);
    seed();
    overlay.clear();
    recognized.clear();
    residualTics.clear();
    unlocked.length = 0;
    publication = createPublicationFixture();
    resetSubmissionFixtures();
    resetResidualFixture();
    revision++;
  };

  const plugin: Plugin = {
    name: "cinema-fixture",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, next) => {
        try {
          const url = new URL(req.url ?? "/", "http://fixture.invalid");
          const path = url.pathname;
          const method = req.method ?? "GET";
          const anonymous = (req.headers.cookie ?? "")
            .split(";")
            .some(
              (part) => part.trim() === `${CINEMA_SESSION_COOKIE}=anonymous`,
            );
          const cookie = (value: "anonymous" | "member") =>
            `${CINEMA_SESSION_COOKIE}=${value}; Path=/; SameSite=Lax`;

          // --- Dev controls. Not part of any service contract. ---
          if (path === "/dev-cinema/session" && method === "GET") {
            const as =
              url.searchParams.get("as") === "anonymous"
                ? "anonymous"
                : "member";
            res.writeHead(302, {
              "Set-Cookie": cookie(as),
              Location: safePath(
                url.searchParams.get("next"),
                as === "anonymous" ? "/login" : "/sky",
              ),
              "Cache-Control": "no-store",
            });
            res.end();
            return;
          }
          const provider = /^\/dev-cinema\/oauth\/(ssafy|google)$/.exec(path);
          if (provider && method === "GET") {
            res.writeHead(302, {
              "Set-Cookie": cookie("member"),
              Location: "/oauth/callback",
              "Cache-Control": "no-store",
            });
            res.end();
            return;
          }
          if (path === "/dev-cinema/reset" && method === "POST") {
            reset();
            return send(res, 200, { skyVersion: outward(innerVersion()) });
          }
          if (path === "/dev-cinema/state" && method === "GET") {
            const meta = invoke(galaxy, "GET", "/v1/me/sky").body;
            return send(res, 200, {
              session: anonymous ? "anonymous" : "member",
              skyVersion: outward(meta.version),
              starCount: meta.starCount,
              sampleTic: CINEMA_SAMPLE_TIC,
              windowRule,
              unlocked,
              recognized: [...recognized],
              overlay: Object.fromEntries(
                [...overlay].map(([tic, item]) => [
                  tic,
                  {
                    stage: item.stage,
                    planets: [...item.planets.values()],
                    achievements: item.achievements,
                  },
                ]),
              ),
            });
          }

          // --- Session and CSRF shared by every fixture behind this one. ---
          if (path === "/v1/auth/csrf" && method === "GET")
            return send(res, 200, {
              headerName: "X-CSRF-TOKEN",
              token: CINEMA_CSRF,
            });
          if (path === "/v1/auth/logout" && method === "POST") {
            res.writeHead(204, {
              "Set-Cookie": cookie("anonymous"),
              "Cache-Control": "no-store",
            });
            res.end();
            return;
          }
          if (anonymous && path.startsWith("/v1/"))
            return send(
              res,
              401,
              failure("AUTH_REQUIRED", "로그인이 필요합니다."),
            );
          if (req.headers["x-csrf-token"] === CINEMA_CSRF) {
            const analysisWrite =
              /^\/v1\/stars\/[^/]+\/submissions$/.test(path) ||
              path.startsWith("/v1/submissions/");
            if (!/\/planet-explanations$/.test(path))
              req.headers["x-csrf-token"] = analysisWrite
                ? SUBMISSION_FIXTURE_CSRF
                : COMMUNITY_CSRF;
          }

          // --- Galaxy (sky, tiles, locate, detail, list, quests). ---
          const explain =
            /^\/v1\/me\/stars\/([^/]+)\/planet-explanations$/.exec(path);
          if (explain) {
            if (
              method === "POST" &&
              req.headers["x-csrf-token"] !== CINEMA_CSRF
            )
              return send(
                res,
                403,
                failure("CSRF_INVALID", "인증 정보를 확인해 주세요."),
              );
            const reply = explanations(decodeURIComponent(explain[1]));
            return send(res, reply.status, reply.body);
          }
          const sky = galaxyRoute(method, url);
          if (sky) return send(res, sky.status, sky.body);

          // --- Analysis reads. ---
          if (method === "GET") {
            const analysis = analysisReply(url);
            if (analysis)
              return send(res, analysis.status, analysis.body, {
                "X-Current-Bundle":
                  analysis.currentBundleId ?? ANALYSIS_FIXTURE_BUNDLE,
              });
            const result = /^\/v1\/stars\/([^/]+)\/result$/.exec(path);
            if (result) {
              const tic = decodeURIComponent(result[1]);
              const galaxyStar = !fixtureTics.has(tic) && isGalaxyStar(tic);
              const explored =
                galaxyStar &&
                stageOf({
                  ticId: tic,
                  progressStage: invoke(galaxy, "GET", `/v1/me/stars/${tic}`)
                    .body.progress.stage,
                }) !== "unexplored";
              if (tic === CINEMA_SAMPLE_TIC || explored)
                return send(res, 200, starResultFixture(tic));
              return send(
                res,
                404,
                failure("RESOURCE_NOT_FOUND", "볼 수 있는 별 결과가 없습니다."),
              );
            }
          }

          // --- Residual jobs (7.1/7.2). Galaxy stars share the sample's jobs. ---
          const job = /^\/v1\/residual-jobs\/([^/]+)$/.exec(path);
          if (job && method === "GET") {
            const reply = pollResidualJobFixture(job[1]);
            const body = record(reply.body);
            const tic = residualTics.get(job[1]);
            if (body && tic) body.ticId = tic;
            return send(res, reply.status, reply.body, reply.headers ?? {});
          }
          const create = /^\/v1\/stars\/([^/]+)\/residual-jobs$/.exec(path);
          if (create && method === "POST") {
            const tic = decodeURIComponent(create[1]);
            const galaxyStar = !fixtureTics.has(tic);
            if (galaxyStar && !isGalaxyStar(tic))
              return send(
                res,
                403,
                failure("STAR_LOCKED", "아직 열리지 않은 별입니다."),
              );
            let body: unknown = null;
            try {
              body = await readJson(req);
            } catch {
              body = null;
            }
            const reply = requestResidualJobFixture({
              ticId: galaxyStar ? CINEMA_SAMPLE_TIC : tic,
              body,
              scenario: readResidualScenario(
                req.headers[RESIDUAL_FIXTURE_HEADER],
              ),
            });
            const jobId = record(reply.body)?.jobId;
            if (galaxyStar && typeof jobId === "string")
              residualTics.set(jobId, tic);
            return send(res, reply.status, reply.body);
          }

          // --- Submissions, recovery, detail view, retry draft. ---
          if (await handleSubmission(req, res, url)) return;

          // --- Publication and history detail (same routes as fixture-plugin). ---
          if (
            path.startsWith("/v1/public-analyses") ||
            /^\/v1\/histories\/h-195[123](\/graph)?$/.test(path) ||
            (path === "/v1/me/histories" &&
              url.searchParams.get("candidateId")?.startsWith("c-195"))
          ) {
            let body: unknown;
            if (method !== "GET") {
              try {
                body = (await readJson(req)) ?? undefined;
              } catch {
                return send(
                  res,
                  400,
                  failure("VALIDATION_FAILED", "입력을 확인해 주세요."),
                );
              }
            }
            const reply = publication(method, url, body);
            if (reply) return send(res, reply.status, reply.body);
          }
          if (method === "GET" && path.startsWith("/v1/histories/")) {
            const history = historyFixtureResponse(path, url.searchParams);
            if (history) return send(res, history.status, history.body);
          }
          next();
        } catch (error) {
          next(error);
        }
      });
    },
  };
  return { plugin, reset };
}
