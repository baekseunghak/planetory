import { PublicSkyPage } from "./features/public-sky/PublicSky";
import {
  MyProfilePage,
  MemberProfilePage,
} from "./features/profile/ProfilePage";
import { StrictMode } from "react";
import { FollowingPage, FollowingFeedPage } from "./features/follow/Follow";
import { p1Enabled } from "./features/p1";
import { NotificationsPage } from "./features/notifications/Notifications";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App, type PageSlots } from "./app/App";
import { SharedHistoryCurve } from "./features/analysis/HistoryCurveChart";
import { HistoryDetailPage } from "./features/history/HistoryDetailPage";
import { SessionProvider } from "./auth/SessionProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AnalysisPage } from "./features/analysis/AnalysisPage";
import "./styles.css";
import { SkyDataPage } from "./features/sky-data/SkyDataPage";
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
    ...(p1Enabled
      ? { withdrawal: WithdrawalPage, publicSky: PublicSkyPage }
      : {}),
    ...(p1Enabled ? { notifications: NotificationsPage } : {}),
    ...(p1Enabled
      ? { following: FollowingPage, followingFeed: FollowingFeedPage }
      : {}),
    sky: SkyDataPage,
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
  if (import.meta.env.VITE_SKY_RENDERER_ENABLED === "true")
    pages.sky = (
      await import("./features/sky-renderer/GalaxyScene")
    ).GalaxyPage;
  if (import.meta.env.DEV && import.meta.env.VITE_FIXTURE === "true") {
    pages = (await import("../dev/FixturePages")).fixturePages;
  }
  // Use the analysis page in both fixture and real-server modes.
  pages = {
    ...pages,
    settings: SettingsPage,
    analysis: AnalysisPage,
    historyDetail: HistoryDetailPage,
  };
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
            <App pages={pages} historyGraphRenderer={SharedHistoryCurve} />
          </SessionProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>,
  );
}
void start();
