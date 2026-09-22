import { useCallback, useEffect, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { api } from "../../api";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { useReadModel } from "../community/useReadModel";
import { usePostWrite, decodeWritten } from "../community/usePostWrite";
import { Pager } from "../community/CommunityPagination";
import { usePageScroll } from "../community/usePageScroll";
import {
  readNotices,
  readRead,
  readUnread,
  noticeDestination,
  noticeLabels,
  type Notice,
} from "./contracts";
import "./notifications.css";
const emit = () =>
  window.dispatchEvent(new Event("planetory:notifications-changed"));
function useNoticeRefresh(reload: () => void) {
  useEffect(() => {
    window.addEventListener("planetory:notifications-changed", reload);
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, 60000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("planetory:notifications-changed", reload);
    };
  }, [reload]);
}
export function NotificationBell() {
  const load = useCallback(
    async (signal: AbortSignal) =>
      readUnread(await api("/v1/me/notifications/unread-count", { signal })),
    [],
  );
  const state = useReadModel("notifications-count", load);
  useNoticeRefresh(state.reload);
  return (
    <Link
      className="notification-bell"
      to="/notifications"
      aria-label={
        state.data
          ? "알림 · 안 읽은 소식 " + state.data.unreadCount + "개"
          : "알림 · 읽지 않은 수 확인 필요"
      }
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="21" height="21">
        <path
          d="M6 9a6 6 0 0112 0c0 7 3 7 3 9H3c0-2 3-2 3-9zm4 12h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
      {!!state.data?.unreadCount && (
        <span>
          {state.data.unreadCount > 99 ? "99+" : state.data.unreadCount}
        </span>
      )}
      {state.error && <span aria-hidden="true">!</span>}
    </Link>
  );
}
export function NotificationsPage() {
  const [search] = useSearchParams(),
    navigate = useNavigate(),
    location = useLocation();
  const unreadOnly = search.get("filter") === "unread",
    cursor = search.get("cursor");
  const params = new URLSearchParams({
    size: "20",
    unreadOnly: String(unreadOnly),
  });
  if (cursor) params.set("cursor", cursor);
  const path = "/v1/me/notifications?" + params;
  const load = useCallback(
    async (signal: AbortSignal) =>
      readNotices(await api(path, { signal }), cursor),
    [path, cursor],
  );
  const state = useReadModel(path, load),
    write = usePostWrite();
  useNoticeRefresh(state.reload);
  const [message, setMessage] = useState("");
  usePageScroll(!!state.data);
  const confirm = () => {
    write.clearError();
    setMessage("");
    emit();
  };
  async function open(item: Notice) {
    setMessage("");
    const result = await write.run(async (signal) => {
      const target = noticeDestination(
        await api(
          "/v1/me/notifications/" +
            encodeURIComponent(item.notificationId) +
            "/target",
          { signal },
        ),
        item.notificationId,
      );
      if (!target) return null;
      if (!item.read)
        decodeWritten(
          await api(
            "/v1/me/notifications/" + encodeURIComponent(item.notificationId),
            { method: "PATCH", json: { read: true }, signal },
          ),
          (v) => readRead(v, item.notificationId),
        );
      return target;
    });
    if (!result) return;
    emit();
    if (result.value === null) {
      setMessage("지금은 해당 소식을 확인할 수 없습니다.");
      return;
    }
    const next = new URL(result.value, "https://planetory.invalid");
    next.searchParams.set("returnTo", location.pathname + location.search);
    navigate(next.pathname + next.search + next.hash);
  }
  async function readAll() {
    if (!state.data) return;
    const boundary = state.data.readBoundary;
    const result = await write.run(async (signal) =>
      decodeWritten(
        await api("/v1/me/notifications/read", {
          method: "PATCH",
          json: { through: boundary },
          signal,
        }),
        readUnread,
      ),
    );
    if (result) {
      setMessage("확인한 시점까지의 알림을 모두 읽었습니다.");
      emit();
    }
  }
  return (
    <section className="notifications-page">
      <header>
        <div>
          <h1>알림</h1>
          <p>나의 탐사와 이어지는 소식을 확인하세요.</p>
        </div>
        <Link to="/settings#notifications">수신 설정</Link>
      </header>
      <div className="notifications-tools">
        <nav className="community-tabs" aria-label="알림 필터">
          <Link
            to="/notifications"
            aria-current={!unreadOnly ? "page" : undefined}
          >
            전체
          </Link>
          <Link
            to="/notifications?filter=unread"
            aria-current={unreadOnly ? "page" : undefined}
          >
            안 읽음
          </Link>
        </nav>
        <button
          disabled={write.pending || write.uncertain || !state.data}
          onClick={() => void readAll()}
        >
          모두 읽음
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {write.error && (
        <div role="alert">
          {write.uncertain
            ? "읽음 처리 여부를 확인하지 못했습니다. 다시 조회해 주세요."
            : write.error.message}
          <button onClick={confirm}>알림 다시 확인</button>
        </div>
      )}
      {!state.data ? (
        state.error ? (
          <ErrorState error={state.error} retry={state.reload} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          {!state.data.items.length && (
            <p className="notifications-empty">
              {unreadOnly
                ? "읽지 않은 알림이 없습니다."
                : "아직 도착한 소식이 없습니다."}
            </p>
          )}
          <ul className="notifications-list">
            {state.data.items.map((item) => (
              <li
                key={item.notificationId}
                className={item.read ? "" : "is-unread"}
              >
                <span
                  className="notification-dot"
                  aria-label={item.read ? "읽음" : "안 읽음"}
                />
                <button
                  disabled={!item.available || write.pending || write.uncertain}
                  onClick={() => void open(item)}
                >
                  <small>
                    {noticeLabels[item.kind]} ·{" "}
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString("ko-KR")}
                    </time>
                  </small>
                  <strong>{item.title}</strong>
                  <p>{item.body}</p>
                </button>
              </li>
            ))}
          </ul>
          <Pager page={state.data} name="cursor" label="알림 페이지" />
        </>
      )}
    </section>
  );
}
