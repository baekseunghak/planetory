import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useSession } from "../auth/SessionProvider";
import "./service-presentation.css";
import { p1Enabled } from "../features/p1";
import { NotificationBell } from "../features/notifications/Notifications";

export function ServiceLayout() {
  const session = useSession();
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
  return (
    <div className="service-presentation">
      <a className="skip-link" href="#main-content">
        본문으로 이동
      </a>
      <header
        className={`explorer-header${location.pathname.startsWith("/analysis/") ? " analysis-service-header" : ""}`}
      >
        <Link to="/sky" className="brand" aria-label="Planetory 별지도">
          PLANETORY
        </Link>
        <button
          className="menu-trigger"
          ref={trigger}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
            <path
              d="M3 5h14M3 10h14M3 15h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
          메뉴
        </button>
        <Link className="member-link" to="/me">
          {session.member?.nickname}
        </Link>
        {p1Enabled && <NotificationBell />}
        <button
          type="button"
          className="logout-button"
          disabled={session.logoutState.phase === "pending"}
          aria-busy={session.logoutState.phase === "pending"}
          onClick={() => void session.logout()}
        >
          로그아웃
        </button>
      </header>
      <dialog
        ref={dialog}
        className="navigation"
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
          {[
            ["/sky", "별지도"],
            ["/community", "커뮤니티"],
            ["/me", "마이페이지"],
            ["/statistics", "통계"],
          ].map(([to, label]) => (
            <NavLink key={to} to={to} onClick={() => setOpen(false)}>
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="navigation-caption">
          별빛의 변화를 읽고
          <br />
          나의 발견으로 밤하늘을 채워보세요.
        </p>
        <button
          className="auth-text-action"
          onClick={() => void session.logout()}
        >
          로그아웃
        </button>
      </dialog>
      <main
        id="main-content"
        className={
          location.pathname.startsWith("/analysis/")
            ? "page analysis-page-container"
            : location.pathname === "/sky" ||
                /^\/members\/[^/]+\/sky$/.test(location.pathname)
              ? "page sky-page-container"
              : /^(\/community|\/posts|\/signal-threads|\/stars\/[^/]+\/board|\/me$|\/members\/)/.test(
                    location.pathname,
                  )
                ? "page service-page"
                : "page"
        }
        tabIndex={-1}
      >
        <Outlet />
      </main>
    </div>
  );
}
