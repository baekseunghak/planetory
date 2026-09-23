import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePageContext } from "../../app/usePageContext.ts";
import { pagePath } from "../../app/paths.ts";
import { HistoryCurveChart } from "../analysis/HistoryCurveChart.tsx";
import { wrapPhaseWindow } from "../analysis/history-graph.ts";
import type { HistoryDetail } from "../analysis/history-data.ts";
import { FallbackNote } from "./fallback-note.tsx";
import { useHistoryDetail } from "./use-history-detail.ts";
import "./history-detail.css";

// #190 개인 기록 상세. **불변과 현재를 가른다** — 한 덩어리로 붙이면
// 「그때 이랬다」와 「지금 이렇다」를 구분할 수 없다. 어느 값이 어느
// 묶음인지는 docs/analysis-history.md.

const decimal = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 6 });
const count = new Intl.NumberFormat("ko-KR");
const when = (value: string) => new Date(value).toLocaleString("ko-KR");

const MATCH: Record<string, string> = {
  matched: "고른 주기가 신호와 맞았습니다.",
  matched_harmonic: "고른 주기의 배수가 신호와 맞았습니다.",
  duplicate: "이미 찾은 신호였습니다.",
  not_matched: "맞는 신호를 찾지 못했습니다.",
  ambiguous_match: "어느 신호인지 가리지 못했습니다.",
  none_wrong: "더 이상 없음으로 접수했습니다.",
  skipped: "이 별을 건너뛰었습니다.",
};
const EVALUATION: Record<string, string> = {
  AGREES: "판단이 맞았습니다.",
  DISAGREES: "판단이 달랐습니다.",
  UNSURE: "모르겠음으로 제출해 맞고 틀림을 매기지 않았습니다.",
  UNSCORED: "아직 확정되지 않은 신호라 채점하지 않습니다.",
  NOT_APPLICABLE: "채점 대상이 아닙니다.",
};
const ACHIEVEMENT: Record<string, string> = {
  recognized: "성과로 인정되었습니다.",
  pending_publish: "공개하면 성과 판정을 받습니다.",
  judgment_mismatch: "판단이 달라 성과로 인정되지 않았습니다.",
  already_recognized: "이미 인정된 신호라 다시 인정되지 않았습니다.",
  none: "성과 판정이 없습니다.",
};
const PUBLICATION: Record<string, string> = {
  PUBLISHED: "공개되어 있습니다.",
  HIDDEN: "운영이 숨긴 상태입니다.",
  UNPUBLISHED: "공개할 수 있습니다.",
  NOT_ELIGIBLE: "공개 대상이 아닙니다.",
};

/**
 * 돌아갈 곳의 이름. **주소에서 읽는다** — 기록으로 들어오는 길이 분석·마이
 * 페이지·지도·게시글로 여럿이라, 어디서 왔든 「분석으로」라고 적으면 거짓이
 * 된다. 모르는 곳이면 목적지를 지어내지 않고 그냥 돌아간다고만 말한다.
 */
function backLabel(returnTo: string) {
  if (returnTo.startsWith("/analysis/")) return "분석으로 돌아가기";
  if (returnTo === "/me" || returnTo.startsWith("/me?"))
    return "마이페이지로 돌아가기";
  if (returnTo.startsWith("/sky")) return "별지도로 돌아가기";
  if (returnTo.startsWith("/posts/") || returnTo.startsWith("/comments/"))
    return "글로 돌아가기";
  return "돌아가기";
}

