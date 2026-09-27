import { useCallback, useEffect } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../auth/SessionProvider";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { useReadModel } from "../community/useReadModel";
import { usePostWrite, decodeWritten } from "../community/usePostWrite";
import { CommunityFeed } from "../community/CommunityFeed";
import { Pager } from "../community/CommunityPagination";
import { usePageScroll } from "../community/usePageScroll";
import {
  followPath,
  readRelation,
  readFollowSummary,
  readFollowing,
  readFollowingFeed,
  targetHref,
  type FollowTarget,
} from "./contracts";
import "./follow.css";

const changed = () =>
  window.dispatchEvent(new Event("planetory:follow-changed"));
function useFollowRefresh(reload: () => void) {
  useEffect(() => {
    window.addEventListener("planetory:follow-changed", reload);
    return () => window.removeEventListener("planetory:follow-changed", reload);
  }, [reload]);
}
export function FollowButton({ target }: { target: FollowTarget }) {
  const { member } = useSession();
  if (target.kind === "MEMBER" && target.id === member?.memberId) return null;
  return <RelationButton key={`${target.kind}:${target.id}`} target={target} />;
}
function RelationButton({ target }: { target: FollowTarget }) {
  const path = followPath(target);
  const load = useCallback(
    async (signal: AbortSignal) =>
      readRelation(await api(path, { signal }), target),
    [path, target.kind, target.id],
  );
  const state = useReadModel(path, load);
  const write = usePostWrite();
  useFollowRefresh(state.reload);
  const toggle = async () => {
    if (!state.data) return;
    const intended = !state.data.following;
    const result = await write.run(async (signal) =>
      decodeWritten(
        await api(path, { method: intended ? "PUT" : "DELETE", signal }),
        (value) => {
          const relation = readRelation(value, target);
          if (relation.following !== intended)
            throw new Error("저장 결과 불일치");
          return relation;
        },
      ),
    );
    if (result) changed();
  };
  const reload = () => {
    write.clearError();
    changed();
    state.reload();
  };
  return (
    <span className="follow-control">
      <button
        disabled={write.pending || write.uncertain || !state.data}
        aria-pressed={state.data?.following ?? false}
        onClick={() => void toggle()}
      >
        {write.pending
          ? "저장 중…"
          : state.loading
            ? "확인 중…"
            : target.kind === "MEMBER"
              ? state.data?.following
                ? "팔로잉"
                : "팔로우"
              : state.data?.following
                ? "관심 별 해제"
                : "관심 별 등록"}
      </button>
      {(state.error || write.error) && (
        <span role="alert">
          {write.uncertain
            ? "저장 여부가 불명확합니다. 다시 조회한 뒤 변경해 주세요."
            : "팔로우 상태를 확인하지 못했습니다."}
          <button onClick={reload}>상태 다시 확인</button>
        </span>
      )}
    </span>
  );
}
export function FollowSummary({
  memberId,
  own,
}: {
  memberId: string;
  own: boolean;
}) {
  const path = `/v1/members/${encodeURIComponent(memberId)}/follow-summary`;
  const load = useCallback(
    async (signal: AbortSignal) =>
      readFollowSummary(await api(path, { signal }), memberId),
    [path, memberId],
  );
  const state = useReadModel(path, load);
  useFollowRefresh(state.reload);
  if (!state.data)
    return state.error ? (
      <p className="follow-summary">
        팔로우 수를 불러오지 못했습니다.{" "}
        <button onClick={state.reload}>다시 확인</button>
      </p>
    ) : (
      <p className="follow-summary">팔로우 정보 확인 중…</p>
    );
  const s = state.data;
  return (
    <div className="follow-summary" aria-label="팔로우 요약">
      {own ? (
        <>
          <Link to="/me/following?tab=followers">팔로워 {s.followers}</Link>
          <Link to="/me/following?tab=members">
            팔로잉 {s.followingMembers}
          </Link>
          <Link to="/me/following?tab=stars">관심 별 {s.followingStars}</Link>
        </>
      ) : (
        <>
          <span>팔로워 {s.followers}</span>
          <span>팔로잉 {s.followingMembers}</span>
          <span>관심 별 {s.followingStars}</span>
        </>
      )}
    </div>
  );
}
export function FollowingPage() {
  const [search] = useSearchParams();
  const tab = ["followers", "members", "stars"].includes(
    search.get("tab") || "",
  )
    ? search.get("tab")!
    : "members";
  const cursor = search.get("cursor");
  const params = new URLSearchParams({ size: "20" });
  if (cursor) params.set("cursor", cursor);
  const path = `/v1/me/${tab === "followers" ? "followers" : "following/" + tab}?${params}`;
  const load = useCallback(
    async (signal: AbortSignal) =>
      readFollowing(await api(path, { signal }), cursor),
    [path, cursor],
  );
  const state = useReadModel(path, load);
  useFollowRefresh(state.reload);
  return (
    <section className="follow-page">
      <Link to="/me">← 마이페이지</Link>
      <header>
        <h1>나의 연결</h1>
        <p>함께 탐사할 사람과 소식을 받을 별을 관리하세요.</p>
      </header>
      <nav className="community-tabs" aria-label="팔로우 관리">
        {[
          ["members", "팔로잉"],
          ["stars", "관심 별"],
          ["followers", "팔로워"],
        ].map(([key, label]) => (
          <Link
            key={key}
            aria-current={key === tab ? "page" : undefined}
            to={"/me/following?tab=" + key}
          >
            {label}
          </Link>
        ))}
      </nav>
      {tab === "stars" && (
        <p>
          관심 별 등록은 소식 구독입니다. 내 은하에 별이 추가되는 것은 아닙니다.
        </p>
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
            <p className="follow-empty">
              {tab === "followers"
                ? "아직 나를 팔로우한 탐사자가 없습니다."
                : "아직 등록한 대상이 없습니다. 커뮤니티에서 탐사자와 별을 찾아보세요."}{" "}
              <Link to="/community">커뮤니티 둘러보기 →</Link>
            </p>
          )}
          <ul className="follow-list">
            {state.data.items.map((t) => (
              <li key={`${t.kind}:${t.id}`}>
                <Link to={targetHref(t)}>
                  <span className="follow-avatar" aria-hidden="true">
                    {t.kind === "STAR" ? "✦" : t.label.slice(0, 1)}
                  </span>
                  {t.label}
                </Link>
                <FollowButton target={t} />
              </li>
            ))}
          </ul>
          <Pager page={state.data} name="cursor" label="팔로우 목록 페이지" />
        </>
      )}
    </section>
  );
}
export function FollowingFeedPage() {
  const [search] = useSearchParams(),
    location = useLocation();
  const cursor = search.get("cursor");
  const params = new URLSearchParams({ size: "20" });
  if (cursor) params.set("cursor", cursor);
  const path = "/v1/community/following-feed?" + params;
  const load = useCallback(
    async (signal: AbortSignal) =>
      readFollowingFeed(await api(path, { signal }), cursor),
    [path, cursor],
  );
  const state = useReadModel(path, load);
  useFollowRefresh(state.reload);
  const restore = location.state?.communityRestore;
  usePageScroll(
    !!state.data,
    restore?.path === location.pathname + location.search
      ? restore.key
      : undefined,
  );
  return (
    <section className="follow-page">
      <header>
        <h1>팔로잉의 이야기</h1>
        <p>관심 있는 탐사자와 별의 새로운 글을 만나보세요.</p>
      </header>
      <nav className="community-tabs" aria-label="게시판 종류">
        <Link to="/community">전체</Link>
        <Link to="/community/signal-threads">공식 스레드</Link>
        <Link to="/community/following" aria-current="page">
          팔로잉
        </Link>
        <Link to="/community/hot-topics">핫 토픽</Link>
        <Link to="/me/following">관심 대상 관리</Link>
      </nav>
      {!state.data ? (
        state.error ? (
          <ErrorState error={state.error} retry={state.reload} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          {!state.data.items.length && (
            <p className="follow-empty">
              아직 표시할 소식이 없습니다.{" "}
              <Link to="/community">탐사 이야기 둘러보기 →</Link>
            </p>
          )}
          <CommunityFeed items={state.data.items} />
          <Pager page={state.data} name="cursor" label="팔로잉 피드 페이지" />
        </>
      )}
    </section>
  );
}
