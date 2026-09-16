import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useSession } from "../auth/SessionProvider";
import { ApiError, http } from "../api";

export function ServiceLayout() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<Error | null>(null);
  const logoutPending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const location = useLocation();
  async function logout() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await http.request("/v1/auth/logout", { method: "POST" });
      // clear() only follows a confirmed backend result; it also cancels reads.
      session.clear();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) session.clear();
      else
        setLogoutError(
          error instanceof Error ? error : new Error("로그아웃 요청 실패"),
        );
    } finally {
      logoutPending.current = false;
      setLoggingOut(false);
    }
  }
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
    <>
      <a className="skip-link" href="#main-content">
        본문으로 이동
      </a>
      <header className="explorer-header">
        <Link to="/sky" className="brand" aria-label="Planetory 별지도">
          PLANETORY
        </Link>
        <button
          ref={trigger}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          메뉴
        </button>
        <Link className="member-link" to="/me">
          {session.member?.nickname}
        </Link>
        <button
          type="button"
          className="logout-button"
          disabled={loggingOut}
          aria-busy={loggingOut}
          onClick={() => void logout()}
        >
          {loggingOut ? "로그아웃 중…" : "로그아웃"}
        </button>
      </header>
      {logoutError && (
        <div className="logout-feedback" role="alert">
          <p>
            {logoutError instanceof ApiError && logoutError.outcomeUnknown
              ? "로그아웃 결과를 확인하지 못했습니다. 로그인 상태를 확인해 주세요."
              : "로그아웃하지 못했습니다. 잠시 후 다시 시도해 주세요."}
          </p>
          {logoutError instanceof ApiError && logoutError.outcomeUnknown && (
            <button type="button" onClick={() => void session.refresh()}>
              로그인 상태 확인
            </button>
          )}
        </div>
      )}
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
            ["/settings", "설정"],
          ].map(([to, label]) => (
            <NavLink key={to} to={to} onClick={() => setOpen(false)}>
              {label}
            </NavLink>
          ))}
        </nav>
      </dialog>
      <main id="main-content" className="page" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
