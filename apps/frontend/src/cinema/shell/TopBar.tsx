import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useSession } from "../../auth/SessionProvider";
import { p1Enabled } from "../../features/p1";
import { NotificationBell } from "../../features/notifications/Notifications";
import { useSceneState } from "../scene";
import { useShell } from "./context";
import { useCinemaSky } from "./sky";

const menu: [string, string][] = [
  ["/sky", "나의 은하"],
  ["/community", "커뮤니티"],
  ["/me", "마이페이지"],
  ...(p1Enabled ? ([["/notifications", "알림"]] as [string, string][]) : []),
  ["/settings", "설정"],
  ...(p1Enabled ? ([["/statistics", "통계"]] as [string, string][]) : []),
];

/** Planets are counted only once every star of this sky version is loaded. */
function planetTotal(data: ReturnType<typeof useCinemaSky>["data"]) {
  if (!data.meta || data.phase !== "ready") return null;
  if (data.loadedCount !== data.meta.starCount) return null;
  return data.stars.reduce((sum, star) => sum + star.planetCount, 0);
}

/**
 * The number on screen. While `held` it stays put (a discovery is still
 * playing); otherwise it counts up (or down) to the live value. A value
 * that is briefly unknown (a sky refresh) keeps the last one shown.
 */
export function useTallyCount(
  live: number | null,
  held: boolean,
  instant: boolean,
): number | null {
  const [shown, setShown] = useState(live);
  const current = useRef(shown);
  current.current = shown;
  useEffect(() => {
    if (held || live === null) return;
    const from = current.current;
    if (from === null || instant || from === live) {
      setShown(live);
      return;
    }
    const t0 = performance.now();
    const ms = Math.min(1400, 500 + 120 * Math.abs(live - from));
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(from + (live - from) * e));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [live, held, instant]);
  return shown ?? live;
}

export function TopBar() {
  const session = useSession();
  const { data } = useCinemaSky();
  const { director } = useShell();
  const hold = useSyncExternalStore(director.subscribeHold, director.getHold);
  const { reducedMotion } = useSceneState();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const location = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      previous.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : trigger.current;
      node.showModal();
    } else if (!open && node.open) {
      node.close();
      previous.current?.focus();
    }
  }, [open]);
  const stars = useTallyCount(
    data.meta?.starCount ?? null,
    hold.stars,
    reducedMotion,
  );
  const planets = useTallyCount(planetTotal(data), hold.planets, reducedMotion);
  return (
    <header className="cinema-topbar">
      <Link
        to="/sky"
        className="cinema-wordmark"
        aria-label="Planetory 나의 은하"
      >
        PLANETORY
      </Link>
      <div className="cinema-topbar-end">
        {data.meta && stars !== null && (
          <p className="cinema-tally">
            <span>
              발견한 별
              <b data-testid="sky-total">{stars.toLocaleString("ko-KR")}</b>
            </span>
            {planets !== null && (
              <span>
                찾은 행성
                <b data-testid="planet-total">
                  {planets.toLocaleString("ko-KR")}
                </b>
              </span>
            )}
          </p>
        )}
        {p1Enabled && <NotificationBell />}
        <Link className="member-link" to="/me">
          {session.member?.nickname}
        </Link>
        <button
          className="menu-trigger cinema-pill"
          ref={trigger}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14">
            <path
              d="M3 5h14M3 10h14M3 15h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
          메뉴
        </button>
      </div>
      <dialog
        ref={dialog}
        className="navigation cinema-menu"
        aria-labelledby="menu-title"
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const elements = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              "button:not(:disabled), a[href]",
            ),
          ].filter((node) => node.getClientRects().length);
          const first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="navigation-head">
          <h2 id="menu-title">메뉴</h2>
          <button
            autoFocus
            onClick={() => setOpen(false)}
            aria-label="메뉴 닫기"
          >
            닫기
          </button>
        </div>
        <nav aria-label="주 메뉴">
          {menu.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/sky"}
              onClick={() => setOpen(false)}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="navigation-caption">
          {session.member?.nickname}님의 은하
        </p>
        <button
          className="auth-text-action cinema-menu-logout"
          disabled={session.logoutState.phase === "pending"}
          onClick={() => void session.logout()}
        >
          로그아웃
        </button>
      </dialog>
    </header>
  );
}
