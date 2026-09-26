// Star info and actions beside the focused system. Vocabulary and links are
// StarDetail.tsx's; only the presentation is new.
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { ApiError } from "../../api";
import { pagePath } from "../../app/paths";
import { PlanetExplanationPanel } from "../../features/sky-renderer/PlanetExplanation";
import type { StarDetail } from "../../features/sky-renderer/detail";
import { usePanelCover } from "../ui/usePanelSize";
import { useShell } from "./context";
import { starSearch } from "./stage";

export const progressLabel = {
  unexplored: "미탐사",
  in_progress: "탐색 중",
  completed: "탐색 완료",
} as const;
const actionLabel = {
  start: "분석 시작",
  continue: "이어서 분석",
  review: "분석 다시 보기",
} as const;
const reasonLabel: Record<string, string> = {
  initial: "첫 방문",
  tutorial: "튜토리얼",
  achievement: "탐사 성과",
  challenge: "챌린지",
};
/** Only the number is set in Plex Mono (it has no Hangul); words stay Sans KR. */
const info = (value: number | null, unit = ""): ReactNode =>
  value === null ? (
    "정보 없음"
  ) : (
    <>
      <span className="cinema-num">{value}</span>
      {unit}
    </>
  );

export function StarPanel({
  ticId,
  planet,
  onPlanet,
  arriving = false,
}: {
  ticId: string;
  planet: string | null;
  onPlanet(candidateId: string | null): void;
  /** The camera is still on its way: the panel waits, then fades in. */
  arriving?: boolean;
}) {
  const { focus, closeStar, reportPanel } = useShell();
  const location = useLocation();
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const planetInfo = useRef<HTMLDivElement>(null);
  usePanelCover(panel, "right", (px) => reportPanel("right", px));
  const detail = focus.ticId === ticId ? focus.detail : null;
  const error = focus.ticId === ticId ? focus.error : null;
  const selected =
    detail?.system.items.find((item) => item.candidateId === planet) ?? null;
  // Back here with the member's search filters (StarDetail.tsx kept them).
  const returnTo = `/sky${starSearch(
    location.pathname === "/sky" ? location.search : "",
    ticId,
  )}`;

  // A new star: start at the top and put focus on its name.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || shown.current === detail.system.ticId) return;
    shown.current = detail.system.ticId;
    if (panel.current) panel.current.scrollTop = 0;
    if (!document.activeElement?.closest("dialog, .cinema-list-panel"))
      heading.current?.focus({ preventScroll: true });
  }, [detail]);
  useEffect(() => {
    if (!selected || !panel.current || !planetInfo.current) return;
    const box = panel.current.getBoundingClientRect(),
      part = planetInfo.current.getBoundingClientRect();
    panel.current.scrollTop += Math.max(0, part.bottom - box.bottom + 20);
  }, [selected]);

  return (
    <aside
      ref={panel}
      className={`cinema-star-panel${detail ? " is-ready" : ""}`}
      data-arriving={arriving ? "true" : "false"}
      aria-label="별 상세"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          closeStar();
        }
      }}
    >
      <div className="cinema-star-head">
        <button type="button" className="cinema-back" onClick={closeStar}>
          ← 나의 은하
        </button>
        <p className="cinema-eyebrow">내 별</p>
        <h2 ref={heading} tabIndex={-1}>
          TIC {ticId}
        </h2>
        {detail && (
          <p className="cinema-star-status">
            <span data-stage={detail.progress.stage}>
              {progressLabel[detail.progress.stage]}
            </span>
            {detail.progress.reopenPending ? " · 새 관측 자료 대기" : ""}
          </p>
        )}
      </div>
      {!detail && !error && (
        <p role="status" className="cinema-muted">
          별과 내 행성 정보를 불러오고 있습니다.
        </p>
      )}
      {error && (
        <div role="alert" className="cinema-alert">
          <p>
            {error instanceof ApiError && error.code === "STAR_LOCKED"
              ? "아직 발견하지 않은 별입니다. 먼저 튜토리얼과 탐사를 진행해 주세요."
              : error.message}
          </p>
          <button type="button" className="cinema-pill" onClick={focus.retry}>
            별 정보 다시 불러오기
          </button>
        </div>
      )}
      {detail && (
        <StarBody
          ticId={ticId}
          detail={detail}
          selected={selected}
          planet={planet}
          onPlanet={onPlanet}
          returnTo={returnTo}
          planetInfo={planetInfo}
          retry={focus.retry}
        />
      )}
    </aside>
  );
}

