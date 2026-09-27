// Demo scenarios of the cinema review server (`npm run dev:cinema`). Dev only.
//
// Switch with a full page load (the session cookie changes, the app reloads):
//
//   GET /api/dev-cinema/session?as=<session>[&stars=<n>][&start=login][&next=<path>]
//
//   as=anonymous   signed out, world unchanged, then /login
//   as=newcomer    5 tutorial stars, none done, onboarding not done
//   as=member      the default world (CINEMA_STARS, tutorials 1-2 done)
//   as=veteran     a large explored galaxy; stars=5000 (default) | 10000
//   stars=<n>      member/veteran galaxy size, 10..20000
//   start=login    build the world but land signed out on /login, so the
//                  SSAFY button flies into it (newcomer demo)
//   next=<path>    same-origin path after the switch (default /sky)
//
// The reply is a tiny page that sets the cookie, forgets this tab's analysis
// drafts (`planetory:analysis-draft:*`, they belong to the old world) and
// moves on with location.replace. Every switch to newcomer/member/veteran
// builds a fresh world for that scenario (submissions, overlay, residual
// jobs, follows); submission ids restart from a time-based number so the
// browser's celebration history never hides a first discovery.
// POST /api/dev-cinema/reset rebuilds the current scenario the same way.
// GET /api/dev-cinema/scenarios lists them for the demo switch UI
// (src/cinema/shell/demo).
//
// Real TESS sample (dev/real-sample): tutorial stars are the sample's
// tutorial stars; newly unlocked stars (newcomer) and explore slots
// (5, 8, 9, ... for member/veteran) are its explore stars.
//
// Other members' public galaxies (/members/:memberId/sky): DEMO_MEMBERS,
// plus any `u-3NN` (the community fixture's public-analysis authors) as a
// small generated galaxy.

export type DemoScenarioId = "newcomer" | "member" | "veteran";
export type DemoSession = DemoScenarioId | "anonymous";

export type DemoScenario = {
  id: DemoScenarioId;
  /** Switch UI label, short Korean. */
  label: string;
  /** One line for the switch UI. */
  description: string;
  /** Same member id for all: every fixture keys "me" on u-209. */
  memberId: "u-209";
  nickname: string;
  /** Default galaxy size; `stars=` overrides (member, veteran). */
  starCount: number;
  completedTutorials: number[];
  onboardingDone: boolean;
  /**
   * Seeded progress beyond the tutorials, as shares of the galaxy
   * (deterministic by ordinal). `withPlanets` is part of `completed`.
   * Real stars in explore slots: every second one is completed with its
   * real planets (veteran).
   */
  progress: { inProgress: number; completed: number; withPlanets: number };
  /** Members this account follows at the start (the "다른 탐사자" list). */
  following: string[];
};

export const DEMO_SCENARIOS: Record<DemoScenarioId, DemoScenario> = {
  newcomer: {
    id: "newcomer",
    label: "처음 온 탐사자",
    description: "튜토리얼 별 5개, 첫 방문 안내 전",
    memberId: "u-209",
    nickname: "새내기탐사자",
    starCount: 5,
    completedTutorials: [],
    onboardingDone: false,
    progress: { inProgress: 0, completed: 0, withPlanets: 0 },
    following: [],
  },
  member: {
    id: "member",
    label: "탐사 중인 회원",
    description: "별 1,000개, 튜토리얼 2개 완료",
    memberId: "u-209",
    nickname: "탐사자214",
    starCount: 1000,
    completedTutorials: [1, 2],
    onboardingDone: true,
    progress: { inProgress: 0, completed: 0, withPlanets: 0 },
    following: ["u-301", "u-211", "u-303"],
  },
  veteran: {
    id: "veteran",
    label: "오래 탐사한 회원",
    description: "별 5,000개 이상, 행성이 많은 은하",
    memberId: "u-209",
    nickname: "베테랑탐사자",
    starCount: 5000,
    completedTutorials: [1, 2, 3, 4, 5],
    onboardingDone: true,
    progress: { inProgress: 0.04, completed: 0.12, withPlanets: 0.08 },
    following: ["u-301", "u-211", "u-302", "u-303"],
  },
};

/** Galaxy sizes the switch UI offers for the veteran. */
export const VETERAN_STAR_OPTIONS = [5000, 10000] as const;
export const DEMO_STAR_RANGE = { min: 10, max: 20000 } as const;

export type DemoMember = {
  memberId: string;
  nickname: string;
  /** PRIVATE answers 404 PUBLIC_SKY_NOT_AVAILABLE on the sky routes. */
  visibility: "PUBLIC" | "PRIVATE";
  starCount: number;
  /** Share of stars with planets (deterministic by ordinal). */
  withPlanets: number;
};

/**
 * Other explorers. u-210/u-211 keep the profile fixture's meaning (private,
 * public); the rest are new. Stars are laid out by ordinal like "me"; the
 * first five are the shared tutorial stars.
 */
export const DEMO_MEMBERS: DemoMember[] = [
  {
    memberId: "u-301",
    nickname: "별지기",
    visibility: "PUBLIC",
    starCount: 50,
    withPlanets: 0.2,
  },
  {
    memberId: "u-211",
    nickname: "다른탐사자",
    visibility: "PUBLIC",
    starCount: 1000,
    withPlanets: 0.05,
  },
  {
    memberId: "u-302",
    nickname: "행성사냥꾼",
    visibility: "PUBLIC",
    starCount: 2400,
    withPlanets: 0.12,
  },
  {
    memberId: "u-303",
    nickname: "은하수집가",
    visibility: "PUBLIC",
    starCount: 10000,
    withPlanets: 0.06,
  },
  {
    memberId: "u-210",
    nickname: "비공개탐사자",
    visibility: "PRIVATE",
    starCount: 300,
    withPlanets: 0.1,
  },
];

/** Reply of GET /api/dev-cinema/scenarios (read by the demo switch UI). */
export type DemoScenarioList = {
  current: {
    session: DemoSession;
    scenario: DemoScenarioId;
    starCount: number;
    realSample: { loaded: boolean; stars: number };
  };
  scenarios: Pick<DemoScenario, "id" | "label" | "description" | "starCount">[];
  veteranStarOptions: readonly number[];
  members: Pick<
    DemoMember,
    "memberId" | "nickname" | "visibility" | "starCount"
  >[];
};
