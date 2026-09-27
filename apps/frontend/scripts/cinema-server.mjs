// Cinematic build review only. Data is synthetic, plus the local real TESS
// sample when present (dev/real-sample); everything is kept in memory.
// This entry point is never loaded by the production Vite configuration.
//
//   CINEMA_PORT=58390 npm run dev:cinema
//
// Environment
//   CINEMA_PORT          port (default 58390, strict)
//   CINEMA_STARS         galaxy size of the member scenario (default 1000)
//   CINEMA_SCENARIO      world at start: member (default) | newcomer | veteran
//   CINEMA_P1=0          hide the P1 routes production does not have yet
//                        (notifications, global statistics, withdrawal); on
//                        by default for the demo. Follow, another member's
//                        galaxy and personal statistics are on either way
//                        (src/features/p1.ts)
//   CINEMA_WINDOW_RULE=0 rank-1 peak ignores whether the window covers the dip
//   CINEMA_UNLOCK=0      a recognized achievement unlocks no star
//                        (unlockedStars: [], as production often answers after a
//                        tutorial); at run time POST /api/dev-cinema/unlock?on=0|1
//   CINEMA_REAL_SAMPLE   real TESS sample folder (default apps/frontend/.real-sample,
//                        see dev/real-sample); 0 = synthetic data only
//   VITE_CINEMA=false    legacy develop pages instead of the cinema shell
//   VITE_CINEMA=auto     a build without VITE_CINEMA: legacy unless ?ui=cinema
//                        (src/ui-choice.ts)
//   CINEMA_ANALYSIS      analysis screen: new (default: the new design,
//                        variant B, for everyone and without the variant
//                        toggle, as in production) | classic (the old one);
//                        defines VITE_CINEMA_ANALYSIS
//                        (src/cinema/analysis/variant.ts)
//   CINEMA_HMR=0         no live reload: source edits never reload an open page
//                        (a rehearsal or a second review server); reload by hand
//
// Scenarios (dev/cinema-scenarios.ts is the reference)
//   /api/dev-cinema/session?as=newcomer|member|veteran[&stars=5000|10000][&start=login][&next=/path]
//                        a fresh world for that scenario, then the app (or /login)
//   GET /api/dev-cinema/scenarios   list for the demo switch (bottom centre, Alt+Shift+D)
//   other explorers      /members/u-301/sky (50 stars), u-211 (1000), u-302 (2400),
//                        u-303 (10000); u-210 is private
//
// Session
//   default              signed-in member `u-209` (no cookie needed)
//   /api/dev-cinema/session?as=anonymous   -> cookie, 302 to /login
//   /api/dev-cinema/session?as=member      -> fresh member world, /sky
//   login buttons        -> /api/dev-cinema/oauth/{ssafy|google} -> member -> /oauth/callback
//   logout               -> anonymous
//   POST /api/dev-cinema/reset   fresh world of the current scenario
//   GET  /api/dev-cinema/state   scenario, sky version, real placement, unlocked stars, overlay
//
// Stars (galaxy fixture, TIC = 900000001 + index)
// Stars below are the member scenario without a real sample; with one, the
// tutorial and explore slots carry real TICs (GET /api/dev-cinema/state).
//   900000001  tutorial 1, completed, 5 planets (3 confirmed, 2 candidates)
//   900000002  tutorial 2, completed, no planets
//   900000003  tutorial 3 marker (blue "3"), unexplored
//   900000006  challenge marker (red "!")
//   900000008  in progress, 2 planets: fixture-204-p-0 confirmed, fixture-204-p-1 candidate
//   900000010  plain unexplored star (use this for a clean submission)
//   Every galaxy star opens /analysis/<tic> with the synthetic sample of
//   TIC 259377024 (rank-1 peak ~11.73 d, dip at phase 0/1, 0.8% deep).
//
// Submission outcomes (candidate, any galaxy star)
//   rank-1 peak + window over phase 0 or 1 + 행성 같음  -> matched, AGREES,
//       recognized, one new star unlocked (next TIC, e.g. 900001001),
//       planet 9007199254741101 (confirmed) added to that star
//   rank-1 peak + window over the dip + 아닌 것 같음/모르겠음 -> matched,
//       judgment_mismatch, planet added, no unlock
//   rank-1 peak + window away from the dip (e.g. the keyboard
//       "구간 선택 시작" at the default view, centred on 0.5) -> not_matched
//   direct period (click off-peak on the periodogram)   -> not_matched
//   rank-2 peak -> matched_harmonic, UNCONFIRMED, pending_publish
//   rank-3 peak -> matched, FP; 아닌 것 같음 -> recognized + unlock, no planet
//   same recognized signal again on the same star      -> duplicate
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { cinemaFixturePlugin } from "../dev/cinema-fixture-plugin.ts";
import { communityFixturePlugin } from "../dev/community-fixture-plugin.ts";
import { createProfileFixture } from "../dev/profile-fixture-plugin.ts";
import { hotTopicsFixturePlugin } from "../dev/hot-topics-fixture-plugin.ts";
import { myListsFixturePlugin } from "../dev/my-lists-fixture-plugin.ts";
import { publicSkyFixturePlugin } from "../dev/public-sky-fixture-plugin.ts";
import { notificationsFixturePlugin } from "../dev/notifications-fixture-plugin.ts";
import { settingsFixturePlugin } from "../dev/settings-fixture-plugin.ts";
import { withdrawalFixturePlugin } from "../dev/withdrawal-fixture-plugin.ts";
import { loadRealSample, REAL_SAMPLE_DIR } from "../dev/real-sample/index.ts";

