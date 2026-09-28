// The cinema app. ./main.tsx loads it when VITE_CINEMA is "true" (production)
// or, in a build without VITE_CINEMA, when the visitor opted in with
// ?ui=cinema (./ui-choice.ts); otherwise ./legacy/main.tsx starts develop's app.
import {
  MyProfilePage,
  MemberProfilePage,
} from "./features/profile/ProfilePage";
import { StrictMode } from "react";
import { FollowingPage, FollowingFeedPage } from "./features/follow/Follow";
import { p1Enabled } from "./features/p1";
import { PersonalStatistics } from "./features/statistics/PersonalStatistics";
import { NotificationsPage } from "./features/notifications/Notifications";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App, type PageSlots } from "./app/App";
import { SharedHistoryCurve } from "./features/analysis/HistoryCurveChart";
import { HistoryDetailPage } from "./features/history/HistoryDetailPage";
import { MyHistorySection } from "./features/my-lists/MyHistorySection";
import { MyStarsSection } from "./features/my-lists/MyStarsSection";
import { PublicAnalysisPage } from "./features/history/PublicAnalysisPage";
import { PublicationPage } from "./features/publication/PublicationPage";
import { SessionProvider } from "./auth/SessionProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CinemaAnalysis } from "./cinema/shell/AnalysisStage";
import { cinemaPages } from "./cinema/pages";
import { StarResultPage } from "./features/analysis/StarResultPage";
import { StrictCelebration } from "./features/analysis/celebration";
import { CinemaCopy } from "./features/analysis/cinema-copy";
import { cinemaAnalysisCopy } from "./cinema/analysis/copy";
import "./styles.css";
import { PostEditorPage } from "./features/community/PostEditorPage";
import { HotTopicsPage } from "./features/community/HotTopicsPage";
import { SettingsPage } from "./features/profile/SettingsPage";
import { WithdrawalPage } from "./features/profile/WithdrawalPage";
import {
  CommunityPage,
  PostPage,
  SignalThreadPage,
} from "./features/community/CommunityPages";

// Register feature components here after their individual tickets are implemented.
async function start() {
  if (
    import.meta.env.DEV &&
    import.meta.env.VITE_GALAXY_FIXTURE === "true" &&
    window.location.pathname === "/dev/galaxy-comparison"
  ) {
    const { GalaxyComparisonPage } =
      await import("../dev/GalaxyComparisonPage");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <ErrorBoundary>
          <GalaxyComparisonPage />
        </ErrorBoundary>
      </StrictMode>,
    );
    return;
  }
  let pages: PageSlots = {
    ...(p1Enabled ? { notifications: NotificationsPage } : {}),
    // Follow, another member's galaxy, personal statistics and withdrawal are
    // live in production (features/p1.ts): on in every build. The rest of P1
    // waits for VITE_P1_ENABLED.
    withdrawal: WithdrawalPage,
    following: FollowingPage,
    followingFeed: FollowingFeedPage,
    profile: MyProfilePage,
    member: MemberProfilePage,
    community: CommunityPage,
    hotTopics: HotTopicsPage,
    starBoard: CommunityPage,
    post: PostPage,
    postCreate: PostEditorPage,
    postEdit: PostEditorPage,
    thread: SignalThreadPage,
  };
  // /sky is the cinema galaxy (src/cinema/shell) in every build. Only the
  // dev inspectors below fill the sky slot.
  // Another member's galaxy: the cinema view (legacy page until it is ready).
  const view = await import("./cinema/shell/public-galaxy");
  pages.publicSky = view.CinemaPublicGalaxy;
  const publicGalaxy = view.PUBLIC_GALAXY_READY;
  if (import.meta.env.DEV && import.meta.env.VITE_FIXTURE === "true") {
    pages = (await import("../dev/FixturePages")).fixturePages;
  }
  // Use the analysis page in both fixture and real-server modes.
  if (p1Enabled)
    pages.statistics = (
      await import("./features/statistics/GlobalStatistics")
    ).GlobalStatisticsPage;
  pages = {
    ...pages,
    settings: SettingsPage,
    analysis: CinemaAnalysis,
    starResults: StarResultPage,
    historyDetail: HistoryDetailPage,
    publicAnalysis: PublicAnalysisPage,
    publication: PublicationPage,
    publicationBatch: PublicationPage,
  };
  // Cinema versions of the backdrop pages (src/cinema/pages). Feature
  // fixture modes keep their own page set.
  if (!(import.meta.env.DEV && import.meta.env.VITE_FIXTURE === "true"))
    pages = { ...pages, ...cinemaPages };
  if (import.meta.env.DEV && import.meta.env.VITE_SKY_DATA_FIXTURE === "true")
    pages.sky = (await import("../dev/SkyDataInspector")).SkyDataInspector;
  if (import.meta.env.DEV && import.meta.env.VITE_GALAXY_FIXTURE === "true")
    pages.sky = (await import("../dev/GalaxyInspector")).GalaxyInspector;
  if (
    import.meta.env.DEV &&
    import.meta.env.VITE_INTERACTION_FIXTURE === "true"
  )
    pages.sky = (
      await import("./features/sky-renderer/GalaxyScene")
    ).GalaxyPage;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <SessionProvider>
            {/* 공용 읽기 전용 그래프(#190). 게시글 첨부가 이 슬롯을
                기다리고 있었다(213). 비어 있으면 「연결 준비 중」이 뜬다. */}
            {/* 마이페이지 두 목록(#196). W16이 만든 슬롯을 채운다.
                개인 통계는 #198에서 P1 활성화 시 연결한다. */}
            {/* 축하는 인정된 성과에만(develop 화면은 그대로). */}
            {/* 분석·결과 화면의 시네마 문구·숫자(develop 화면은 그대로). */}
            <CinemaCopy.Provider value={cinemaAnalysisCopy}>
              <StrictCelebration.Provider value={true}>
                <App
                  pages={pages}
                  publicGalaxy={publicGalaxy}
                  historyGraphRenderer={SharedHistoryCurve}
                  profileSections={{
                    stars: MyStarsSection,
                    history: MyHistorySection,
                    statistics: PersonalStatistics,
                  }}
                />
              </StrictCelebration.Provider>
            </CinemaCopy.Provider>
          </SessionProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>,
  );
}
void start();
