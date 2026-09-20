import {
  ProfileSlots,
  type ProfileSlotComponents,
} from "../features/profile/ProfileSlots";
import {
  HistoryGraphRenderer,
  type HistoryGraphProps,
} from "../features/history/HistoryGraph";
import { useEffect, useState, type ComponentType } from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { LoginPage, LogoutStatus } from "../auth/LoginPage";
import { useSession } from "../auth/SessionProvider";
import { ErrorState, LoadingState } from "../components/RequestState";
import { ServiceLayout } from "../components/ServiceLayout";
import { routeDefinitions, safeReturnTo, type PageKey } from "./paths";
import { usePageContext } from "./usePageContext";

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
function UnconnectedPage({ pageKey }: { pageKey: PageKey }) {
  const definition = routeDefinitions.find((route) => route.key === pageKey)!;
  const context = usePageContext();
  return (
    <section className="unconnected">
      <p className="eyebrow">PLANETORY</p>
      <h1>{definition.title}</h1>
      <p>이 화면은 연결 준비 중입니다.</p>
      {context.ticId && <p>TIC {context.ticId}</p>}
      {context.historyId && <p>분석 기록 {context.historyId}</p>}
      <Link className="text-link" to={context.returnTo}>
        이전 화면으로
      </Link>
    </section>
  );
}
function DesktopGate({ children }: { children: React.ReactNode }) {
  const [small, setSmall] = useState(
    () => window.matchMedia("(max-width: 1023px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const change = () => setSmall(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return small ? (
    <main className="desktop-notice">
      <span className="brand">PLANETORY</span>
      <h1>데스크톱에서 이용해 주세요</h1>
      <p>Planetory는 폭 1024px 이상의 화면을 지원합니다.</p>
    </main>
  ) : (
    children
  );
}
export function App({
  pages = {},
  historyGraphRenderer = null,
  profileSections = {},
}: {
  pages?: PageSlots;
  historyGraphRenderer?: ComponentType<HistoryGraphProps> | null;
  profileSections?: ProfileSlotComponents;
}) {
  return (
    <ProfileSlots.Provider value={profileSections}>
      <HistoryGraphRenderer.Provider value={historyGraphRenderer}>
        <DesktopGate>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/oauth/callback" element={<LoginPage />} />
            <Route element={<ProtectedRoutes />}>
              <Route element={<ServiceLayout />}>
                <Route path="/" element={<Navigate replace to="/sky" />} />
                {routeDefinitions.map((route) => {
                  const Page = pages[route.key];
                  return (
                    <Route
                      key={route.key}
                      path={route.path}
                      element={
                        Page ? (
                          <Page />
                        ) : (
                          <UnconnectedPage pageKey={route.key} />
                        )
                      }
                    />
                  );
                })}
                <Route
                  path="*"
                  element={
                    <section>
                      <h1>페이지를 찾을 수 없습니다</h1>
                      <Link to="/sky">별지도로 돌아가기</Link>
                    </section>
                  }
                />
              </Route>
            </Route>
          </Routes>
        </DesktopGate>
      </HistoryGraphRenderer.Provider>
    </ProfileSlots.Provider>
  );
}
