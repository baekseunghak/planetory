import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  NavLink,
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { Orbit, Bell, LogOut, UserRound, ArrowUpRight } from "lucide-react";
import type { ApiSession, Member, Notification } from "../shared/types";
import { nextTutorialStep, type TutorialEvent } from "../shared/tutorial";
import { api, mutation } from "./api/client";
import { useResource } from "./api/hooks";
import {
  ActionError,
  Empty,
  RequestState,
  useAction,
  date,
} from "./components/ui";
import { SkyPage } from "./pages/SkyPage";
import {
  CommunityPage,
  PostPage,
  ComposePage,
  PublicAnalysisPage,
} from "./pages/CommunityPages";
import {
  ProfilePage,
  HistoryPage,
  HistoryDetailPage,
  SettingsPage,
  StatisticsPage,
} from "./pages/PersonalPages";
import { AnalysisPage, ResultsPage, PublishPage } from "./pages/AnalysisPages";
interface Context {
  member: Member;
  mode: string;
  refresh: () => Promise<void>;
  guide: number | null;
  setGuide: (step: number | null) => void;
  guideStarId: string | null;
  startGuide: (starId: string) => void;
  advanceGuide: (starId: string, event: TutorialEvent) => void;
}
const Context = createContext<Context | null>(null);
export const useApp = () => useContext(Context)!;
function Gate({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(innerWidth);
  useEffect(() => {
    const cb = () => setWidth(innerWidth);
    addEventListener("resize", cb);
    return () => removeEventListener("resize", cb);
  }, []);
  return width < 1024 ? (
    <main className="device-gate">
      <Orbit size={50} />
      <h1>데스크톱에서 이용해 주세요</h1>
      <p>
        Planetory는 화면 폭 1024px 이상의 데스크톱 브라우저에서 이용할 수
        있습니다.
      </p>
    </main>
  ) : (
    children
  );
}
export function App() {
  return (
    <Gate>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/oauth/callback" element={<OAuthCallback />} />
        <Route element={<Authenticated />}>
          <Route path="/" element={<Navigate to="/sky" replace />} />
          <Route path="/sky" element={<SkyPage />} />
          <Route path="/community" element={<CommunityPage />} />
          <Route path="/community/stars/:starId" element={<CommunityPage />} />
          <Route path="/community/new" element={<ComposePage />} />
          <Route
            path="/community/posts/:postId/edit"
            element={<ComposePage />}
          />
          <Route path="/community/posts/:postId" element={<PostPage />} />
          <Route
            path="/community/analyses/:publicationId"
            element={<PublicAnalysisPage />}
          />
          <Route path="/me" element={<ProfilePage />} />
          <Route path="/members/:memberId" element={<ProfilePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/history/:historyId" element={<HistoryDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/statistics" element={<StatisticsPage />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/analysis/:starId" element={<AnalysisPage />} />
          <Route path="/results/:starId" element={<ResultsPage />} />
          <Route path="/publish/:starId" element={<PublishPage />} />
          <Route
            path="*"
            element={
              <main className="page">
                <Empty title="페이지를 찾을 수 없습니다">
                  <Link to="/sky">밤하늘로 돌아가기</Link>
                </Empty>
              </main>
            }
          />
        </Route>
      </Routes>
    </Gate>
  );
}
function Authenticated() {
  const resource = useResource<ApiSession>("/session"),
    [session, setSession] = useState<ApiSession | null>(null),
    [guide, setGuide] = useState<number | null>(null),
    [guideStarId, setGuideStarId] = useState<string | null>(null);
  const navigate = useNavigate(),
    location = useLocation();
  useEffect(() => {
    if (resource.data) setSession(resource.data);
  }, [resource.data]);
  useEffect(() => {
    const expired = () => {
      setSession(null);
      setGuide(null);
      navigate("/login?expired=1", { replace: true });
    };
    addEventListener("session-expired", expired);
    return () => removeEventListener("session-expired", expired);
  }, [navigate]);
  const refresh = async () => {
    const s = await api<ApiSession>("/session");
    setSession(s);
  };
  if (resource.loading && !session) return <RequestState state={resource} />;
  if (resource.error) return <RequestState state={resource} />;
  if (!session && resource.data?.member)
    return (
      <div role="status" className="loading">
        계정을 불러오는 중입니다…
      </div>
    );
  if (!session?.member)
    return (
      <Navigate
        replace
        to={
          "/login?returnTo=" +
          encodeURIComponent(location.pathname + location.search)
        }
      />
    );
  return (
    <Context.Provider
      value={{
        member: session.member,
        mode: session.mode,
        refresh,
        guide,
        setGuide,
        guideStarId,
        startGuide: (starId) => {
          setGuideStarId(starId);
          setGuide(0);
        },
        advanceGuide: (starId, event) => {
          if (starId === guideStarId)
            setGuide((step) => nextTutorialStep(step, event));
        },
      }}
    >
      <Shell>
        <Outlet />
      </Shell>
    </Context.Provider>
  );
}
function Shell({ children }: { children: ReactNode }) {
  const { member, mode, setGuide } = useApp(),
    navigate = useNavigate();
  const a = useAction();
  return (
    <>
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <header className="app-header">
        <Link className="brand" to="/sky">
          <Orbit size={25} />
          <span>
            PLANETORY<small>CITIZEN EXPLORATION</small>
          </span>
        </Link>
        <nav aria-label="주 메뉴">
          <NavLink to="/sky">밤하늘</NavLink>
          <NavLink to="/community">커뮤니티</NavLink>
          <NavLink to="/statistics">통계</NavLink>
        </nav>
        <div className="header-right">
          {mode === "local-fixture" && (
            <span className="environment-label">은하 시연 · 합성 자료</span>
          )}
          <Link className="icon-button" to="/notifications" aria-label="알림">
            <Bell size={18} />
          </Link>
          <NavLink className="profile-link" to="/me">
            <UserRound size={17} />
            {member.nickname}
          </NavLink>
          <button
            className="icon-button"
            aria-label="로그아웃"
            disabled={a.pending}
            onClick={() =>
              a.run(async () => {
                await mutation("/logout", {});
                setGuide(null);
                navigate("/login", { replace: true });
              })
            }
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <ActionError message={a.error} />
      <div id="main-content" tabIndex={-1}>
        {children}
      </div>
    </>
  );
}
function Login() {
  const [params] = useSearchParams();
  const session = useResource<ApiSession>("/session");
  if (session.data?.member) return <Navigate to="/sky" replace />;
  return (
    <main className="login-page">
      <Link to="/login" className="brand">
        <Orbit />
        <span>PLANETORY</span>
      </Link>
      <section>
        <p className="eyebrow">A SMALL SIGNAL. A NEW PERSPECTIVE.</p>
        <h1>
          작은 빛의 변화에서
          <br />
          시작되는 <em>나의 우주.</em>
        </h1>
        <p>
          별의 밝기를 살펴보고, 반복되는 신호를 찾아보세요.
          <br />
          당신의 기록이 함께 탐사하는 밤하늘을 넓힙니다.
        </p>
        <div className="login-actions">
          <a
            className="button primary"
            href={
              "/api/auth/ssafy?returnTo=" +
              encodeURIComponent(params.get("returnTo") || "/sky")
            }
          >
            SSAFY로 시작하기 <ArrowUpRight size={18} />
          </a>
          <a
            className="button"
            href={
              "/api/auth/google?returnTo=" +
              encodeURIComponent(params.get("returnTo") || "/sky")
            }
          >
            Google로 시작하기 <ArrowUpRight size={18} />
          </a>
        </div>
        {session.error && <RequestState state={session} />}
        {session.data?.mode === "local-fixture" && (
          <p className="local-note">
            현재는 로컬 검증 환경입니다. 위 버튼은 가상 계정으로 연결되며 실제
            OAuth 인증은 수행하지 않습니다.
          </p>
        )}
        {params.has("expired") && (
          <p role="status" className="notice">
            세션이 만료되었습니다. 다시 로그인해 주세요.
          </p>
        )}
      </section>
      <div className="login-sky" aria-hidden="true">
        {Array.from({ length: 50 }, (_, i) => (
          <i
            key={i}
            style={{
              left: ((i * 67.31) % 100) + "%",
              top: ((i * 41.17) % 100) + "%",
              width: i % 7 === 0 ? 4 : 2,
              height: i % 7 === 0 ? 4 : 2,
            }}
          />
        ))}
        <div className="login-star" />
      </div>
      <footer>TESS 관측을 바탕으로 함께 탐사하는 시민과학 서비스</footer>
    </main>
  );
}
function OAuthCallback() {
  const [params] = useSearchParams(),
    navigate = useNavigate(),
    once = useRef(false),
    a = useAction();
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    void a.run(async () => {
      const r = await mutation<{ returnTo: string }>("/auth/callback", {
        code: params.get("code"),
        state: params.get("state"),
      });
      navigate(r.returnTo, { replace: true });
    });
  }, []);
  return (
    <main className="auth-callback">
      <Orbit size={40} />
      <h1>로그인을 확인하고 있습니다</h1>
      <ActionError message={a.error} />
      {a.error && <Link to="/login">로그인 화면으로 돌아가기</Link>}
    </main>
  );
}
function Notifications() {
  const r = useResource<{ items: Notification[] }>("/notifications"),
    a = useAction(),
    navigate = useNavigate();
  return (
    <main className="page">
      <div className="page-title">
        <div>
          <p className="eyebrow">UPDATES</p>
          <h1>알림</h1>
        </div>
        <div className="actions">
          <Link to="/settings">알림 설정</Link>
          <button
            disabled={a.pending}
            onClick={() =>
              a.run(async () => {
                await mutation("/notifications", {});
                r.reload();
              })
            }
          >
            모두 읽음
          </button>
        </div>
      </div>
      <ActionError message={a.error} />
      <RequestState state={r} />
      {r.data && !r.data.items.length && (
        <Empty title="새로운 알림이 없습니다" />
      )}
      <div className="notification-list">
        {r.data?.items.map((n) => (
          <article key={n.id} className={n.read ? "read" : ""}>
            <span className="notification-dot" />
            <div>
              <small>{date(n.createdAt)}</small>
              <p>{n.message}</p>
              {n.unavailable ? (
                <span className="muted">현재 볼 수 없는 대상입니다.</span>
              ) : (
                <button
                  className="text-button"
                  disabled={a.pending}
                  onClick={() =>
                    void a.run(async () => {
                      await mutation("/notifications", { id: n.id });
                      navigate(n.target);
                    })
                  }
                >
                  {n.kind === "reopened" ? "다시 분석" : "내용 보기"} →
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
