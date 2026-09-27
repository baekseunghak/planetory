// Cinematic build review only. All data is synthetic (plus the local real
// TESS sample when present) and kept in this dev process. Loaded by
// scripts/cinema-server.mjs, never by vite.config.ts or a production build.
// See scripts/cinema-server.mjs for the fixture guide and
// dev/cinema-scenarios.ts for the demo scenarios.
//
// **Composes the existing fixtures instead of re-implementing them.** The
// galaxy fixture is captured in-process and wrapped; analysis, periodogram,
// submission, residual, history, publication and star-result replies come from
// their own modules. What this file adds is only what the end-to-end flow
// needs and no single fixture has:
//
// - demo scenarios (newcomer, member, veteran): one "world" per scenario,
//   rebuilt on every switch (GET /api/dev-cinema/session?as=...),
// - a member/anonymous session toggle (login page, logout, OAuth-like return),
// - one CSRF token for every fixture (each one checks its own constant),
// - analysis data for every galaxy star: the real TESS sample for its stars
//   (dev/real-sample), the synthetic FOLD_SAMPLE curve for the others,
// - a submission outcome that changes the sky: the member's planets appear in
//   the star detail and a recognized achievement unlocks a real new star,
// - NASA-style planet explanations for confirmed planets,
// - other members' public galaxies (DEMO_MEMBERS), follows, statistics and
//   the community authors that link to them.
import type { Plugin } from "vite";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  LAYOUT_VERSION,
  type Star,
} from "../src/features/sky-data/contracts.ts";
import {
  galaxyFixturePlugin,
  type GalaxyFixtureOverrides,
} from "./galaxy-fixture-plugin.ts";
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
import { globalStatisticsFixture } from "../tests/fixtures/global-statistics.ts";
import { personalStatisticsFixture } from "../tests/fixtures/personal-statistics.ts";
import {
  defaultRealPlacement,
  dipPhases,
  matchRealSelection,
  REAL_SAMPLE_BUNDLE,
  REAL_SAMPLE_VERSIONS,
  realAnalysisResponse,
  realDetailSignal,
  realMatchSignal,
  type RealStarState,
} from "./real-sample/adapter.ts";
import type {
  RealCandidate,
  RealSample,
  RealSampleStar,
} from "./real-sample/types.ts";
import {
  DEMO_MEMBERS,
  DEMO_SCENARIOS,
  DEMO_STAR_RANGE,
  VETERAN_STAR_OPTIONS,
  type DemoMember,
  type DemoScenario,
  type DemoScenarioId,
  type DemoScenarioList,
  type DemoSession,
} from "./cinema-scenarios.ts";

export const CINEMA_SESSION_COOKIE = "planetory-cinema-session";
export const CINEMA_CSRF = "cinema-fixture-csrf";
/** Every synthetic galaxy star serves this fixture's analysis data. */
export const CINEMA_SAMPLE_TIC = PERIODOGRAM_FIXTURE_TICS.normal;
/** Rank-1 peak. The only signal whose dip position in the sample is known. */
export const CINEMA_DIP_PEAK = 3600;
const COMMUNITY_CSRF = "community-fixture-209";
const BODY_LIMIT = 100_000;
const ME = "u-209";
// The galaxy fixture names stars `900000001 + index` (sky-reference exampleStar).
const GALAXY_TIC_BASE = 900000001;
// Other members' own stars: PUBLIC_TIC_BASE + slot * PUBLIC_TIC_SLOT + ordinal.
const PUBLIC_TIC_BASE = 901000001;
const PUBLIC_TIC_SLOT = 20000;
/** Real TICs in [GALAXY_TIC_BASE, SYNTHETIC_TIC_END) would collide. */
const SYNTHETIC_TIC_END = 904000001;

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
  /** Real stars: candidates this member matched (analysis context, next curve). */
  matched: Set<string>;
  /** Matched candidate -> its disposition (star result). */
  dispositions: Map<string, string>;
  /** Matched candidate -> this world's submissions of it, oldest first. */
  submissions: Map<string, string[]>;
  /** Stars a recognized achievement here unlocked (star result). */
  unlocked: { ticId: string; unlockedAt: string; achievementId: string }[];
  /** Last submission on this star in this world (My page list order). */
  touchedAt: string | null;
};
type FollowTarget = { kind: "MEMBER" | "STAR"; id: string; label: string };

export type CinemaFixtureOptions = {
  /** Galaxy size of the member scenario. The galaxy fixture accepts any count. */
  starCount?: number;
  /**
   * Rank-1 peak submissions must include the synthetic dip (phase 0/1) in the
   * selected window, otherwise the result is `not_matched`. Off keeps the
   * submission fixture's peak-only table. Real stars use the same rule on
   * their own dips (dev/real-sample/adapter.ts `realMatchSignal`).
   */
  windowRule?: boolean;
  /**
   * Real TESS stars (dev/real-sample, `loadRealSample()`), or null for the
   * synthetic sample only. Tutorials take the blue markers; explore stars take
   * the challenge slot and the next ones (newcomer: the stars a discovery
   * unlocks). Their analysis reads come from `realAnalysisResponse`, their
   * submissions match with `realMatchSignal` / `realDetailSignal`.
   */
  realSample?: RealSample | null;
  /** Scenario at start (dev/cinema-scenarios.ts). Default `member`. */
  scenario?: DemoScenarioId;
  /**
   * A recognized achievement unlocks the next star (default). false answers
   * `unlockedStars: []` instead, as production often does after a tutorial
   * achievement. Flip at run time with POST /api/dev-cinema/unlock?on=0|1.
   */
  unlock?: boolean;
};

/** What the plugin hands the server script besides the middleware. */
export type CinemaFixture = {
  plugin: Plugin;
  /** Fresh world for the current scenario (POST /api/dev-cinema/reset). */
  reset(): void;
  /**
   * Fields merged over GET /v1/me by settingsFixturePlugin({ member }):
   * nickname (not for `member`, whose nickname stays editable in the profile
   * fixture), onboardingDone, tutorialCompleted and an achievementSummary
   * counted from the world's sky, so My page and the top bar agree.
   */
  member(): Record<string, unknown>;
};

/** One scenario's state. Rebuilt on every switch and reset. */
type World = {
  scenario: DemoScenario;
  /** Galaxy size it was built with (reset keeps it). */
  size: number;
  galaxy: Handler;
  /** Galaxy ordinal -> real star (all of them, locked ones included). */
  placement: Map<number, RealSampleStar>;
  ticOf(ordinal: number): string;
  overlay: Map<string, StarOverlay>;
  recognized: Set<string>;
  residualTics: Map<string, string>;
  unlocked: string[];
  publication: ReturnType<typeof createPublicationFixture>;
  onboardingDone: boolean;
  follows: Map<string, FollowTarget>;
  /**
   * Every accepted (201) submission on a galaxy star, oldest first: the
   * stored receipt itself. My page history, history detail, star results
   * and statistics read this, so they tell the story of this world.
   */
  log: Json[];
  /**
   * Real stars explored before this world starts. They are submitted signal
   * by signal right after the world is in place (`seedWorld`), so they have
   * receipts like live submissions.
   */
  seeds: RealSampleStar[];
};

const STAGE_ORDER: Stage[] = ["unexplored", "in_progress", "completed"];
const fixtureTics = new Set<string>([
  ...Object.values(ANALYSIS_FIXTURE_TICS),
  ...Object.values(PERIODOGRAM_FIXTURE_TICS),
]);
const tinyCurveTics = new Set<string>(Object.values(ANALYSIS_FIXTURE_TICS));