function StarBody({
  ticId,
  detail,
  selected,
  planet,
  onPlanet,
  returnTo,
  planetInfo,
  retry,
}: {
  ticId: string;
  detail: StarDetail;
  selected: StarDetail["system"]["items"][number] | null;
  planet: string | null;
  onPlanet(candidateId: string | null): void;
  returnTo: string;
  planetInfo: RefObject<HTMLDivElement | null>;
  retry(): void;
}) {
  const items = detail.system.items;
  return (
    <>
      <p className="cinema-star-summary">
        <strong>
          내 행성 <b className="cinema-num">{items.length}</b>개
        </strong>
        <span>
          인정된 성과 <b className="cinema-num">{detail.achievement.count}</b>건
          {detail.achievement.grade ? ` (${detail.achievement.grade})` : ""}
        </span>
      </p>
      <div className="cinema-star-actions">
        <Link
          className="cinema-primary"
          to={pagePath("analysis", { ticId }, { returnTo })}
        >
          {actionLabel[detail.actions.analysis]}
        </Link>
        {detail.actions.resultAvailable ? (
          <Link
            className="cinema-secondary"
            to={pagePath("starResults", { ticId }, { returnTo })}
          >
            분석 결과 보기
          </Link>
        ) : (
          <button
            type="button"
            className="cinema-secondary"
            disabled
            aria-describedby="cinema-result-locked"
          >
            분석 결과 보기
          </button>
        )}
        {detail.actions.boardOpen ? (
          <Link
            className="cinema-link"
            to={pagePath("starBoard", { ticId }, { returnTo })}
          >
            별 게시판 · 공식 신호 스레드 {detail.actions.threadCount}개
          </Link>
        ) : (
          <button type="button" className="cinema-link" disabled>
            별 게시판 잠김
          </button>
        )}
      </div>
      {!detail.actions.resultAvailable && (
        <p id="cinema-result-locked" className="cinema-muted">
          분석을 제출하면 결과를 볼 수 있습니다.
        </p>
      )}
      <section
        className="cinema-planets"
        aria-labelledby="cinema-planets-title"
      >
        <div className="cinema-planets-head">
          <h3 id="cinema-planets-title">내가 찾은 행성</h3>
          <button
            type="button"
            className="cinema-mini"
            aria-pressed={planet === null}
            onClick={() => onPlanet(null)}
          >
            항성계
          </button>
        </div>
        {!items.length ? (
          <p className="cinema-muted">아직 찾은 행성이 없습니다.</p>
        ) : (
          <ul className="cinema-planet-list" aria-label="내 행성 목록">
            {items.map((item, index) => (
              <li key={item.candidateId}>
                <button
                  type="button"
                  aria-label={`행성 ${index + 1} ${item.candidateId}`}
                  aria-pressed={selected?.candidateId === item.candidateId}
                  onClick={() => onPlanet(item.candidateId)}
                >
                  <i
                    className="cinema-orbit-glyph"
                    data-kind={item.kind}
                    aria-hidden="true"
                  />
                  <span>행성 {index + 1}</span>
                  <small>
                    {item.kind === "confirmed" ? "확인된 행성" : "후보"}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
        {detail.completedWithoutPlanets && (
          <p className="cinema-muted">
            이 별의 탐색을 마쳤습니다. 실제 행성이 없다는 뜻은 아닙니다.
          </p>
        )}
        {selected && (
          <div
            ref={planetInfo}
            className="cinema-planet-info"
            aria-live="polite"
          >
            <h3>{selected.candidateId}</h3>
            <p className="cinema-muted">
              {selected.kind === "confirmed"
                ? "확인된 행성"
                : "아직 확인되지 않은 후보"}
            </p>
            <dl className="cinema-facts">
              <dt>반복 주기</dt>
              <dd>{info(selected.periodDays, "일")}</dd>
              <dt>어두워진 정도</dt>
              <dd>
                {selected.depthPpm === null ? (
                  "정보 없음"
                ) : (
                  <span className="cinema-num">
                    {selected.depthPpm} ppm ({selected.depthPpm / 10000}%)
                  </span>
                )}
              </dd>
            </dl>
            {selected.kind === "confirmed" ? (
              <div className="cinema-explanation">
                <PlanetExplanationPanel
                  key={`${ticId}:${detail.system.version}:${selected.candidateId}`}
                  detail={detail}
                  candidateId={selected.candidateId}
                  refreshDetail={retry}
                />
              </div>
            ) : (
              <p className="cinema-muted">
                아직 확인되지 않은 후보에는 NASA 확정 행성 설명이 없습니다.
              </p>
            )}
          </div>
        )}
        <p className="cinema-caption">
          표면과 궤도는 이해를 돕기 위한 시각화입니다.
        </p>
      </section>
      <details className="cinema-observations">
        <summary>관측·발견 정보</summary>
        <dl className="cinema-facts">
          <dt>관측 회차</dt>
          <dd>
            {detail.star.sectorCount}회 ·{" "}
            {detail.star.sectors.map((s) => `Sector ${s}`).join(", ") ||
              "정보 없음"}
          </dd>
          <dt>밝기 (TESS 등급)</dt>
          <dd>{info(detail.star.tmag)}</dd>
          <dt>유효 온도</dt>
          <dd>{info(detail.star.teffK, " K")}</dd>
          <dt>반지름 (태양=1)</dt>
          <dd>{info(detail.star.radiusRsun)}</dd>
          <dt>발견 계기</dt>
          <dd>{reasonLabel[detail.unlock.reason] ?? detail.unlock.reason}</dd>
          <dt>발견 시각</dt>
          <dd>
            {Number.isFinite(Date.parse(detail.unlock.unlockedAt))
              ? new Date(detail.unlock.unlockedAt).toLocaleString("ko-KR")
              : "정보 없음"}
          </dd>
          <dt>현재 곡선 단계</dt>
          <dd>{info(detail.progress.currentCurveStep)}</dd>
        </dl>
      </details>
    </>
  );
}