const port = Number(process.env.CINEMA_PORT ?? 58390);
const starCount = Number(process.env.CINEMA_STARS ?? 1000);
const p1 = !/^(0|false|no)$/i.test(process.env.CINEMA_P1 ?? "");
const cinemaUi = ["false", "auto"].includes(process.env.VITE_CINEMA ?? "")
  ? process.env.VITE_CINEMA
  : "true";
const realSampleDir = process.env.CINEMA_REAL_SAMPLE ?? REAL_SAMPLE_DIR;
// Throws on a malformed sample: better than a demo on half-read data.
const realSample = /^(0|false|no)$/i.test(realSampleDir)
  ? null
  : loadRealSample(realSampleDir);
const scenario = process.env.CINEMA_SCENARIO ?? "member";
const analysis =
  (process.env.CINEMA_ANALYSIS ?? "").trim().toLowerCase() || "new";
const windowRule = !/^(0|false|no)$/i.test(
  process.env.CINEMA_WINDOW_RULE ?? "",
);
const unlock = !/^(0|false|no)$/i.test(process.env.CINEMA_UNLOCK ?? "");
const hmr = !/^(0|false|no)$/i.test(process.env.CINEMA_HMR ?? "");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("CINEMA_PORT must be an integer between 1024 and 65535");
if (!Number.isInteger(starCount) || starCount < 10 || starCount > 20000)
  throw new Error("CINEMA_STARS must be an integer between 10 and 20000");
if (!["member", "newcomer", "veteran"].includes(scenario))
  throw new Error("CINEMA_SCENARIO must be member, newcomer or veteran");
if (!["classic", "new"].includes(analysis))
  throw new Error("CINEMA_ANALYSIS must be classic or new");

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = createProfileFixture();
const cinema = cinemaFixturePlugin({
  starCount,
  windowRule,
  realSample,
  scenario,
  unlock,
});
const community = communityFixturePlugin({
  writable: true,
  commentWrites: true,
  reactionWrites: true,
  materialWrites: true,
  searchable: true,
  hotTopics: true,
  currentNickname: profile.nickname,
});
// Feature fixtures print a banner into index.html; the cinema build shows the product.
delete community.transformIndexHtml;

const server = await createServer({
  root,
  configFile: false,
  // Never read .env files: every flag below is explicit and synthetic.
  envDir: false,
  cacheDir: `node_modules/.vite-cinema-${port}`,
  mode: "cinema",
  plugins: [
    react(),
    // Session, CSRF, scenarios, galaxy, analysis, submissions, other
    // explorers' galaxies, follows, statistics. Falls through otherwise.
    cinema.plugin,
    publicSkyFixturePlugin(),
    withdrawalFixturePlugin(),
    // Answers GET /v1/me for the signed-in member.
    settingsFixturePlugin({
      member: () => ({
        nickname: profile.nickname(),
        achievementSummary: {
          discoveredStarCount: starCount,
          completedStarCount: 2,
          signalCount: 7,
          byType: { confirmed: 5, unconfirmed: 2, fp: 0 },
          starCountByGrade: { A: 1, S: 0, SS: 1, SSS: 0 },
        },
        // The current demo scenario (nickname, onboarding, summary).
        ...cinema.member(),
      }),
    }),
    notificationsFixturePlugin(),
    profile.plugin,
    // /v1/me/histories and submitted-star lists for My page.
    myListsFixturePlugin(),
    hotTopicsFixturePlugin(),
    // Catch-all: answers 404 for anything nobody above handled.
    community,
  ],
  define: Object.fromEntries(
    Object.entries({
      VITE_API_BASE: "/api",
      VITE_CINEMA: cinemaUi,
      // Analysis screen of the cinema app: classic | new (variant B).
      VITE_CINEMA_ANALYSIS: analysis,
      // Demo scenario switch (src/cinema/shell/demo). Never in a build.
      VITE_CINEMA_DEMO: "true",
      VITE_P1_ENABLED: p1 ? "true" : "false",
      VITE_SKY_RENDERER_ENABLED: "true",
      VITE_FIXTURE: "false",
      VITE_GALAXY_FIXTURE: "false",
      VITE_INTERACTION_FIXTURE: "false",
      VITE_SKY_DATA_FIXTURE: "false",
      VITE_OBSERVATIONS: "false",
      VITE_OAUTH_SSAFY_URL: "/api/dev-cinema/oauth/ssafy",
      VITE_OAUTH_GOOGLE_URL: "/api/dev-cinema/oauth/google",
      VITE_CSRF_HEADER: "",
      VITE_CSRF_COOKIE: "",
      VITE_REQUEST_ID_HEADER: "",
      VITE_NICKNAME_REQUIRED_CODE: "",
      VITE_INITIAL_NICKNAME_PATH: "",
    }).map(([key, value]) => ["import.meta.env." + key, JSON.stringify(value)]),
  ),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    ...(hmr ? {} : { hmr: false }),
  },
});
await server.listen();
console.log(
  `cinema review · scenario ${scenario} · ${realSample ? `real TESS sample ${realSample.stars.length} stars + synthetic` : "synthetic data only"} · stars ${starCount} · P1 ${p1 ? "on" : "off"} · window rule ${windowRule ? "on" : "off"} · unlock ${unlock ? "on" : "off"} · analysis ${analysis}${hmr ? "" : " · no live reload"} · UI ${{ true: "cinema", false: "legacy", auto: "legacy unless ?ui=cinema" }[cinemaUi]}: http://127.0.0.1:${port}/sky`,
);
