import { useCallback, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { http } from "../../api";
import { pagePath } from "../../app/paths";
import type { ProfileSlotProps } from "../profile/ProfileSlots";
import { readMyStars, starsPath, type MyStar } from "./my-lists-data";
import { usePagedList } from "./use-paged-list";
import { emptyStarFilters, starSearchPath } from "../sky-renderer/star-search";
import "./my-lists.css";

// #196 내 별 목록(탐사 API 4.4). W16이 만든 프로필 슬롯을 채운다.
// **권한은 여기서 다시 보지 않는다** — 타인의 비공개 목록은 슬롯이 먼저 막는다.

// 백엔드 StarService.STAGES와 같은 값이다. 저장소의 다른 파서도 이 셋을 쓴다.
const STAGE: Record<string, string> = {
  unexplored: "아직 시작하지 않음",
  in_progress: "탐색 중",
  completed: "탐색 완료",
};
const count = new Intl.NumberFormat("ko-KR");
const when = (value: string) => new Date(value).toLocaleString("ko-KR");

export function MyStarsSection({
  memberId,
  isOwn,
  starFilters,
}: ProfileSlotProps) {
  const location = useLocation();
  const returnTo = location.pathname + location.search;
  const target = isOwn ? null : memberId;
  const filters = isOwn ? (starFilters ?? emptyStarFilters) : emptyStarFilters;
  const filterKey = JSON.stringify(filters);
  const load = useCallback(
    async (cursor: string | null, signal: AbortSignal) =>
      readMyStars(
        await http.request(
          isOwn
            ? starSearchPath(filters, cursor, "submitted")
            : starsPath(target, cursor),
          { signal },
        ),
      ),
    [target, isOwn, filterKey],
  );
  const { state, reload, more } = usePagedList(
    useMemo(
      () => `stars:${target ?? "me"}:${isOwn ? filterKey : "public"}`,
      [target, isOwn, filterKey],
    ),
    load,
  );

  if (state.phase === "loading")
    return <p role="status">별 목록을 불러오는 중입니다.</p>;
  if (state.phase === "error")
    return (
      <p role="alert">
        {state.message}{" "}
        <button type="button" onClick={reload}>
          다시 불러오기
        </button>
      </p>
    );
  if (!state.items.length)
    return (
      <p role="status">
        {isOwn && (filters.ticId || filters.stage || filters.grade)
          ? "조건에 맞는 별이 없습니다."
          : isOwn
            ? "아직 제출한 별이 없습니다. 별지도에서 별을 골라 분석해 보세요."
            : "이 회원이 제출한 별이 없습니다."}
      </p>
    );

  return (
    <div className="my-list">
      <ul aria-label="별 목록">
        {state.items.map((star) => (
          <StarRow
            key={star.ticId}
            star={star}
            returnTo={returnTo}
            isOwn={isOwn}
          />
        ))}
      </ul>
      <More state={state} more={more} label="별" />
    </div>
  );
}

function StarRow({
  star,
  returnTo,
  isOwn,
}: {
  star: MyStar;
  returnTo: string;
  isOwn: boolean;
}) {
  return (
    <li className="my-list-row">
      <p className="my-list-title">TIC {star.ticId}</p>
      <dl>
        <dt>진행</dt>
        <dd>{STAGE[star.progressStage]}</dd>
        <dt>{isOwn ? "내 행성" : "발견한 행성"}</dt>
        <dd>
          {count.format(star.planetCount)}개
          {/* 「없다」와 「행성 없이 끝냈다」는 다른 말이다. */}
          {star.completedWithoutPlanets ? " · 행성 없이 탐색을 마쳤습니다" : ""}
        </dd>
        <dt>성과</dt>
        <dd>
          {count.format(star.achievementCount)}건
          {star.grade ? ` · 등급 ${star.grade}` : ""}
        </dd>
        {star.currentCurveStep !== null && (
          <>
            <dt>곡선 단계</dt>
            <dd>{count.format(star.currentCurveStep)}</dd>
          </>
        )}
        {/*
          없으면 이 줄 자체를 두지 않는다. 타인 조회에서는 서버가 필드를
          빼며, 0으로 적으면 「공개하지 않은 신호가 없다」는 사실이 되어
          「볼 수 없다」와 뒤섞인다(4.4).
        */}
        {star.unpublishedSignalCount !== null && (
          <>
            <dt>공개하지 않은 신호</dt>
            <dd>{count.format(star.unpublishedSignalCount)}개</dd>
          </>
        )}
        <dt>마지막 활동</dt>
        <dd>
          <time dateTime={star.lastActivityAt}>
            {when(star.lastActivityAt)}
          </time>
        </dd>
      </dl>
      {star.reopenPending && (
        <p role="status">새 자료가 있어 다시 열릴 예정입니다.</p>
      )}
      {/*
        **타인의 별에 분석 링크를 주지 않는다.** 그 사람이 발견한 별을 내가
        발견했다는 보장이 없고, `AnalysisService.openCurrentBundle`이 내가 열지
        않은 별을 403 `STAR_LOCKED`로 거절한다. 서버 권한을 우회하는 문제가
        아니라 **누르면 막히는 길을 먼저 내미는** 문제다. 대신 누구나 볼 수
        있는 읽기 경로로 잇는다.
      */}
      {isOwn ? (
        <>
          <Link to={pagePath("analysis", { ticId: star.ticId }, { returnTo })}>
            이 별 분석하기
          </Link>
          <Link
            to={pagePath("starResults", { ticId: star.ticId }, { returnTo })}
          >
            별 결과 보기
          </Link>
        </>
      ) : (
        <Link to={pagePath("starBoard", { ticId: star.ticId }, { returnTo })}>
          이 별 게시판 보기
        </Link>
      )}
    </li>
  );
}

export function More<T>({
  state,
  more,
  label,
}: {
  state: {
    nextCursor: string | null;
    loadingMore: boolean;
    moreError: string | null;
  };
  more: () => void;
  label: string;
}) {
  if (!state.nextCursor) return null;
  return (
    <p className="my-list-more">
      {state.moreError && <span role="alert">{state.moreError} </span>}
      <button type="button" onClick={more} disabled={state.loadingMore}>
        {state.loadingMore ? "불러오는 중입니다" : `${label} 더 보기`}
      </button>
    </p>
  );
}