function Pair({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** 제출 당시 값. **다시 계산하지 않는다.** */
function Submitted({ detail }: { detail: HistoryDetail }) {
  const { explanation, snapshotParams } = detail;
  const submitted = explanation.submitted;
  return (
    <section className="history-band">
      <h3>그때 낸 것</h3>
      <p>{MATCH[detail.matchStatus]}</p>
      <dl>
        {submitted?.periodDays != null && (
          <Pair term="고른 주기">{decimal.format(submitted.periodDays)}일</Pair>
        )}
        {submitted?.phaseStart != null && submitted.phaseEnd != null && (
          <Pair term="고른 위상 구간">
            {decimal.format(submitted.phaseStart)} ~{" "}
            {decimal.format(submitted.phaseEnd)}
          </Pair>
        )}
        {explanation.correction && (
          <Pair term="배수 정정">
            ×{decimal.format(explanation.correction.multiplier)} ={" "}
            {decimal.format(explanation.correction.correctedPeriodDays)}일
          </Pair>
        )}
        {explanation.serverDerived?.epochBtjd != null && (
          <Pair term="기준 시각">
            {decimal.format(explanation.serverDerived.epochBtjd)} BTJD
          </Pair>
        )}
        {explanation.serverDerived?.durationHours != null && (
          <Pair term="가려진 시간">
            {decimal.format(explanation.serverDerived.durationHours)}시간
          </Pair>
        )}
        {snapshotParams.foldReferenceTimeBtjd != null && (
          <Pair term="당시 접기 기준">
            {decimal.format(snapshotParams.foldReferenceTimeBtjd)} BTJD
          </Pair>
        )}
      </dl>
      {explanation.evaluation && <p>{EVALUATION[explanation.evaluation]}</p>}
      {/* 당시 성과 판정이다. 지금 몇 건인지는 옆 묶음이 말한다. */}
      <p>{ACHIEVEMENT[explanation.achievement.result]}</p>
    </section>
  );
}

/** 조회 시점 값. 당시 값이 아니다. */
function Now({ detail }: { detail: HistoryDetail }) {
  const { explanation, progress } = detail;
  return (
    <section className="history-band">
      <h3>지금</h3>
      <p>{PUBLICATION[explanation.publication.state]}</p>
      {explanation.achievement.star.count > 0 && (
        <p>
          이 별 성과 {count.format(explanation.achievement.star.count)}건
          {explanation.achievement.star.grade
            ? ` · 등급 ${explanation.achievement.star.grade}`
            : ""}
        </p>
      )}
      <p>
        {progress.stage === "completed"
          ? "이 별의 탐색을 마쳤습니다."
          : `남은 탐색 가능 신호 ${count.format(progress.remainingDiscoverableCount)}개`}
      </p>
      {detail.relabel && (
        <p className="history-relabel">
          {when(detail.relabel.relabeledAt)}에 외부 라벨이{" "}
          {detail.relabel.newDisposition}로 바뀌었습니다. 당시 판정과 성과는
          그대로입니다.
        </p>
      )}
      {detail.isPreviousBundle && (
        <p className="submission-note">
          이 기록은 지금 판이 아닌 자료 판에서 낸 것입니다.
        </p>
      )}
    </section>
  );
}

export function HistoryDetailPage() {
  // 왕복 문맥은 공용 규약을 그대로 쓴다(W03). 기록으로 들어오는 길이
  // 분석·지도·게시글 셋이라 화면마다 돌아갈 곳이 다르고, 그 값을 주소가
  // 들고 온다. **여기서 목적지를 지어내지 않는다.**
  const { historyId = "", returnTo } = usePageContext();
  // 기록이 바뀌면 모드·없음 관찰·진행 중 요청을 함께 새로 시작한다.
  return (
    <HistoryDetail key={historyId} historyId={historyId} returnTo={returnTo} />
  );
}

function HistoryDetail({
  historyId,
  returnTo,
}: {
  historyId: string;
  returnTo: string;
}) {
  const {
    detail,
    graph,
    mode,
    setMode,
    retryGraph,
    retryDetail,
    snapshotMissing,
  } = useHistoryDetail(historyId);
  const { currentPath } = usePageContext();

  return (
    <main className="page history-detail">
      <h2>분석 기록 상세</h2>
      <p className="history-id">분석 기록 {historyId}</p>
      {detail.phase === "loading" && <p role="status">불러오는 중입니다.</p>}
      {(detail.phase === "denied" ||
        detail.phase === "error" ||
        detail.phase === "unreadable") && (
        <>
          <p role="alert">{detail.message}</p>
          {detail.phase === "error" && (
            <button type="button" onClick={retryDetail}>
              기록 다시 불러오기
            </button>
          )}
        </>
      )}

      {detail.phase === "ready" && (
        <>
          {(detail.detail.explanation.publication.state !== "NOT_ELIGIBLE" ||
            detail.detail.explanation.publication.publicAnalysisId) && (
            <Link
              to={pagePath(
                "publication",
                { historyId },
                { ticId: detail.detail.ticId, returnTo: currentPath },
              )}
            >
              공개 검토·설정
            </Link>
          )}
          <Link
            to={
              pagePath(
                "analysis",
                { ticId: detail.detail.ticId },
                { returnTo: currentPath },
              ) +
              `&retryOfSubmissionId=${encodeURIComponent(detail.detail.submissionId)}`
            }
          >
            다시 풀기
          </Link>
          <dl className="history-receipt">
            <Pair term="기록 번호">{detail.detail.historyId}</Pair>
            <Pair term="별">TIC {detail.detail.ticId}</Pair>
            <Pair term="제출 시각">
              <time dateTime={detail.detail.submittedAt}>
                {when(detail.detail.submittedAt)}
              </time>
            </Pair>
            <Pair term="곡선 단계">{detail.detail.curveContext.curveStep}</Pair>
          </dl>

          <section className="history-graph-band">
            <div
              className="history-modes"
              role="group"
              aria-label="그래프 기준"
            >
              {/*
                두 모드는 같은 그래프의 다른 기준이다. 당시는 저장된 배열이고
                현재는 지금 판으로 다시 접은 곡선이다.
              */}
              <button
                type="button"
                aria-pressed={mode === "CURRENT"}
                onClick={() => setMode("CURRENT")}
              >
                현재 판 기준
              </button>
              <button
                type="button"
                aria-pressed={mode === "SUBMITTED"}
                disabled={snapshotMissing}
                aria-describedby={
                  snapshotMissing ? "history-snapshot-missing" : undefined
                }
                onClick={() => setMode("SUBMITTED")}
              >
                제출 당시 기준
              </button>
            </div>
            {snapshotMissing && (
              <p id="history-snapshot-missing">
                제출 당시 스냅샷이 없어 당시 보기를 사용할 수 없습니다.
              </p>
            )}
            {graph.phase === "loading" && (
              <p role="status">그래프를 불러오는 중입니다.</p>
            )}
            {graph.phase === "error" && <p role="alert">{graph.message}</p>}
            {graph.phase === "retryable" && (
              <p role="alert">
                {graph.message}{" "}
                <button type="button" onClick={retryGraph}>
                  다시 시도
                </button>
              </p>
            )}
            {graph.phase === "ready" && (
              <>
                <HistoryCurveChart
                  view={graph.view}
                  windows={
                    // 당시 창은 상세의 원본에서, 현재 창은 그래프에서 온다.
                    mode === "SUBMITTED"
                      ? wrapPhaseWindow(
                          detail.detail.explanation.submitted?.phaseStart ??
                            null,
                          detail.detail.explanation.submitted?.phaseEnd ?? null,
                        )
                      : wrapPhaseWindow(
                          graph.view.selection.currentPhaseStart,
                          graph.view.selection.currentPhaseEnd,
                        )
                  }
                />
                {/*
                  같은 값이 모드마다 다른 뜻이다. 한 문구로 뭉치면 거짓이 된다.
                */}
                <FallbackNote
                  reason={graph.view.reproduction.fallbackReason}
                  mode={mode}
                  hasSnapshot={graph.view.dto.snapshot !== null}
                />
              </>
            )}
          </section>

          <div className="history-bands">
            <Submitted detail={detail.detail} />
            <Now detail={detail.detail} />
          </div>

          <section className="history-band">
            <h3>보관 정보</h3>
            <dl>
              <Pair term="자료 판">
                {detail.detail.versions.data ?? "없음"}
              </Pair>
              <Pair term="규칙">{detail.detail.versions.rule ?? "없음"}</Pair>
              <Pair term="스냅샷 계산">
                {/* 없다고 최신으로 추정하지 않는다. */}
                {detail.detail.versions.snapshot ?? "기록 없음"}
              </Pair>
            </dl>
          </section>
        </>
      )}

      {/*
        돌아갈 곳은 주소가 들고 온다. 기록으로 들어오는 길이 분석·지도·
        게시글 셋이라 화면이 목적지를 정할 수 없다. 읽을 수 없는 기록에도
        남겨 둔다 — 막다른 길에서 나갈 수 있어야 한다.
      */}
      <p className="history-back">
        <Link to={returnTo}>{backLabel(returnTo)}</Link>
      </p>
    </main>
  );
}