function captureGalaxy(
  starCount: number,
  overrides: GalaxyFixtureOverrides = {},
): Handler {
  const plugin = galaxyFixturePlugin(false, starCount, overrides);
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
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
const safePath = (value: string | null, fallback: string) =>
  value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;

/** Deterministic 0..1 per (ordinal, salt): seeded progress, no Math.random. */
function unit(index: number, salt: number): number {
  let h = Math.imul(index + 1, 2654435761) ^ Math.imul(salt + 7, 40503);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** HOME-05 for a seeded (already explored) real star: FP is never a planet. */
function realPlanet(candidate: RealCandidate): OwnedPlanet {
  return {
    candidateId: candidate.candidateId,
    kind: candidate.kind === "confirmed" ? "confirmed" : "unconfirmed",
    periodDays: Number(candidate.periodDays.toFixed(4)),
    depthPpm: Math.round(candidate.depthPpm),
  };
}
const realPlanets = (star: RealSampleStar) =>
  star.candidates
    .filter((c) => c.kind !== "fp")
    .map(realPlanet)
    .sort((a, b) =>
      a.candidateId < b.candidateId
        ? -1
        : a.candidateId > b.candidateId
          ? 1
          : 0,
    );
const kindOf = (candidate: RealCandidate) =>
  candidate.kind === "confirmed"
    ? "confirmed"
    : candidate.kind === "fp"
      ? "fp"
      : "unconfirmed";
const grade = (achievements: number) =>
  achievements >= 4
    ? "SSS"
    : achievements === 3
      ? "SS"
      : achievements === 2
        ? "S"
        : "A";
const DISPOSITION = {
  confirmed: "CONFIRMED",
  candidate: "UNCONFIRMED",
  fp: "FP",
} as const;
/** Receipt statuses that name a found signal. */
const FOUND = new Set(["matched", "matched_harmonic", "duplicate"]);

/**
 * A synthetic galaxy planet (galaxy fixture `fixture-204-p-i`, periodDays
 * null, depth 0) as a plausible, per-star planet: its own id and a seeded
 * period and depth. Real stars never take this path.
 */
function syntheticPlanet(
  tic: string,
  ordinal: number,
  planet: OwnedPlanet,
  index: number,
): OwnedPlanet {
  if (!/^(fixture-204-p-|p-\d+-)\d+$/.test(planet.candidateId)) return planet;
  const seed = Number.isInteger(ordinal) ? ordinal : Number(tic) % 100_000;
  return {
    ...planet,
    candidateId: `s-${tic}-${index + 1}`,
    periodDays: Number((1.3 + 36 * unit(seed, 40 + index) ** 1.7).toFixed(4)),
    depthPpm: Math.round(260 + 8800 * unit(seed, 60 + index) ** 2),
  };
}

/** A past, stable time for seeded activity (no Date.now in seeds). */
function seededAt(tic: string, salt = 0): string {
  const u = unit(Number(tic) % 1_000_000, 70 + salt);
  // Days 1..20: seeded steps of one star follow a day apart (seedReal).
  const day = 1 + Math.floor(u * 20);
  const hour = Math.floor(unit(Number(tic) % 1_000_000, 90 + salt) * 14) + 1;
  return `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:10:00Z`;
}

/**
 * Real stars that can join the galaxy (a clash with a synthetic galaxy TIC
 * would break tiles). A real star may carry an analysis-fixture TIC (TOI-270
 * is TIC 259377017): in the galaxy the real star wins (`fixtureOnly`).
 */
function usableStars(sample: RealSample | null): RealSampleStar[] {
  if (!sample) return [];
  return sample.stars.filter((star) => {
    const n = Number(star.ticId);
    const clash = n >= GALAXY_TIC_BASE && n < SYNTHETIC_TIC_END;
    if (clash)
      console.warn(
        `real sample: TIC ${star.ticId} clashes with a synthetic TIC; left out`,
      );
    return !clash;
  });
}

// Community fixture posts p-201..p-244 are all written by "me". The demo
// gives most of them to other explorers so authors link to real profiles and
// public galaxies; every fifth stays mine (editable).
const FIXTURE_POST = /^p-(2(?:0[1-9]|[1-3]\d|4[0-4]))$/;
const POST_TITLES = [
  "반복되는 밝기 감소를 함께 살펴봐요",
  "첫 탐사를 마치고 남기는 기록",
  "관측 회차가 달라지면 무엇이 달라질까요?",
];
const PUBLIC_AUTHORS = DEMO_MEMBERS.filter((m) => m.visibility === "PUBLIC");
/**
 * Search-escaping test strings of the community fixture (p-201) read as a
 * real post on stage. Replaced in dev:cinema replies only.
 */
const FIXTURE_TEXT = new Map([
  ["TOI-270 · 10%_ 감소 + A&B", "TOI-270 · 세 행성의 통과 간격을 비교했습니다"],
  [
    "빛 감소 기록입니다. 두  공백을 유지합니다.",
    "TOI-270의 세 신호(약 3.36일, 5.66일, 11.38일)를 차례로 접어 보았습니다. 통과 깊이와 간격을 함께 비교해 보면 좋겠습니다.",
  ],
]);
function postAuthor(postId: string): DemoMember | null {
  const match = FIXTURE_POST.exec(postId);
  if (!match) return null;
  const k = Number(match[1]) - 201;
  return k % 5 === 0 ? null : (PUBLIC_AUTHORS[(k % 5) - 1] ?? null);
}

/** Another explorer: DEMO_MEMBERS, or a generated `u-3NN`. */
type PublicMember = DemoMember & { slot: number };
function publicMember(memberId: string): PublicMember | null {
  const index = DEMO_MEMBERS.findIndex((m) => m.memberId === memberId);
  if (index >= 0) return { ...DEMO_MEMBERS[index], slot: index };
  // The searchable community fixture's first post is by "Orbit".
  if (memberId === "u-orbit-217")
    return {
      memberId,
      nickname: "Orbit",
      visibility: "PUBLIC",
      starCount: 320,
      withPlanets: 0.1,
      slot: 9,
    };
  const generated = /^u-3(\d\d)$/.exec(memberId);
  const n = generated ? Number(generated[1]) : 0;
  if (!n) return null;
  return {
    memberId,
    nickname: `탐사자 ${n}`,
    visibility: "PUBLIC",
    starCount: 30 + ((n * 97) % 470),
    withPlanets: 0.15,
    slot: 10 + n,
  };
}

export function cinemaFixturePlugin(
  options: CinemaFixtureOptions = {},
): CinemaFixture {
  const memberStars = options.starCount ?? DEMO_SCENARIOS.member.starCount;
  const windowRule = options.windowRule ?? true;
  let unlockStars = options.unlock ?? true;
  const sampleStars = usableStars(options.realSample ?? null);
  const sample: RealSample | null =
    options.realSample && sampleStars.length
      ? { ...options.realSample, stars: sampleStars }
      : null;
  const realByTic = new Map(sampleStars.map((star) => [star.ticId, star]));
  const realTutorials = new Map<number, RealSampleStar>();
  for (const star of sampleStars)
    if (star.role === "tutorial" && star.tutorialSeq)
      realTutorials.set(star.tutorialSeq - 1, star);

  // Cinema revision. Appended to every sky version the galaxy fixture reports
  // so planets/stages added here change the version too. Never reset: a
  // rebuilt world must not hand out a version string the browser has seen.
  let revision = 0;
  // Submission ids restart from a time-based number on every new world, so
  // a browser that celebrated `sub-7000` in a rehearsal still sees the next
  // first discovery (celebration history is keyed by submission id).
  let sequenceStart = 0;
  const freshSequence = () => {
    sequenceStart = Math.max(
      sequenceStart + 10_000,
      Math.floor(Date.now() / 100),
    );
    return sequenceStart;
  };

  // ------------------------------------------------------------ worlds

  const placementFor = (id: DemoScenarioId): Map<number, RealSampleStar> => {
    if (!sample) return new Map();
    if (id !== "newcomer")
      return defaultRealPlacement(sample, Number.MAX_SAFE_INTEGER);
    // A newcomer's next stars are the ones discoveries unlock: 5, 6, 7, ...
    const placed = new Map(realTutorials);
    let next = 5;
    for (const star of sampleStars) {
      if (star.role !== "explore") continue;
      while (placed.has(next)) next++;
      placed.set(next++, star);
    }
    return placed;
  };

  /** Seeded progress by ordinal (galaxy fixture `starFor`). */
  const seededStar = (
    scenario: DemoScenario,
    placement: Map<number, RealSampleStar>,
    i: number,
    star: Star,
  ): Star => {
    const plain = {
      ...star,
      planetCount: 0,
      progressStage: "unexplored" as const,
      completedWithoutPlanets: false,
    };
    // Real stars start clean; the overlay seeds their real planets.
    if (placement.has(i) || scenario.id === "newcomer") return plain;
    if (scenario.id !== "veteran" || i < 8) return star;
    const { inProgress, completed, withPlanets } = scenario.progress;
    const u = unit(i, 11);
    if (u < withPlanets)
      return {
        ...star,
        progressStage: "completed",
        planetCount: 1 + Math.floor(unit(i, 12) * 3),
        completedWithoutPlanets: false,
      };
    if (u < completed)
      return {
        ...plain,
        progressStage: "completed",
        completedWithoutPlanets: true,
      };
    if (u < completed + inProgress)
      return { ...plain, progressStage: "in_progress" };
    return plain;
  };

  const ensureIn = (world: World, tic: string): StarOverlay => {
    let item = world.overlay.get(tic);
    if (!item) {
      item = {
        stage: "unexplored",
        planets: new Map(),
        achievements: 0,
        byType: { confirmed: 0, unconfirmed: 0, fp: 0 },
        matched: new Set(),
        dispositions: new Map(),
        submissions: new Map(),
        unlocked: [],
        touchedAt: null,
      };
      world.overlay.set(tic, item);
    }
    return item;
  };

  /** A seeded real signal found without a receipt (fallback only). */
  const markFound = (
    world: World,
    star: RealSampleStar,
    candidate: RealCandidate,
  ) => {
    const item = ensureIn(world, star.ticId);
    if (item.matched.has(candidate.candidateId)) return;
    item.matched.add(candidate.candidateId);
    item.dispositions.set(candidate.candidateId, DISPOSITION[candidate.kind]);
    world.recognized.add(`${star.ticId}:${candidate.candidateId}`);
    item.achievements += 1;
    item.byType[kindOf(candidate)] += 1;
    if (candidate.kind !== "fp")
      item.planets.set(candidate.candidateId, realPlanet(candidate));
  };

  const buildWorld = (id: DemoScenarioId, size?: number): World => {
    const scenario = DEMO_SCENARIOS[id];
    const wanted =
      id === "newcomer"
        ? scenario.starCount
        : (size ?? (id === "member" ? memberStars : scenario.starCount));
    const count = Math.min(
      DEMO_STAR_RANGE.max,
      Math.max(id === "newcomer" ? 5 : DEMO_STAR_RANGE.min, wanted),
    );
    const placement = placementFor(id);
    const ticOf = (i: number) =>
      placement.get(i)?.ticId ?? String(GALAXY_TIC_BASE + i);
    const galaxy = captureGalaxy(count, {
      ticFor: ticOf,
      starFor: (i, star) => seededStar(scenario, placement, i, star),
    });
    const world: World = {
      scenario,
      size: count,
      galaxy,
      placement,
      ticOf,
      overlay: new Map(),
      recognized: new Set(),
      residualTics: new Map(),
      unlocked: [],
      publication: createPublicationFixture(),
      onboardingDone: scenario.onboardingDone,
      follows: new Map(),
      log: [],
      seeds: [],
    };
    for (const seq of scenario.completedTutorials)
      invoke(galaxy, "POST", `/dev-galaxy-204/complete-tutorial?seq=${seq}`);
    let explore = 0;
    for (const [ordinal, star] of [...placement].sort((a, b) => a[0] - b[0])) {
      if (ordinal >= count) continue;
      const done =
        star.role === "tutorial"
          ? scenario.completedTutorials.includes(star.tutorialSeq ?? 0)
          : id === "veteran" && explore++ % 2 === 1;
      if (done) world.seeds.push(star);
    }
    for (const memberId of scenario.following) {
      const other = publicMember(memberId);
      if (other)
        world.follows.set(`MEMBER:${memberId}`, {
          kind: "MEMBER",
          id: memberId,
          label: other.nickname,
        });
    }
    resetSubmissionFixtures(freshSequence());
    resetResidualFixture();
    revision++;
    return world;
  };

  let world = buildWorld(options.scenario ?? "member");

  // ------------------------------------------------------------ my sky

  const innerVersion = (): string =>
    invoke(world.galaxy, "GET", "/v1/me/sky").body.version;
  const outward = (inner: string) => `${inner}~c${revision}`;
  const locate = (tic: string): Json | null => {
    if (!/^\d+$/.test(tic)) return null;
    const reply = invoke(world.galaxy, "GET", `/v1/me/sky/locate?ticId=${tic}`);
    return reply.status === 200 ? reply.body : null;
  };
  const isGalaxyStar = (tic: string) => locate(tic) !== null;
  /** A real star of this world (only reachable once it is in the galaxy). */
  const realOf = (tic: string): RealSampleStar | null =>
    realByTic.get(tic) ?? null;
  /** An analysis-fixture TIC that no real star of the sample takes over. */
  const fixtureOnly = (tic: string) =>
    fixtureTics.has(tic) && !realByTic.has(tic);

  const stageOf = (star: Json): Stage => {
    const extra = world.overlay.get(String(star.ticId))?.stage ?? "unexplored";
    const base = (star.progressStage ?? star.stage ?? "unexplored") as Stage;
    return STAGE_ORDER[
      Math.max(STAGE_ORDER.indexOf(base), STAGE_ORDER.indexOf(extra))
    ];
  };
  const extraPlanets = (tic: string) => [
    ...(world.overlay.get(tic)?.planets.values() ?? []),
  ];
  const ensure = (tic: string): StarOverlay => ensureIn(world, tic);

  /** The member's progress on a real star, for its analysis reads. */
  const stateOf = (tic: string): RealStarState => {
    const detail = invoke(world.galaxy, "GET", `/v1/me/stars/${tic}`);
    const base = detail.status === 200 ? detail.body.progress.stage : null;
    return {
      stage: stageOf({ ticId: tic, progressStage: base ?? "unexplored" }),
      matchedCandidateIds: [
        ...(world.overlay.get(tic)?.matched ?? new Set<string>()),
      ].sort(),
    };
  };

  /** Tile/list star with the member's cinema progress applied. */
  const patchStar = (star: Json): Json => {
    const tic = String(star.ticId);
    if (!world.overlay.has(tic)) return star;
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
    const extra = world.overlay.get(tic);
    if (!extra) return item;
    const star = patchStar(item);
    const count = item.achievementCount + extra.achievements;
    return {
      ...star,
      achievementCount: count,
      grade: count > 0 ? grade(count) : null,
      currentCurveStep: star.progressStage === "unexplored" ? null : 0,
    };
  };
  const patchDetail = (body: Json): Json => {
    const tic = String(body.ticId);
    body.version = outward(body.version);
    const ordinal = Number(body.unlock?.position?.layoutOrdinal);
    if (Number.isInteger(ordinal) && ordinal >= 5) {
      body.unlock.reason = "achievement";
      if (world.unlocked.includes(tic))
        body.unlock.unlockedAt =
          [...world.overlay.values()]
            .flatMap((item) => item.unlocked)
            .find((star) => star.ticId === tic)?.unlockedAt ??
          "2026-09-26T09:00:00Z";
    }
    const real = realOf(tic);
    const round = (value: number | null | undefined, digits: number) =>
      typeof value === "number" && Number.isFinite(value)
        ? Number(value.toFixed(digits))
        : null;
    if (real)
      body.star = {
        sectorCount: real.sectors.length,
        sectors: [...real.sectors],
        tmag: round(real.tmag, 2),
        teffK: round(real.teffK, 0),
        radiusRsun: round(real.radiusRsun, 2),
      };
    else if (Array.isArray(body.planets?.items))
      body.planets.items = body.planets.items.map(
        (planet: OwnedPlanet, index: number) =>
          syntheticPlanet(tic, ordinal, planet, index),
      );
    const extra = world.overlay.get(tic);
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
    body.progress = {
      ...body.progress,
      stage,
      completionReason:
        stage === "completed" && real
          ? "all_found"
          : body.progress.completionReason,
    };
    const count = body.achievement.count + extra.achievements;
    body.achievement = {
      count,
      grade: count > 0 ? grade(count) : null,
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
    const galaxy = world.galaxy;
    if (path.startsWith("/dev-galaxy-204/")) {
      const reply = invoke(galaxy, method, path + url.search);
      if (path.endsWith("/reset")) {
        world.overlay.clear();
        world.recognized.clear();
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
    // My page "내 별" (4.4 default scope `submitted`): this world's explored
    // stars, not the my-lists fixture's unrelated TICs.
    if (path === "/v1/me/stars" && method === "GET") return myStarList(url);
    if (/^\/v1\/me\/stars\/[^/]+$/.test(path)) {
      const reply = invoke(galaxy, method, path);
      if (reply.status === 200) patchDetail(reply.body);
      return reply;
    }
    if (path === "/v1/me/quests" || path === "/v1/challenges/current") {
      const reply = invoke(galaxy, method, path);
      // The challenge round runs this week, not a fixed past week.
      const round =
        path === "/v1/me/quests"
          ? record(record(reply.body?.challenge)?.round)
          : record(reply.body?.round);
      if (round) Object.assign(round, thisWeek());
      return reply;
    }
    return null;
  };

  /** Monday..Sunday of the current week (Asia/Seoul), as the round dates. */
  const thisWeek = () => {
    const now = new Date(Date.now() + 9 * 3600_000);
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
      startsOn: monday.toISOString().slice(0, 10),
      endsOn: sunday.toISOString().slice(0, 10),
    };
  };

  /** 4.4 list row for a patched tile star of this world. */
  const myStarRow = (star: Json): Json => {
    const tic = String(star.ticId);
    const extra = world.overlay.get(tic);
    const base = star.planetCount - (extra?.planets.size ?? 0);
    const achievements = Math.max(0, base) + (extra?.achievements ?? 0);
    return {
      ticId: tic,
      progressStage: star.progressStage,
      planetCount: star.planetCount,
      completedWithoutPlanets: star.completedWithoutPlanets,
      achievementCount: achievements,
      grade: achievements > 0 ? grade(achievements) : null,
      currentCurveStep: extra?.matched.size ?? 0,
      reopenPending: false,
      reopened: Boolean(star.reopened),
      unpublishedSignalCount: 0,
      lastActivityAt: extra?.touchedAt ?? seededAt(tic),
      unlockReason:
        star.marker?.type === "tutorial" ? "tutorial" : "achievement",
      marker: null,
    };
  };
  const myStarList = (url: URL): Reply => {
    const size = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("size") ?? 20) || 20),
    );
    const offset = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
    const rows = allStars()
      .filter((star) => star.progressStage !== "unexplored")
      .map(myStarRow)
      .sort((a, b) =>
        a.lastActivityAt === b.lastActivityAt
          ? a.ticId < b.ticId
            ? -1
            : 1
          : a.lastActivityAt < b.lastActivityAt
            ? 1
            : -1,
      );
    const more = rows.length > offset + size;
    return {
      status: 200,
      body: {
        items: rows.slice(offset, offset + size),
        nextCursor: more ? String(offset + size) : null,
        hasNext: more,
      },
    };
  };

  /** Every star of the current sky (patched), for the summary. Cached. */
  let starsCache: { version: string; stars: Json[] } | null = null;
  const allStars = (): Json[] => {
    const meta = invoke(world.galaxy, "GET", "/v1/me/sky").body;
    const version = outward(meta.version);
    if (starsCache?.version === version) return starsCache.stars;
    const stars: Json[] = [];
    if (meta.starCount > 0) {
      const b = meta.bounds;
      const query = new URLSearchParams({
        level: String(meta.zoomLevels[0].level),
        x: String(Math.floor(b.minX)),
        y: String(Math.floor(b.minY)),
        w: String(Math.max(1, Math.ceil(b.maxX - b.minX) + 1)),
        h: String(Math.max(1, Math.ceil(b.maxY - b.minY) + 1)),
        version: meta.version,
        limit: "2000",
      });
      for (let guard = 0; guard < 100; guard++) {
        const reply = invoke(world.galaxy, "GET", `/v1/me/sky/tiles?${query}`);
        if (reply.status !== 200) break;
        stars.push(...reply.body.stars.map(patchStar));
        if (!reply.body.nextCursor) break;
        query.set("cursor", reply.body.nextCursor);
      }
    }
    starsCache = { version, stars };
    return stars;
  };
  const achievementSummary = () => {
    const stars = allStars();
    let completed = 0,
      confirmed = 0,
      unconfirmed = 0,
      fp = 0,
      signals = 0;
    const byGrade = { A: 0, S: 0, SS: 0, SSS: 0 };
    for (const star of stars) {
      if (star.progressStage === "completed") completed++;
      const extra = world.overlay.get(String(star.ticId));
      // Fixture planets alternate confirmed / candidate (galaxy fixture).
      const base = star.planetCount - (extra?.planets.size ?? 0);
      confirmed += Math.ceil(base / 2) + (extra?.byType.confirmed ?? 0);
      unconfirmed += Math.floor(base / 2);
      for (const planet of extra?.planets.values() ?? [])
        if (planet.kind === "unconfirmed") unconfirmed++;
      fp += extra?.byType.fp ?? 0;
      const achievements = base + (extra?.achievements ?? 0);
      signals += achievements;
      if (achievements > 0) byGrade[grade(achievements)]++;
    }
    return {
      discoveredStarCount: stars.length,
      completedStarCount: completed,
      signalCount: signals,
      byType: { confirmed, unconfirmed, fp },
      starCountByGrade: byGrade,
    };
  };
  const tutorialsDone = () =>
    Number(
      invoke(world.galaxy, "GET", "/v1/me/quests").body?.tutorial
        ?.completedCount ?? 0,
    );
  const completeTutorial = (seq: number) => {
    invoke(
      world.galaxy,
      "POST",
      `/dev-galaxy-204/complete-tutorial?seq=${seq}`,
    );
  };

  /** 4.2.1 planet explanations for the member's current planets. */
  const explanations = (tic: string): Reply => {
    const detail = invoke(world.galaxy, "GET", `/v1/me/stars/${tic}`);
    if (detail.status !== 200) return detail;
    const body = patchDetail(detail.body);
    const real = realOf(tic);
    const at = "2026-09-25T05:20:00Z";
    const measure = (value: string | null, unit: string) => ({
      value,
      errorPlus: null,
      errorMinus: null,
      limit: value === null ? null : 0,
      unit,
      reference: null,
    });
    const items = body.planets.items.map(
      (planet: OwnedPlanet, index: number) => {
        const confirmed = planet.kind === "confirmed";
        const source = real?.candidates.find(
          (c) => c.candidateId === planet.candidateId,
        );
        // A synthetic planet has no NASA record: say so, never invent one.
        if (confirmed && !source)
          return {
            candidateId: planet.candidateId,
            kind: planet.kind,
            status: "source_unavailable",
            content: null,
            facts: null,
            sourceStatus: "not_found",
            fetchedAt: at,
            refreshStatus: "ok",
            generatedAt: null,
            retryAt: null,
            failure: null,
          };
        const letter = String.fromCharCode(98 + index);
        const name = source?.planetName ?? `TIC ${tic} ${letter}`;
        const period = planet.periodDays ?? source?.periodDays ?? 0;
        const radius = source?.radiusEarth ?? null;
        const year = source?.discoveryYear ?? null;
        return {
          candidateId: planet.candidateId,
          kind: planet.kind,
          status: confirmed ? "ready" : "not_applicable",
          content: confirmed
            ? {
                name: `${name}에 대해 알아볼까요?`,
                orbitalPeriod: `별을 한 바퀴 도는 데 ${period.toFixed(2)}일이 걸려요.`,
                radius:
                  radius === null
                    ? "반지름은 아직 알 수 없어요."
                    : `반지름은 지구의 ${radius.toFixed(2)}배예요.`,
                // The sample carries no mass; do not claim it is unknown.
                mass: "질량은 이 설명에서 다루지 않아요.",
                discovery: year
                  ? `${year}년에 별 앞을 지나는 모습(통과)으로 발견됐어요.`
                  : "별 앞을 지나는 모습(통과)으로 발견됐어요.",
              }
            : null,
          facts: confirmed
            ? {
                planetName: name,
                orbitalPeriod: measure(period.toFixed(4), "days"),
                radius: measure(
                  radius === null ? null : radius.toFixed(2),
                  "earth_radius",
                ),
                mass: measure(null, "earth_mass"),
                discoveryMethod: "Transit",
                discoveryYear: year,
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

  /** Analysis reads: real stars from the sample, others the synthetic one. */
  const analysisReply = (
    url: URL,
  ): { status: number; body: unknown; currentBundleId?: string } | null => {
    const match =
      /^\/v1\/stars\/([^/]+)\/(analysis-context|curves|periodogram|candidate-peaks)$/.exec(
        url.pathname,
      );
    if (!match) return null;
    const tic = decodeURIComponent(match[1]);
    if (fixtureOnly(tic))
      return periodogramFixtureResponse(url) ?? analysisFixtureResponse(url);
    if (!isGalaxyStar(tic))
      return {
        status: 403,
        body: failure("STAR_LOCKED", "아직 열리지 않은 별입니다."),
      };
    const real = realOf(tic);
    if (real) return realAnalysisResponse(real, url, stateOf(tic));
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
   * unlocks one new star. Real stars complete when every signal is found
   * (SUB-11 all_found); a tutorial star completes its quest. The first
   * submission on tutorial 1 completes the first-visit guide (AT-86).
   * Mutates the stored result in place so replays and by-request recovery
   * return exactly what was first sent. `seedTime` marks a submission made
   * "before" this world (`seedWorld`): its time is in the past and it
   * unlocks no star (the scenario's galaxy size already counts them).
   */
  const applySubmission = (
    tic: string,
    input: Json,
    result: Json,
    windowMiss: boolean,
    seedTime?: string,
  ) => {
    const galaxyStar = !fixtureOnly(tic);
    if (windowMiss) {
      const context = record(contextFor(tic)?.body);
      toNotMatched(
        result,
        (record(context?.progress)?.matchedCandidateIds as string[]) ?? [],
      );
    }
    // Received now, not on the fixture's fixed date. Nobody else has judged
    // this signal in a demo world: no invented "10명 중 70%".
    const now = seedTime ?? new Date().toISOString();
    result.submittedAt = now;
    const statistics = record(result.judgmentStatistics);
    if (statistics?.kind === "public_analyses")
      result.judgmentStatistics = {
        ...statistics,
        participantCount: 0,
        likelyPlanet: 0,
        unlikelyPlanet: 0,
        unsure: 0,
        percentages: null,
        asOf: now,
      };
    else result.judgmentStatistics = null;
    if (galaxyStar) {
      const galaxy = world.galaxy;
      const real = realOf(tic);
      const ordinal = Number(locate(tic)?.layoutOrdinal ?? -1);
      const item = ensure(tic);
      item.touchedAt = now;
      world.log.push(result);
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
          depthPpm: Math.round(Number(signal.bls.depthPpm)),
        };
        if (signal.disposition === "CONFIRMED")
          item.planets.set(planet.candidateId, planet);
        else if (signal.disposition === "UNCONFIRMED") {
          if (input.userJudgment === "LIKELY_PLANET")
            item.planets.set(planet.candidateId, planet);
          else item.planets.delete(planet.candidateId);
        }
        item.matched.add(planet.candidateId);
        item.dispositions.set(planet.candidateId, String(signal.disposition));
        item.submissions.set(planet.candidateId, [
          ...(item.submissions.get(planet.candidateId) ?? []),
          String(result.submissionId),
        ]);
      }
      const achievement = record(result.achievement);
      if (achievement?.result === "recognized" && signal) {
        world.recognized.add(`${tic}:${signal.candidateId}`);
        item.achievements += 1;
        const type =
          signal.disposition === "CONFIRMED"
            ? "confirmed"
            : signal.disposition === "FP"
              ? "fp"
              : "unconfirmed";
        item.byType[type] += 1;
        let located: Json | null = null;
        let newTic = "";
        if (!seedTime && unlockStars) {
          const before = invoke(galaxy, "GET", "/v1/me/sky").body.starCount;
          invoke(galaxy, "POST", "/dev-galaxy-204/change");
          newTic = world.ticOf(before);
          located = locate(newTic);
        }
        achievement.unlockedStars = located
          ? [
              {
                ticId: newTic,
                position: {
                  worldX: located.x,
                  worldY: located.y,
                  depthZ: located.depthZ,
                  layoutVersion: LAYOUT_VERSION,
                },
              },
            ]
          : [];
        if (located) {
          world.unlocked.push(newTic);
          item.unlocked.push({
            ticId: newTic,
            unlockedAt: now,
            achievementId: `ach-${String(result.submissionId).slice(4)}`,
          });
        }
        achievement.star = {
          ...achievement.star,
          count: item.achievements,
          grade: grade(item.achievements),
        };
      } else if (achievement) achievement.unlockedStars = [];

      // Completion: a real star once every signal is found; a synthetic
      // tutorial star with its first recognized signal.
      const progress = record(result.progress);
      let complete = false;
      if (real) {
        const remaining = real.candidates.filter(
          (c) => !item.matched.has(c.candidateId),
        ).length;
        complete = remaining === 0;
        if (progress) {
          progress.matchedCandidateIds = [...item.matched].sort();
          progress.remainingDiscoverableCount = remaining;
        }
      } else if (ordinal >= 0 && ordinal < 5)
        complete = achievement?.result === "recognized";
      if (complete) {
        item.stage = "completed";
        if (progress) {
          progress.stage = "completed";
          progress.completionReason = "all_found";
        }
        const seq = real
          ? real.role === "tutorial"
            ? (real.tutorialSeq ?? 0)
            : 0
          : ordinal + 1;
        if (seq >= 1 && seq <= 5 && ordinal === seq - 1) completeTutorial(seq);
      }
      if (ordinal === 0) world.onboardingDone = true;
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
    const removed = strings(record(input?.curveContext)?.removedCandidateIds);
    const real = tic ? realOf(tic) : null;
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
      if (real) {
        // Same signal found again on this star: duplicate (no new unlock).
        const match = matchRealSelection(
          real,
          {
            periodDays: Number(selection.periodDays),
            sourcePeakGridIndex: grid,
            phaseStart: Number(selection.phaseStart),
            phaseEnd: Number(selection.phaseEnd),
          },
          { removedCandidateIds: removed },
        );
        if (
          !outcome &&
          match &&
          (!windowRule || match.windowCovered) &&
          world.recognized.has(`${tic}:${match.candidate.candidateId}`)
        )
          outcome = "duplicate";
      } else {
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
          if (candidate && world.recognized.has(`${tic}:${candidate}`))
            outcome = "duplicate";
        }
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
      matchSignal: (ticId, chosen) => {
        const star = realOf(ticId);
        return star
          ? realMatchSignal(star, chosen, {
              windowRule,
              removedCandidateIds: removed,
            })
          : undefined;
      },
      detailSignal: (ticId, matchedId) => {
        const star = realOf(ticId);
        return star
          ? realDetailSignal(star, matchedId, [
              ...(world.overlay.get(ticId)?.matched ?? []),
            ])
          : undefined;
      },
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

  /**
   * A real star this member explored before the world starts: each signal
   * submitted once, in order, through the same submission fixture as a live
   * submission (direct period, a window over its dip, the judgment that
   * agrees). So My page history, star results and "기록 보기" all have real
   * receipts. A signal the fixture would not match is marked found without one.
   */
  const seedReal = (star: RealSampleStar) => {
    const tic = star.ticId;
    star.candidates.forEach((candidate, k) => {
      const item = ensure(tic);
      if (item.matched.has(candidate.candidateId)) return;
      const removed = [...item.matched].sort();
      const period = candidate.periodDays;
      const width = Math.min(
        0.24,
        Math.max(
          (candidate.durationHours / 24 / period) * 1.4,
          30 / 1440 / period,
        ),
      );
      const center = dipPhases(star, candidate, period)[0] ?? 0;
      const phaseStart = Number(
        ((((center - width / 2) % 1) + 1) % 1).toFixed(6),
      );
      const input: Json = {
        requestId: randomUUID(),
        submissionKind: "candidate",
        curveContext: {
          bundleId: REAL_SAMPLE_BUNDLE,
          curveStep: removed.length,
          removedCandidateIds: removed,
          residualModelVersion: REAL_SAMPLE_VERSIONS.residualModel,
          periodogramConfigVersion: REAL_SAMPLE_VERSIONS.periodogramConfig,
        },
        selection: {
          periodDays: period,
          sourcePeakGridIndex: null,
          phaseStart,
          phaseEnd: Number((phaseStart + width).toFixed(6)),
        },
        userJudgment:
          candidate.kind === "fp" ? "UNLIKELY_PLANET" : "LIKELY_PLANET",
        evidenceChecks: [],
        memo: "",
      };
      const reply = submissionFixtureResponse({
        method: "POST",
        url: new URL(`/v1/stars/${tic}/submissions`, "http://fixture.invalid"),
        csrf: SUBMISSION_FIXTURE_CSRF,
        scenario: null,
        outcome: null,
        body: input,
        contextFor,
        matchSignal: (_tic, chosen) =>
          realMatchSignal(star, chosen, {
            windowRule,
            removedCandidateIds: removed,
          }),
      });
      const result =
        reply?.kind === "json" && reply.status === 201
          ? record(reply.body)
          : null;
      const match = record(result?.match);
      if (
        result &&
        FOUND.has(String(match?.status)) &&
        match?.candidateId === candidate.candidateId
      )
        applySubmission(
          tic,
          input,
          result,
          false,
          new Date(Date.parse(seededAt(tic)) + k * 26 * 3600_000).toISOString(),
        );
      else markFound(world, star, candidate);
    });
    ensure(tic).stage = "completed";
  };
  /** Submits the seeds of a world that was just put in place. */
  const seedWorld = () => {
    const seeds = world.seeds;
    world.seeds = [];
    for (const star of seeds) seedReal(star);
    // Seeds happen "before" the world: nothing is newly unlocked by them.
    world.unlocked = [];
    starsCache = null;
  };

  /** A receipt of this world by submission id. */
  const receiptOf = (submissionId: string): Json | null =>
    world.log.find((entry) => entry.submissionId === submissionId) ?? null;
  const aiOf = (value: unknown): Json => {
    const ai = record(value);
    return ai && typeof ai.status === "string"
      ? ai
      : { status: "not_evaluated", modelVersion: null };
  };

  /**
   * Star result (8.4) from this world: the signals found here (real
   * candidates, or a synthetic star's planets), each with its own
   * submissions, the unmatched submissions and one curve step per signal.
   * Signals explored before this world (seeded) carry one seeded id and no
   * history link.
   */
  const worldStarResult = (tic: string): Json => {
    const body = starResultFixture(tic) as Json;
    const detailReply = invoke(world.galaxy, "GET", `/v1/me/stars/${tic}`);
    const detail =
      detailReply.status === 200 ? patchDetail(detailReply.body) : null;
    const real = realOf(tic);
    const item = world.overlay.get(tic);
    const stage = (detail?.progress.stage ??
      stageOf({ ticId: tic, progressStage: "unexplored" })) as Stage;
    type Found = { candidateId: string; disposition: string; ai: unknown };
    const found: Found[] = [];
    const add = (candidateId: string, disposition: string, ai: unknown) => {
      if (!found.some((entry) => entry.candidateId === candidateId))
        found.push({ candidateId, disposition, ai });
    };
    // A synthetic star's seeded planets were found before this world.
    if (!real && detail)
      for (const planet of detail.planets.items as OwnedPlanet[])
        if (!item?.matched.has(planet.candidateId))
          add(
            planet.candidateId,
            planet.kind === "confirmed" ? "CONFIRMED" : "UNCONFIRMED",
            null,
          );
    for (const id of item?.matched ?? []) {
      const candidate = real?.candidates.find((c) => c.candidateId === id);
      add(
        id,
        candidate
          ? DISPOSITION[candidate.kind]
          : (item?.dispositions.get(id) ?? "CONFIRMED"),
        candidate?.ai
          ? {
              status: "completed",
              score: candidate.ai.score,
              verdict: candidate.ai.verdict,
              modelVersion: candidate.ai.modelVersion,
            }
          : null,
      );
    }
    const signals = found.map((entry, index) => {
      const ids = item?.submissions.get(entry.candidateId) ?? [];
      const receipts = ids.map(receiptOf).filter((r): r is Json => r !== null);
      const latest = receipts[receipts.length - 1] ?? null;
      const first = receipts.find((r) =>
        ["matched", "matched_harmonic"].includes(String(r.match?.status)),
      );
      const recognized = receipts.find(
        (r) => r.achievement?.result === "recognized",
      );
      const seeded = !latest;
      const candidateSignal = entry.disposition === "UNCONFIRMED";
      const achievement = seeded
        ? "recognized"
        : recognized
          ? "recognized"
          : String(latest.achievement?.result ?? "none");
      const publicationState = seeded
        ? candidateSignal
          ? "PUBLISHED"
          : "NOT_ELIGIBLE"
        : String(latest.publication?.state ?? "NOT_ELIGIBLE");
      return {
        candidateId: entry.candidateId,
        disposition: entry.disposition,
        status: "active",
        latestSubmissionId: latest
          ? String(latest.submissionId)
          : `sub-${tic}-${index + 1}`,
        latestHistoryId: latest ? String(latest.historyId) : null,
        submissionIds: ids.length ? [...ids] : [`sub-${tic}-${index + 1}`],
        threadId: null,
        matchResult: String(first?.match?.status ?? "matched"),
        userJudgment: seeded
          ? entry.disposition === "FP"
            ? "UNLIKELY_PLANET"
            : "LIKELY_PLANET"
          : (latest.original?.userJudgment ?? null),
        judgmentEvaluation: seeded
          ? candidateSignal
            ? "UNSCORED"
            : "AGREES"
          : (latest.judgment?.evaluation ?? null),
        achievement: {
          result: achievement,
          recognizedAt:
            achievement !== "recognized"
              ? null
              : recognized
                ? String(recognized.submittedAt)
                : seededAt(tic, index),
        },
        publication: { state: publicationState, publicAnalysisId: null },
        ai: aiOf(latest?.signal?.ai ?? entry.ai),
        judgmentStatistics: null,
        relabel: null,
        curveStepAtMatch: index,
      };
    });
    const order = signals.map((signal) => signal.candidateId);
    const unmatched = world.log
      .filter(
        (r) =>
          r.ticId === tic &&
          ["not_matched", "ambiguous_match", "none_wrong", "skipped"].includes(
            String(r.match?.status),
          ),
      )
      .map((r) => ({
        submissionId: String(r.submissionId),
        historyId: String(r.historyId),
        matchResult: String(r.match.status),
        submittedAt: String(r.submittedAt),
      }));
    const steps =
      stage === "completed" ? Math.max(1, order.length) : order.length + 1;
    const unpublished = signals.filter(
      (signal) => signal.publication.state === "UNPUBLISHED",
    ).length;
    const context = record(contextFor(tic)?.body);
    body.star = {
      sectorCount: detail?.star.sectorCount ?? 1,
      tmag: detail?.star.tmag ?? null,
    };
    body.bundle = {
      bundleId: real
        ? REAL_SAMPLE_BUNDLE
        : String(
            record(context?.currentCurveContext)?.bundleId ??
              ANALYSIS_FIXTURE_BUNDLE,
          ),
      publishedAt: "2026-09-26T00:00:00Z",
    };
    body.progress = {
      stage,
      completionReason: stage === "completed" ? "all_found" : null,
      reopenPending: false,
      currentCurveStep: order.length,
      matchedCandidateIds: [...order].sort(),
      remainingDiscoverableCount: real
        ? real.candidates.filter((c) => !item?.matched.has(c.candidateId))
            .length
        : stage === "completed"
          ? 0
          : 1,
    };
    body.achievement = detail?.achievement ?? {
      count: 0,
      grade: null,
      byType: { confirmed: 0, unconfirmed: 0, fp: 0 },
    };
    body.signals = signals;
    body.unmatchedSubmissions = unmatched;
    body.curveSteps = Array.from({ length: steps }, (_, step) => ({
      curveStep: step,
      removedCandidateIds: order.slice(0, step),
      residual: { status: "COMPLETED", jobId: null, computedAt: null },
    }));
    body.discoveredStars = (item?.unlocked ?? []).map((star) => ({
      ticId: star.ticId,
      unlockedAt: star.unlockedAt,
      triggerAchievementId: star.achievementId,
    }));
    body.unpublishedSignalCount = unpublished;
    body.links = { boardOpen: true, threadIds: [] };
    // No batch publication fixture for this world: no "모두 게시 검토".
    body.nextActions = unpublished ? ["LATER"] : [];
    return body;
  };

  // ------------------------------------------------------------ my history

  /** 8.1 row for a receipt of this world. */
  const historyRow = (r: Json): Json => {
    const status = String(r.match?.status);
    return {
      historyId: String(r.historyId),
      submissionId: String(r.submissionId),
      ticId: String(r.ticId),
      candidateId:
        typeof r.match?.candidateId === "string" ? r.match.candidateId : null,
      submissionKind: String(r.submissionKind),
      matchResult: status,
      userJudgment: r.original?.userJudgment ?? null,
      achievementResult: r.achievement?.result ?? null,
      submittedAt: String(r.submittedAt),
      bundleId: typeof r.bundleId === "string" ? r.bundleId : null,
      isPreviousBundle: false,
      curveStep: Number(r.curveContext?.curveStep ?? 0),
      publication: {
        publicAnalysisId: null,
        isPublic: false,
        isModerationHidden: false,
      },
      achievementGranted: r.achievement?.result === "recognized",
      snapshotAvailable:
        FOUND.has(status) && typeof r.original?.periodDays === "number",
      detailAvailable: true,
      answerViewed: Boolean(r.detail?.answerViewed),
      relabel: null,
      retryOfSubmissionId: null,
    };
  };
  /** GET /v1/me/histories (8.1): this world's submissions, newest first. */
  const myHistoryList = (url: URL): Reply => {
    const q = url.searchParams;
    const result = q.get("result") ?? "";
    const rows = [...world.log]
      .reverse()
      .sort((a, b) =>
        a.submittedAt === b.submittedAt
          ? 0
          : String(a.submittedAt) < String(b.submittedAt)
            ? 1
            : -1,
      )
      .filter((r) => {
        const status = String(r.match?.status);
        if (result === "matched" && !FOUND.has(status)) return false;
        if (result && result !== "matched" && status !== result) return false;
        if (q.get("ticId") && r.ticId !== q.get("ticId")) return false;
        if (
          q.get("candidateId") &&
          r.match?.candidateId !== q.get("candidateId")
        )
          return false;
        return true;
      })
      .map(historyRow);
    const size = Math.min(100, Math.max(1, Number(q.get("size") ?? 20) || 20));
    const offset = Math.max(0, Number(q.get("cursor")) || 0);
    const more = rows.length > offset + size;
    return {
      status: 200,
      body: {
        items: rows.slice(offset, offset + size),
        nextCursor: more ? String(offset + size) : null,
        hasNext: more,
      },
    };
  };

  /** The curve a receipt was submitted on (its curve context), or null. */
  const receiptCurve = (r: Json): Json | null => {
    const ctx = record(r.curveContext);
    if (!ctx) return null;
    const url = new URL(
      `/v1/stars/${encodeURIComponent(String(r.ticId))}/curves`,
      "http://fixture.invalid",
    );
    url.searchParams.set("bundleId", String(ctx.bundleId));
    url.searchParams.set("curveStep", String(ctx.curveStep));
    url.searchParams.set("removed", strings(ctx.removedCandidateIds).join(","));
    const reply = analysisReply(url);
    const body = reply?.status === 200 ? record(reply.body) : null;
    return body && Array.isArray(body.segments) ? body : null;
  };

  /** 150-bin folded snapshot (8.3 SUBMITTED): median flux, MAD error. */
  const foldSnapshot = (curve: Json, period: number, reference: number) => {
    const BINS = 150;
    const cells: number[][] = Array.from({ length: BINS }, () => []);
    for (const segment of curve.segments as Json[]) {
      const flux = segment.flux as (number | null)[];
      for (let i = 0; i < flux.length; i++) {
        const value = flux[i];
        if (value === null || !Number.isFinite(value)) continue;
        const t =
          Number(segment.startBtjd) +
          ((i + 0.5) * Number(segment.binMinutes)) / 1440;
        let phase = ((t - reference) / period) % 1;
        if (phase < 0) phase += 1;
        const centered = phase >= 0.5 ? phase - 1 : phase;
        const k = Math.min(BINS - 1, Math.floor((centered + 0.5) * BINS));
        cells[k].push(value);
      }
    }
    const middle = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const half = sorted.length >> 1;
      return sorted.length % 2
        ? sorted[half]
        : (sorted[half - 1] + sorted[half]) / 2;
    };
    const foldedFlux: (number | null)[] = [];
    const foldedError: (number | null)[] = [];
    for (const cell of cells) {
      if (!cell.length) {
        foldedFlux.push(null);
        foldedError.push(null);
        continue;
      }
      const center = middle(cell);
      const mad = middle(cell.map((v) => Math.abs(v - center)));
      foldedFlux.push(Number(center.toFixed(6)));
      foldedError.push(
        Number(((1.4826 * mad) / Math.sqrt(cell.length)).toFixed(6)),
      );
    }
    return { bins: BINS, foldedFlux, foldedError };
  };

  /** GET /v1/histories/:id and /graph (8.2, 8.3) for this world's receipts. */
  const historyReply = (url: URL): Reply | null => {
    const match = /^\/v1\/histories\/([^/]+)(\/graph)?$/.exec(url.pathname);
    if (!match) return null;
    const historyId = decodeURIComponent(match[1]);
    const r = world.log.find((entry) => entry.historyId === historyId);
    if (!r) return null;
    const original = record(r.original) ?? {};
    const derived = record(r.serverDerived) ?? {};
    const outcome = record(r.match) ?? {};
    const status = String(outcome.status);
    const period =
      typeof original.periodDays === "number" ? original.periodDays : null;
    const reference = Number(derived.foldReferenceTimeBtjd);
    const curve = receiptCurve(r);
    const bundle = String(curve?.bundleId ?? r.bundleId);
    if (!match[2]) {
      const real = realOf(String(r.ticId));
      return {
        status: 200,
        body: {
          historyId,
          submission: r,
          versions: {
            data: real
              ? `TESS ${real.sectors.map((s) => `S${s}`).join("·")}`
              : "sec-14-41-54/r1",
            preprocess: null,
            pipeline: null,
            rule: typeof r.ruleVersion === "string" ? r.ruleVersion : null,
            residualModel: r.curveContext?.residualModelVersion ?? null,
            periodogramConfig: r.curveContext?.periodogramConfigVersion ?? null,
            snapshotVersion: FOUND.has(status) ? "folded-mad-v1" : null,
          },
          snapshotParams: {
            periodogramViewport: period
              ? {
                  minDays: Number((period * 0.8).toFixed(4)),
                  maxDays: Number((period * 1.25).toFixed(4)),
                }
              : null,
            foldedXZoomRatio: 4,
            foldSettings: Number.isFinite(reference)
              ? { referenceTimeBtjd: reference }
              : null,
            centroidDataStatus: "unavailable",
          },
          isPreviousBundle: false,
          relabel: null,
          createdAt: String(r.submittedAt),
        },
      };
    }
    const mode = url.searchParams.get("mode") ?? "CURRENT";
    if (mode !== "CURRENT" && mode !== "SUBMITTED")
      return {
        status: 400,
        body: failure("VALIDATION_FAILED", "mode 값을 확인해 주세요."),
      };
    const harmonic =
      typeof outcome.harmonicMultiplier === "number"
        ? outcome.harmonicMultiplier
        : null;
    const corrected =
      typeof outcome.correctedPeriodDays === "number"
        ? outcome.correctedPeriodDays
        : harmonic && period
          ? period * harmonic
          : null;
    const common = {
      historyId,
      reproduction: {
        submittedBundleId: String(r.bundleId),
        currentBundleId: bundle,
        isPreviousSubmission: false,
        residualReproducible: curve !== null,
        fallbackReason: null,
        currentFoldReferenceTimeBtjd: Number.isFinite(reference)
          ? reference
          : null,
      },
      snapshotVersion: "folded-mad-v1",
    };
    const selection = {
      userPeriodDays: period,
      correctedPeriodDays: corrected,
      harmonicMultiplier: harmonic,
      epochBtjd:
        typeof derived.epochBtjd === "number" ? derived.epochBtjd : null,
      durationHours:
        typeof derived.durationHours === "number"
          ? derived.durationHours
          : null,
    };
    if (mode === "SUBMITTED")
      return {
        status: 200,
        body: {
          ...common,
          selection: {
            ...selection,
            currentPhaseStart: null,
            currentPhaseEnd: null,
          },
          curve: null,
          snapshot:
            FOUND.has(status) && curve && period && Number.isFinite(reference)
              ? foldSnapshot(curve, period, reference)
              : null,
        },
      };
    return {
      status: 200,
      body: {
        ...common,
        selection: {
          ...selection,
          currentPhaseStart:
            typeof original.phaseStart === "number"
              ? original.phaseStart
              : null,
          currentPhaseEnd:
            typeof original.phaseEnd === "number" ? original.phaseEnd : null,
        },
        curve: curve
          ? {
              ticId: String(r.ticId),
              bundleId: bundle,
              segments: curve.segments,
              residual: curve.residual ?? { status: "COMPLETED", jobId: null },
              curveContext: curve.curveContext,
            }
          : null,
        snapshot: null,
      },
    };
  };

  // ------------------------------------------------------------ statistics

  /** 12.2.1 personal statistics counted from this world. */
  const personalStatistics = () => {
    const summary = achievementSummary();
    const stars = allStars();
    const started = stars.filter(
      (s) => s.progressStage !== "unexplored",
    ).length;
    const logged = world.log.length;
    const loggedRecognized = world.log.filter(
      (r) => r.achievement?.result === "recognized",
    ).length;
    // Seeded progress stands for submissions made before this world.
    const seededSubmissions = Math.max(
      0,
      summary.signalCount -
        loggedRecognized +
        (started - summary.completedStarCount),
    );
    const submissions = seededSubmissions + logged;
    const empty = submissions === 0 && summary.discoveredStarCount === 0;
    const body = personalStatisticsFixture(empty) as Json;
    const now = new Date().toISOString();
    const count = (unit: string, value: number) => ({
      unit,
      value,
      numerator: value,
      denominator: null,
      status: "AVAILABLE",
      reason: null,
    });
    const ratio = (unit: string, numerator: number, denominator: number) => ({
      unit,
      value: denominator
        ? unit === "PERCENT"
          ? (100 * numerator) / denominator
          : numerator / denominator
        : null,
      numerator,
      denominator,
      status: denominator ? "AVAILABLE" : "NO_SAMPLE",
      reason: denominator ? null : "ZERO_DENOMINATOR",
    });
    const current = body.current as Json;
    current.asOf = now;
    current.generatedAt = now;
    current.periodEnd = now;
    const metrics = current.metrics as Json;
    const activeDays =
      (logged ? 1 : 0) + Math.min(60, Math.ceil(seededSubmissions / 5));
    Object.assign(metrics, {
      discoveredStarCount: count("STARS", summary.discoveredStarCount),
      startedStarCount: count("STARS", started),
      completedStarCount: count("STARS", summary.completedStarCount),
      recognizedTotal: count("SIGNALS", summary.signalCount),
      submissionCount: count("SUBMISSIONS", submissions),
      activeDays: count("DAYS", activeDays),
      unpublishedSignalCount: count("SIGNALS", 0),
      firstMatchAccuracy: ratio(
        "PERCENT",
        Math.min(summary.completedStarCount, started),
        started,
      ),
      submissionsPerStar: ratio("SUBMISSIONS_PER_STAR", submissions, started),
    });
    current.achievementByType = {
      confirmed: count("SIGNALS", summary.byType.confirmed),
      unconfirmed: count("SIGNALS", summary.byType.unconfirmed),
      fp: count("SIGNALS", summary.byType.fp),
    };
    current.gradeDistribution = Object.fromEntries(
      Object.entries(summary.starCountByGrade).map(([key, value]) => [
        key,
        count("STARS", value),
      ]),
    );
    // Eight weeks up to this one; this world's submissions land this week.
    const today = new Date();
    const monday = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    current.weeks = Array.from({ length: 8 }, (_, i) => {
      const start = new Date(monday);
      start.setUTCDate(monday.getUTCDate() - (7 - i) * 7);
      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + 7);
      const share = Math.round((seededSubmissions * (i + 1)) / 36);
      return {
        weekStart: start.toISOString().slice(0, 10),
        weekEnd: end.toISOString().slice(0, 10),
        partial: i === 7,
        submissionCount: i === 7 ? logged + share : share,
      };
    });
    current.periodStart = `${current.weeks[0].weekStart}T00:00:00Z`;
    return body;
  };

  /**
   * Service-wide statistics (12.1) at least as large as the explorers on
   * screen: this member plus DEMO_MEMBERS plus the rest of a small service.
   */
  const globalStatistics = () => {
    const body = globalStatisticsFixture() as Json;
    const mine = achievementSummary();
    const others = DEMO_MEMBERS.reduce((n, m) => n + m.starCount, 0) + 48_210;
    const discovered = mine.discoveredStarCount + others;
    const started = Math.round(discovered * 0.27);
    const completed = Math.round(discovered * 0.16);
    const recognized = Math.round(completed * 1.1) + mine.signalCount;
    const count = (unit: string, n: number) => ({
      unit,
      value: n,
      numerator: n,
      denominator: null,
      status: "AVAILABLE",
      reason: null as string | null,
    });
    const ratio = (n: number, d: number) => ({
      unit: "PERCENT",
      value: (100 * n) / d,
      numerator: n,
      denominator: d,
      status: "AVAILABLE",
      reason: null as string | null,
    });
    const now = new Date().toISOString();
    const global = body.global as Json;
    global.asOf = now;
    global.generatedAt = now;
    const data = global.data as Json;
    const participations = 1_284;
    Object.assign(data.metrics as Json, {
      discoveredStars: count("STAR", discovered),
      uniqueDiscoveredStars: count("STAR", Math.round(discovered * 0.62)),
      startedStars: count("STAR", started),
      currentCompletedStars: count("STAR", completed),
      uniqueCurrentCompletedStars: count("STAR", Math.round(completed * 0.7)),
      recognizedSignals: count("ACHIEVEMENT", recognized),
      confirmedAchievements: count(
        "ACHIEVEMENT",
        Math.round(recognized * 0.42),
      ),
      unconfirmedAchievements: count(
        "ACHIEVEMENT",
        Math.round(recognized * 0.33),
      ),
      fpAchievements: count(
        "ACHIEVEMENT",
        recognized -
          Math.round(recognized * 0.42) -
          Math.round(recognized * 0.33),
      ),
      uniqueRecognizedSignals: count("SIGNAL", Math.round(recognized * 0.55)),
      uniqueConfirmedSignals: count("SIGNAL", Math.round(recognized * 0.23)),
      uniqueFpSignals: count("SIGNAL", Math.round(recognized * 0.14)),
      uniqueUnconfirmedSignals: count(
        "SIGNAL",
        Math.round(recognized * 0.55) -
          Math.round(recognized * 0.23) -
          Math.round(recognized * 0.14),
      ),
      firstMatchAccuracy: ratio(Math.round(started * 0.38), started),
      publicLikelyPlanet: count("PARTICIPATION", 702),
      publicUnlikelyPlanet: count("PARTICIPATION", 391),
      publicUnsure: count("PARTICIPATION", 191),
      publicLikelyPlanetRate: ratio(702, participations),
      publicUnlikelyPlanetRate: ratio(391, participations),
      publicUnsureRate: ratio(191, participations),
      publicParticipations: count("PARTICIPATION", participations),
      aiAttemptUnknown: {
        ...count("PARTICIPATION", participations),
        reason: "AI_ATTEMPT_UNKNOWN",
      },
    });
    const today = new Date();
    const monday = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    data.weeklySubmissions = Array.from({ length: 8 }, (_, i) => {
      const start = new Date(monday);
      start.setUTCDate(monday.getUTCDate() - (7 - i) * 7);
      return {
        weekStart: start.toISOString().slice(0, 10),
        submissions:
          [1_840, 2_110, 2_380, 2_260, 2_790, 3_020, 3_410, 1_260][i] +
          (i === 7 ? world.log.length : 0),
        partial: i === 7,
      };
    });
    data.mostPostsStars = [
      { ticId: "259377017", postCount: 24 },
      { ticId: "150428135", postCount: 11 },
      { ticId: "149603524", postCount: 7 },
    ];
    data.sectorCompletion = [2, 3, 4, 5]
      .map((sector, i) => ({
        sector,
        ...ratio([412, 367, 298, 181][i], [640, 610, 590, 575][i]),
      }))
      .map(({ reason: _reason, ...row }) => row);
    data.challenges = [
      {
        roundId: "9007199254740993",
        roundNo: 1,
        participantCount: 146,
        participationCount: 203,
        likelyPlanet: 121,
        unlikelyPlanet: 52,
        unsure: 30,
      },
    ];
    return body;
  };

  // ------------------------------------------------------------ notifications

  /** Display name of a real star, else `TIC n`. */
  const starName = (tic: string) =>
    (realOf(tic) as (RealSampleStar & { displayName?: string }) | null)
      ?.displayName ?? `TIC ${tic}`;
  /**
   * The star the "새로운 성과" notification points at: the newest recognized
   * submission of this world, else the last completed real tutorial, else
   * (newcomer) tutorial 1 as a welcome.
   */
  const noticeStar = (): { tic: string; welcome: boolean } | null => {
    for (let i = world.log.length - 1; i >= 0; i--)
      if (world.log[i].achievement?.result === "recognized")
        return { tic: String(world.log[i].ticId), welcome: false };
    const done = [...world.placement.values()]
      .filter(
        (star) =>
          star.role === "tutorial" &&
          world.overlay.get(star.ticId)?.stage === "completed",
      )
      .sort((a, b) => (b.tutorialSeq ?? 0) - (a.tutorialSeq ?? 0))[0];
    if (done) return { tic: done.ticId, welcome: false };
    const first = world.ticOf(0);
    return first ? { tic: first, welcome: true } : null;
  };
  const rewriteNotices = (value: unknown): unknown => {
    const body = record(value);
    const target = noticeStar();
    if (!body || !target) return value;
    if (Array.isArray(body.items))
      body.items = body.items.map((row: Json) =>
        row?.notificationId === "n-achievement"
          ? {
              ...row,
              title: target.welcome
                ? "첫 번째 별이 열렸습니다"
                : "새로운 성과가 인정되었습니다",
              body: target.welcome
                ? `${starName(target.tic)}의 밝기 곡선을 분석해 보세요.`
                : `${starName(target.tic)}에서 찾은 신호를 확인하세요.`,
            }
          : row,
      );
    const pointed = record(body.target);
    if (body.notificationId === "n-achievement" && pointed?.kind === "STAR")
      pointed.ticId = target.tic;
    return body;
  };

  // ------------------------------------------------------------ others

  const publicGalaxies = new Map<
    string,
    {
      member: PublicMember;
      galaxy: Handler;
      planets: number;
      ticOf(ordinal: number): string;
    }
  >();
  /** Stage and planet count of another member's star (deterministic). */
  const publicSeed = (member: PublicMember, i: number) => {
    const real = realTutorials.get(i);
    if (real) {
      const planets = realPlanets(real).length;
      return { stage: "completed" as Stage, planets };
    }
    if (i < 5)
      return {
        stage: "completed" as Stage,
        planets: i === 0 ? 3 : i === 2 ? 1 : 0,
      };
    const u = unit(i, 100 + member.slot);
    if (u < member.withPlanets)
      return {
        stage: "completed" as Stage,
        planets: 1 + Math.floor(unit(i, 200 + member.slot) * 3),
      };
    if (u < member.withPlanets + 0.1)
      return { stage: "completed" as Stage, planets: 0 };
    if (u < member.withPlanets + 0.16)
      return { stage: "in_progress" as Stage, planets: 0 };
    return { stage: "unexplored" as Stage, planets: 0 };
  };
  const publicGalaxy = (member: PublicMember) => {
    let entry = publicGalaxies.get(member.memberId);
    if (entry) return entry;
    const ticOf = (i: number) =>
      realTutorials.get(i)?.ticId ??
      String(
        i < 5
          ? GALAXY_TIC_BASE + i
          : PUBLIC_TIC_BASE + member.slot * PUBLIC_TIC_SLOT + i,
      );
    let planets = 0;
    for (let i = 0; i < member.starCount; i++)
      planets += publicSeed(member, i).planets;
    const galaxy = captureGalaxy(member.starCount, {
      ticFor: ticOf,
      starFor: (i, star) => {
        const seed = publicSeed(member, i);
        return {
          ...star,
          progressStage: seed.stage,
          planetCount: seed.planets,
          completedWithoutPlanets:
            seed.stage === "completed" && seed.planets === 0,
          marker: null,
          reopened: false,
        };
      },
    });
    entry = { member, galaxy, planets, ticOf };
    publicGalaxies.set(member.memberId, entry);
    return entry;
  };
  const publicVersion = (member: PublicMember, inner: string) =>
    `pub~${member.memberId}~${inner}`;

  /**
   * Another explorer's submitted stars (profile "공개한 별", 4.4 scope
   * submitted): explored stars, newest ordinal first. Offset cursor.
   */
  const publicStarList = (member: PublicMember, url: URL): Reply => {
    const { ticOf } = publicGalaxy(member);
    const size = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("size") ?? 20) || 20),
    );
    const offset = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
    const rows: Json[] = [];
    for (
      let i = member.starCount - 1;
      i >= 0 && rows.length <= offset + size;
      i--
    ) {
      const seed = publicSeed(member, i);
      if (seed.stage === "unexplored") continue;
      rows.push({
        ticId: ticOf(i),
        progressStage: seed.stage,
        planetCount: seed.planets,
        completedWithoutPlanets:
          seed.stage === "completed" && seed.planets === 0,
        achievementCount: seed.planets,
        grade: seed.planets ? grade(seed.planets) : null,
        currentCurveStep: seed.planets,
        reopenPending: false,
        reopened: false,
        lastActivityAt: `2026-09-${String(10 + (i % 15)).padStart(2, "0")}T03:00:00Z`,
        unlockReason: i < 5 ? "tutorial" : "achievement",
        marker: null,
      });
    }
    const more = rows.length > offset + size;
    return {
      status: 200,
      body: {
        items: rows.slice(offset, offset + size),
        nextCursor: more ? String(offset + size) : null,
        hasNext: more,
      },
    };
  };

  /** /v1/members/:id, /sky, /sky/tiles, /stars(/:tic) for other explorers. */
  const publicRoute = (method: string, url: URL): Reply | null => {
    const match =
      /^\/v1\/members\/([^/]+)(?:\/(sky|sky\/tiles|stars|stars\/(\d+)))?$/.exec(
        url.pathname,
      );
    if (!match || method !== "GET") return null;
    const memberId = decodeURIComponent(match[1]);
    const member = publicMember(memberId);
    if (!member) return null;
    if (match[2] === "stars")
      return member.visibility === "PUBLIC"
        ? publicStarList(member, url)
        : {
            status: 403,
            body: failure("STAR_LIST_PRIVATE", "별 목록이 비공개입니다."),
          };
    if (!match[2]) {
      const planets =
        member.visibility === "PUBLIC" ? publicGalaxy(member).planets : 0;
      return {
        status: 200,
        body: {
          memberId,
          nickname: member.nickname,
          starListVisibility: member.visibility,
          achievementSummary: {
            signalCount: planets,
            starCountByGrade: {
              A: Math.round(planets * 0.4),
              S: Math.round(planets * 0.12),
              SS: Math.round(planets * 0.04),
              SSS: Math.round(planets * 0.01),
            },
          },
        },
      };
    }
    if (member.visibility !== "PUBLIC")
      return {
        status: 404,
        body: failure(
          "PUBLIC_SKY_NOT_AVAILABLE",
          "공개 은하를 찾을 수 없습니다.",
        ),
      };
    const { galaxy } = publicGalaxy(member);
    if (match[2] === "sky") {
      const reply = invoke(galaxy, "GET", "/v1/me/sky");
      return {
        status: 200,
        body: {
          ...reply.body,
          version: publicVersion(member, reply.body.version),
          owner: { memberId, nickname: member.nickname },
          scope: "all-owned",
          visibility: "PUBLIC",
        },
      };
    }
    if (match[2] === "sky/tiles") {
      const prefix = publicVersion(member, "");
      const asked = url.searchParams.get("version") ?? "";
      const inner = new URL(url);
      inner.pathname = "/v1/me/sky/tiles";
      inner.searchParams.set(
        "version",
        asked.startsWith(prefix) ? asked.slice(prefix.length) : asked,
      );
      const reply = invoke(galaxy, "GET", inner.pathname + inner.search);
      if (reply.status === 200) {
        reply.body.version = publicVersion(member, reply.body.version);
        reply.body.stars = reply.body.stars.map((star: Json) => ({
          ...star,
          marker: null,
          reopened: false,
        }));
      }
      return reply;
    }
    const tic = match[3];
    const reply = invoke(galaxy, "GET", `/v1/me/stars/${tic}`);
    if (reply.status !== 200)
      return {
        status: 404,
        body: failure("STAR_NOT_FOUND", "공개한 별이 아닙니다."),
      };
    const real = realTutorials.get(
      Number(reply.body.unlock.position.layoutOrdinal),
    );
    const items: OwnedPlanet[] =
      real && real.ticId === tic
        ? realPlanets(real)
        : reply.body.planets.items.map((planet: OwnedPlanet, i: number) =>
            syntheticPlanet(
              tic,
              Number(reply.body.unlock.position.layoutOrdinal),
              planet,
              i,
            ),
          );
    return {
      status: 200,
      body: {
        memberId,
        ticId: tic,
        version: publicVersion(member, reply.body.version),
        presentationVersion: reply.body.presentationVersion,
        position: reply.body.unlock.position,
        planets: { count: items.length, items },
      },
    };
  };

  /** Follows (my following list is the "다른 탐사자" list). */
  const followRoute = async (
    req: IncomingMessage,
    method: string,
    url: URL,
  ): Promise<Reply | null> => {
    const path = url.pathname;
    const follows = world.follows;
    const count = (kind: FollowTarget["kind"]) =>
      [...follows.values()].filter((t) => t.kind === kind).length;
    const summary = /^\/v1\/members\/([^/]+)\/follow-summary$/.exec(path);
    if (summary && method === "GET") {
      const id = decodeURIComponent(summary[1]);
      const other = publicMember(id);
      return {
        status: 200,
        body:
          id === ME
            ? {
                memberId: id,
                followers: 1,
                followingMembers: count("MEMBER"),
                followingStars: count("STAR"),
              }
            : {
                memberId: id,
                followers:
                  (other ? 2 + (other.slot % 7) : 0) +
                  Number(follows.has(`MEMBER:${id}`)),
                followingMembers: other ? 1 + (other.slot % 4) : 0,
                followingStars: other ? other.slot % 3 : 0,
              },
      };
    }
    const relation = /^\/v1\/me\/following\/(members|stars)\/([^/]+)$/.exec(
      path,
    );
    if (relation) {
      const kind = relation[1] === "members" ? "MEMBER" : "STAR";
      const id = decodeURIComponent(relation[2]);
      const key = `${kind}:${id}`;
      if (method !== "GET" && req.headers["x-csrf-token"] !== COMMUNITY_CSRF)
        return {
          status: 403,
          body: failure("CSRF_INVALID", "인증 정보를 확인해 주세요."),
        };
      if (id === ME)
        return {
          status: 400,
          body: failure("FOLLOW_SELF", "자기 자신은 팔로우할 수 없습니다."),
        };
      if (method === "PUT")
        follows.set(key, {
          kind,
          id,
          label:
            kind === "STAR"
              ? `TIC ${id}`
              : (publicMember(id)?.nickname ?? `탐사자 ${id}`),
        });
      else if (method === "DELETE") follows.delete(key);
      else if (method !== "GET") return null;
      return { status: 200, body: { kind, id, following: follows.has(key) } };
    }
    if (method !== "GET") return null;
    const list = /^\/v1\/me\/(followers|following\/(members|stars))$/.exec(
      path,
    );
    if (list)
      return {
        status: 200,
        body: {
          items:
            list[1] === "followers"
              ? [{ kind: "MEMBER", id: "u-211", label: "다른탐사자" }]
              : [...follows.values()].filter(
                  (t) => t.kind === (list[2] === "members" ? "MEMBER" : "STAR"),
                ),
          nextCursor: null,
          hasNext: false,
        },
      };
    if (path === "/v1/community/following-feed") {
      const followed = new Set(
        [...follows.values()]
          .filter((t) => t.kind === "MEMBER")
          .map((t) => t.id),
      );
      const items = [];
      for (let k = 1; k < 24 && items.length < 6; k++) {
        const postId = `p-${201 + k}`;
        const author = postAuthor(postId);
        if (!author || !followed.has(author.memberId)) continue;
        items.push({
          type: "POST",
          id: postId,
          ticId: k % 3 === 1 ? null : "259377017",
          title: `${POST_TITLES[k % 3]} · ${k + 1}`,
          author: { memberId: author.memberId, nickname: author.nickname },
          commentCount: 0,
          createdAt: "2026-09-18T01:00:00Z",
          matchedBy: ["MEMBER"],
        });
      }
      return {
        status: 200,
        body: { items, nextCursor: null, hasNext: false },
      };
    }
    return null;
  };

  /** Authors in community replies: other explorers, and my current name. */
  const myNickname = () =>
    world.scenario.id === "member" ? null : world.scenario.nickname;
  const rewriteAuthors = (value: unknown, postId: string | null): unknown => {
    if (Array.isArray(value))
      return value.map((item) => rewriteAuthors(item, postId));
    const node = record(value);
    if (!node) return value;
    const own =
      typeof node.postId === "string"
        ? node.postId
        : node.type === "POST" && typeof node.id === "string"
          ? node.id
          : null;
    const out: Json = {};
    for (const [key, item] of Object.entries(node)) {
      const author = record(item);
      if (key === "author" && author && typeof author.memberId === "string") {
        const swapped = own ? postAuthor(own) : null;
        const other = publicMember(author.memberId);
        out[key] =
          author.memberId === ME && swapped
            ? { memberId: swapped.memberId, nickname: swapped.nickname }
            : author.memberId === ME
              ? { ...author, nickname: myNickname() ?? author.nickname }
              : other
                ? { ...author, nickname: other.nickname }
                : author;
      } else if (typeof item === "string")
        out[key] = FIXTURE_TEXT.get(item) ?? item;
      else out[key] = rewriteAuthors(item, own ?? postId);
    }
    return out;
  };
  const rewriteJson = (
    res: ServerResponse,
    transform: (v: unknown) => unknown,
  ) => {
    const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    (res as unknown as { end: (...args: unknown[]) => ServerResponse }).end = (
      chunk?: unknown,
      ...rest: unknown[]
    ) => {
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        try {
          const patched = JSON.stringify(transform(JSON.parse(String(chunk))));
          if (!res.headersSent) res.removeHeader("Content-Length");
          return end(patched, ...rest);
        } catch {
          /* not JSON: pass through */
        }
      }
      return end(chunk, ...rest);
    };
  };

  /** h-601..h-609 (My page history list) read like h-501/h-502/h-503. */
  const myListHistory = (url: URL): Reply | null => {
    const match = /^\/v1\/histories\/(h-60(\d))(\/graph)?$/.exec(url.pathname);
    if (!match) return null;
    const n = Number(match[2]);
    const stand = n === 3 ? "h-503" : n % 2 ? "h-501" : "h-502";
    const reply = historyFixtureResponse(
      url.pathname.replace(match[1], stand),
      url.searchParams,
    );
    if (!reply) return null;
    return {
      status: reply.status,
      body: JSON.parse(
        JSON.stringify(reply.body).split(`"${stand}"`).join(`"${match[1]}"`),
      ),
    };
  };

  // ------------------------------------------------------------ scenarios

  const scenarioList = (anonymous: boolean): DemoScenarioList => ({
    current: {
      session: anonymous ? "anonymous" : world.scenario.id,
      scenario: world.scenario.id,
      starCount: invoke(world.galaxy, "GET", "/v1/me/sky").body.starCount,
      realSample: { loaded: sampleStars.length > 0, stars: sampleStars.length },
    },
    scenarios: Object.values(DEMO_SCENARIOS).map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      starCount: s.id === "member" ? memberStars : s.starCount,
    })),
    veteranStarOptions: VETERAN_STAR_OPTIONS,
    members: DEMO_MEMBERS.map((m) => ({
      memberId: m.memberId,
      nickname: m.nickname,
      visibility: m.visibility,
      starCount: m.starCount,
    })),
  });

  /** The session switch page: cookie, forget this tab's drafts, go on. */
  const switchPage = (target: string) =>
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Planetory</title>` +
    `<style>html,body{margin:0;height:100%;background:#000}</style></head><body><script>` +
    `try{for(const k of Object.keys(sessionStorage))if(k.indexOf("planetory:analysis-draft:")===0)sessionStorage.removeItem(k)}catch(e){}` +
    // A new world is a new first visit: the once-per-member flight to
    // tutorial 1 and the closed tutorial lines start over (shell/tutorial-guide),
    // and no star of the old world is marked new (shell/new-stars).
    `try{localStorage.removeItem("planetory:first-visit-flown");localStorage.removeItem("planetory:first-visit-story");localStorage.removeItem("planetory:tutorial-guide-closed");localStorage.removeItem("planetory:new-stars")}catch(e){}` +
    `location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")})</script></body></html>`;

  const reset = () => {
    world = buildWorld(world.scenario.id, world.size);
    seedWorld();
  };

  const member = (): Record<string, unknown> => ({
    ...(myNickname() ? { nickname: myNickname() } : {}),
    onboardingDone: world.onboardingDone,
    tutorialCompleted: tutorialsDone() >= 5,
    achievementSummary: achievementSummary(),
  });

  // The first world's seeds need every helper above.
  seedWorld();

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
            const as = url.searchParams.get("as");
            const session: DemoSession =
              as === "anonymous" ||
              as === "newcomer" ||
              as === "veteran" ||
              as === "member"
                ? as
                : "member";
            if (session !== "anonymous") {
              const stars = Number(url.searchParams.get("stars"));
              world = buildWorld(
                session,
                Number.isInteger(stars) && stars > 0 ? stars : undefined,
              );
              seedWorld();
            }
            const signedOut =
              session === "anonymous" ||
              url.searchParams.get("start") === "login";
            res.writeHead(200, {
              "Set-Cookie": cookie(signedOut ? "anonymous" : "member"),
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            });
            res.end(
              switchPage(
                signedOut
                  ? "/login"
                  : safePath(url.searchParams.get("next"), "/sky"),
              ),
            );
            return;
          }
          if (path === "/dev-cinema/scenarios" && method === "GET")
            return send(res, 200, scenarioList(anonymous));
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
            return send(res, 200, {
              scenario: world.scenario.id,
              skyVersion: outward(innerVersion()),
            });
          }
          if (path === "/dev-cinema/unlock" && method === "POST") {
            const on = url.searchParams.get("on");
            if (on === "0" || on === "1") unlockStars = on === "1";
            return send(res, 200, { unlock: unlockStars });
          }
          if (path === "/dev-cinema/state" && method === "GET") {
            const meta = invoke(world.galaxy, "GET", "/v1/me/sky").body;
            return send(res, 200, {
              session: anonymous ? "anonymous" : "member",
              scenario: world.scenario.id,
              onboardingDone: world.onboardingDone,
              skyVersion: outward(meta.version),
              starCount: meta.starCount,
              sampleTic: CINEMA_SAMPLE_TIC,
              realSample: sampleStars.length,
              placement: Object.fromEntries(
                [...world.placement]
                  .sort((a, b) => a[0] - b[0])
                  .map(([ordinal, star]) => [
                    ordinal,
                    { ticId: star.ticId, role: star.role },
                  ]),
              ),
              windowRule,
              unlock: unlockStars,
              unlocked: world.unlocked,
              recognized: [...world.recognized],
              overlay: Object.fromEntries(
                [...world.overlay].map(([tic, item]) => [
                  tic,
                  {
                    stage: item.stage,
                    planets: [...item.planets.values()],
                    achievements: item.achievements,
                    matched: [...item.matched],
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

          // --- First-visit guide (AT-86): true only, once. ---
          if (path === "/v1/me/onboarding" && method === "PATCH") {
            if (req.headers["x-csrf-token"] !== COMMUNITY_CSRF)
              return send(
                res,
                403,
                failure("CSRF_INVALID", "인증 정보를 확인해 주세요."),
              );
            let body: unknown = null;
            try {
              body = await readJson(req);
            } catch {
              body = null;
            }
            if (record(body)?.onboardingDone !== true)
              return send(
                res,
                400,
                failure(
                  "VALIDATION_FAILED",
                  "onboardingDone은 true만 받습니다.",
                ),
              );
            world.onboardingDone = true;
            return send(res, 200, { onboardingDone: true });
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

          // --- Other explorers, follows, statistics. ---
          const other = publicRoute(method, url);
          if (other) return send(res, other.status, other.body);
          const follow = await followRoute(req, method, url);
          if (follow) return send(res, follow.status, follow.body);
          if (method === "GET" && path === "/v1/statistics")
            return send(res, 200, globalStatistics());
          if (method === "GET" && path === "/v1/me/statistics")
            return send(res, 200, personalStatistics());
          // My page history (8.1) and its details (8.2/8.3): this world's
          // submissions. The publication fixture keeps its own c-195x rows.
          if (
            method === "GET" &&
            path === "/v1/me/histories" &&
            !url.searchParams.get("candidateId")?.startsWith("c-195")
          ) {
            const list = myHistoryList(url);
            return send(res, list.status, list.body);
          }
          if (method === "GET" && path.startsWith("/v1/histories/")) {
            const mine = historyReply(url);
            if (mine) return send(res, mine.status, mine.body);
          }
          // Notifications point at this world's stars, not a fixed TOI-270.
          if (
            method === "GET" &&
            (path === "/v1/me/notifications" ||
              path === "/v1/me/notifications/n-achievement/target")
          )
            rewriteJson(res, rewriteNotices);

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
              const galaxyStar = !fixtureOnly(tic) && isGalaxyStar(tic);
              const explored =
                galaxyStar &&
                stageOf({
                  ticId: tic,
                  progressStage: invoke(
                    world.galaxy,
                    "GET",
                    `/v1/me/stars/${tic}`,
                  ).body.progress.stage,
                }) !== "unexplored";
              if (explored) return send(res, 200, worldStarResult(tic));
              if (tic === CINEMA_SAMPLE_TIC)
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
            const tic = world.residualTics.get(job[1]);
            if (body && tic) body.ticId = tic;
            return send(res, reply.status, reply.body, reply.headers ?? {});
          }
          const create = /^\/v1\/stars\/([^/]+)\/residual-jobs$/.exec(path);
          if (create && method === "POST") {
            const tic = decodeURIComponent(create[1]);
            const galaxyStar = !fixtureOnly(tic);
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
              world.residualTics.set(jobId, tic);
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
            const reply = world.publication(method, url, body);
            if (reply) {
              const patched =
                method === "GET"
                  ? rewriteAuthors(reply.body, null)
                  : reply.body;
              return send(res, reply.status, patched);
            }
          }
          if (method === "GET" && path.startsWith("/v1/histories/")) {
            const mine = myListHistory(url);
            if (mine) return send(res, mine.status, mine.body);
            const history = historyFixtureResponse(path, url.searchParams);
            if (history) return send(res, history.status, history.body);
          }

          // Community replies behind this plugin: authors link to explorers.
          if (
            method === "GET" &&
            /^\/v1\/(community\/|posts\/|comments$|signal-threads\/)/.test(path)
          )
            rewriteJson(res, (value) => rewriteAuthors(value, null));
          next();
        } catch (error) {
          next(error);
        }
      });
    },
  };
  return { plugin, reset, member };
}
