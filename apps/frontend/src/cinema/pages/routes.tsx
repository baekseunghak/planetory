// Route components for the pages over the dimmed galaxy. Each one is the
// feature page as it is (data, rules, validation, accessibility) inside the
// product frame; only /history and the not-yet-connected routes get markup
// of their own, built from existing components.
import { lazy, Suspense, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { routeDefinitions, type PageKey } from "../../app/paths";
import { usePageContext } from "../../app/usePageContext";
import { useSession } from "../../auth/SessionProvider";
import { LoadingState } from "../../components/RequestState";
import { HistoryDetailPage } from "../../features/history/HistoryDetailPage";
import { PublicAnalysisPage } from "../../features/history/PublicAnalysisPage";
import { MyHistorySection } from "../../features/my-lists/MyHistorySection";
import { PageFrame, type FrameHead, type FrameWidth } from "./PageFrame";

/** The feature page, framed. */
export function framed(
  page: string,
  width: FrameWidth,
  Page: ComponentType,
  head?: FrameHead,
): ComponentType {
  function Framed() {
    return (
      <PageFrame page={page} width={width} head={head}>
        <Page />
      </PageFrame>
    );
  }
  Framed.displayName = `CinemaPage(${page})`;
  return Framed;
}

// History detail and public analysis have a section title only; the frame
// gives them the page title (their own h2 is hidden in pages.css).
export const CinemaHistoryDetail = framed(
  "history-detail",
  "standard",
  HistoryDetailPage,
  { eyebrow: "내 분석 기록", title: "제출 기록 상세" },
);
export const CinemaPublicAnalysis = framed(
  "public-analysis",
  "standard",
  PublicAnalysisPage,
  { eyebrow: "커뮤니티", title: "공개 분석" },
);

// Loaded on first visit, like main.tsx does for the legacy slot.
const GlobalStatisticsPage = lazy(() =>
  import("../../features/statistics/GlobalStatistics").then((module) => ({
    default: module.GlobalStatisticsPage,
  })),
);
export function CinemaStatistics() {
  return (
    <PageFrame page="statistics" width="wide">
      <Suspense fallback={<LoadingState />}>
        <GlobalStatisticsPage />
      </Suspense>
    </PageFrame>
  );
}

/** `/history`: my analysis records, the list My page shows under a tab. */
export function CinemaHistoryList() {
  const { member } = useSession();
  if (!member) return null;
  return (
    <PageFrame
      page="history-list"
      width="standard"
      head={{
        eyebrow: "마이페이지",
        title: "내 분석 기록",
        lede: "제출한 분석을 결과별로 모아 봅니다.",
      }}
    >
      <MyHistorySection
        memberId={member.memberId}
        isOwn
        starListVisibility="PRIVATE"
      />
    </PageFrame>
  );
}

/** Names of screens the cinema app does not offer (yet, or with P1 off). */
const MISSING_NAMES: Partial<Record<PageKey, string>> = {
  publicSky: "다른 탐사자의 은하",
  followingFeed: "팔로잉 소식",
};

/**
 * One notice for every screen that is not there: routes not built yet, P1
 * routes while P1 is off, and unknown addresses. Framed like every page,
 * always with the way back to 나의 은하 (and to where the member came from,
 * when the address says so).
 */
export function MissingScreen({ pageKey }: { pageKey?: PageKey }) {
  const context = usePageContext();
  const definition = pageKey
    ? routeDefinitions.find((route) => route.key === pageKey)
    : undefined;
  const name = pageKey
    ? (MISSING_NAMES[pageKey] ?? definition?.title ?? null)
    : null;
  const [, query = ""] = context.currentPath.split("?");
  const back = new URLSearchParams(query.split("#")[0]).has("returnTo");
  return (
    <PageFrame page="missing" width="reading">
      <section className="cp-notice cp-missing" data-page-key={pageKey}>
        <h1>없는 화면입니다</h1>
        <p>
          {name
            ? `'${name}' 화면은 지금 제공하지 않습니다.`
            : "주소가 바뀌었거나 지금 제공하지 않는 화면입니다."}
        </p>
        <p>나의 은하에서 탐사를 이어가 주세요.</p>
        <div className="cp-notice-actions">
          <Link className="cp-button cp-button-primary" to="/sky">
            나의 은하로
          </Link>
          {back && context.returnTo !== "/sky" && (
            <Link className="cp-button" to={context.returnTo}>
              이전 화면으로
            </Link>
          )}
        </div>
      </section>
    </PageFrame>
  );
}

/** Routes whose screen is not built yet: the missing-screen notice. */
export function cinemaUnconnected(pageKey: PageKey): ComponentType {
  function Unconnected() {
    return <MissingScreen pageKey={pageKey} />;
  }
  Unconnected.displayName = `CinemaUnconnected(${pageKey})`;
  return Unconnected;
}
