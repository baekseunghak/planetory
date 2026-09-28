import {
  ProfileSlots,
  type ProfileSlotComponents,
} from "../features/profile/ProfileSlots";
import {
  HistoryGraphRenderer,
  type HistoryGraphProps,
} from "../features/history/HistoryGraph";
import { useEffect, useState, type ComponentType } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { LoginPage, LogoutStatus } from "../auth/LoginPage";
import { useSession } from "../auth/SessionProvider";
import { ErrorState, LoadingState } from "../components/RequestState";
import { CinemaRoot } from "../cinema/shell/CinemaRoot";
import { CinemaLayout } from "../cinema/shell/CinemaLayout";
import { GalaxyView } from "../cinema/shell/GalaxyView";
import { AnalysisStage } from "../cinema/shell/AnalysisStage";
import { MissingScreen } from "../cinema/pages/routes";
import { routeDefinitions, safeReturnTo, type PageKey } from "./paths";
import { WithdrawalStatusPage } from "../features/profile/WithdrawalPage";

export type PageSlots = Partial<Record<PageKey, ComponentType>>;
function ProtectedRoutes() {
  const session = useSession();
  const location = useLocation();
  if (session.logoutState.phase !== "idle") return <LogoutStatus />;
  if (session.status === "loading")
    return (
      <main className="page">
        <LoadingState />
      </main>
    );
  if (session.status === "error")
    return (
      <main className="page">
        <ErrorState
          error={session.error}
          retry={() => void session.refresh()}
        />
      </main>
    );
  if (session.status === "anonymous" || session.status === "profile-required")
    return (
      <Navigate
        replace
        to={`/login?${new URLSearchParams({ returnTo: safeReturnTo(location.pathname + location.search + location.hash) })}`}
      />
    );
  if (session.status === "authenticated")
    return <Outlet key={`${session.member.memberId}:${session.revision}`} />;
  return null;
}
// A route without a page (P1 off, not built yet) and an unknown address
// show the one framed "없는 화면" notice with the way back (cinema/pages).
function UnconnectedPage({ pageKey }: { pageKey: PageKey }) {
  return <MissingScreen pageKey={pageKey} />;
}
function DesktopGate({ children }: { children: React.ReactNode }) {
  const [{ small, entered }, setViewport] = useState(() => {
    const small = window.matchMedia("(max-width: 1023px)").matches;
    return { small, entered: !small };
  });
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const change = () => {
      const small = media.matches;
      setViewport((previous) => ({
        small,
        entered: previous.entered || !small,
      }));
    };
    media.addEventListener("change", change);
    change();
    return () => media.removeEventListener("change", change);
  }, []);
  return (
    <>
      {small && (
        <main className="desktop-notice">
          <span className="brand">PLANETORY</span>
          <h1>데스크톱에서 이용해 주세요</h1>
          <p>Planetory는 폭 1024px 이상의 화면을 지원합니다.</p>
        </main>
      )}
      {/* Resizing changes availability, not the route or session. Preserve an
          entered page's canvas and selection; auth expiry still unmounts it. */}
      <div className="desktop-content" hidden={small} inert={small}>
        {entered ? children : null}
      </div>
    </>
  );
}
export function App({
  pages = {},
  historyGraphRenderer = null,
  profileSections = {},
  publicGalaxy = false,
}: {
  pages?: PageSlots;
  historyGraphRenderer?: ComponentType<HistoryGraphProps> | null;
  profileSections?: ProfileSlotComponents;
  /** The publicSky slot draws in the scene (shell/public-galaxy). */
  publicGalaxy?: boolean;
}) {
  // /sky is the galaxy itself (a camera move, not a page) unless a dev
  // inspector fills the slot. /analysis is always framed over the system.
  const skyOverride = Boolean(pages.sky);
  return (
    <ProfileSlots.Provider value={profileSections}>
      <HistoryGraphRenderer.Provider value={historyGraphRenderer}>
        <DesktopGate>
          <CinemaRoot>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/withdrawal/status/:requestId"
                element={<WithdrawalStatusPage />}
              />
              <Route path="/oauth/callback" element={<LoginPage />} />
              <Route element={<ProtectedRoutes />}>
                <Route
                  element={
                    <CinemaLayout
                      skyOverride={skyOverride}
                      publicGalaxy={publicGalaxy && Boolean(pages.publicSky)}
                    />
                  }
                >
                  <Route path="/" element={<Navigate replace to="/sky" />} />
                  {routeDefinitions.map((route) => {
                    const Page = pages[route.key];
                    let element = Page ? (
                      <Page />
                    ) : route.key === "sky" ? (
                      <GalaxyView />
                    ) : (
                      <UnconnectedPage pageKey={route.key} />
                    );
                    if (route.key === "analysis")
                      element = <AnalysisStage>{element}</AnalysisStage>;
                    return (
                      <Route
                        key={route.key}
                        path={route.path}
                        element={element}
                      />
                    );
                  })}
                  <Route path="*" element={<MissingScreen />} />
                </Route>
              </Route>
            </Routes>
          </CinemaRoot>
        </DesktopGate>
      </HistoryGraphRenderer.Provider>
    </ProfileSlots.Provider>
  );
}
