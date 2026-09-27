// `/history/:historyId` in the cinema app: the same record (API 8.2/8.3,
// features/history/use-history-detail.ts), still split into what was sent
// then and what holds now, in the cinema's words. The signal is named as the
// star panel names it; ids, versions and BTJD sit under 기술 정보.
// HistoryDetailPage hands over here only when the cinema app provides the copy.
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { pagePath } from "../../../app/paths";
import { usePageContext } from "../../../app/usePageContext";
import { HistoryCurveChart } from "../../../features/analysis/HistoryCurveChart";
import type { HistoryDetail } from "../../../features/analysis/history-data";
import { wrapPhaseWindow } from "../../../features/analysis/history-graph";
import { useHistoryDetail } from "../../../features/history/use-history-detail";
import { useCinemaSky } from "../../shell/sky";
import { useStarDetail } from "../../shell/star-detail";
import * as f from "../format";
import { classification, Row } from "./AcceptedResult";
import { matchedSignalLabel } from "./labels";
import "./results.css";

/** Where "back" goes, read from the address (never invented). */
function backLabel(returnTo: string) {
  if (returnTo.startsWith("/analysis/")) return "분석으로 돌아가기";
  if (returnTo === "/me" || returnTo.startsWith("/me?"))
    return "마이페이지로 돌아가기";
  if (returnTo.startsWith("/sky")) return "나의 은하로 돌아가기";
  if (returnTo.startsWith("/results/")) return "분석 결과로 돌아가기";
  if (returnTo.startsWith("/posts/") || returnTo.startsWith("/comments/"))
    return "글로 돌아가기";
  return "돌아가기";
}

/** The graph's fallback reasons, in plain words (fallback-note.tsx rules). */
function fallbackText(
  reason: string | null,
  mode: "CURRENT" | "SUBMITTED",
  hasSnapshot: boolean,
): string | null {
  if (!reason) return null;
  if (mode === "SUBMITTED") {
    if (reason !== "RETIRED_CANDIDATE") return null;
    return hasSnapshot
      ? "지금 자료로는 그때의 곡선을 똑같이 만들 수 없습니다. 아래 그래프는 제출할 때 그대로입니다."
      : "지금 자료로는 그때의 곡선을 똑같이 만들 수 없습니다.";
  }
  if (reason === "RETIRED_CANDIDATE")
    return "그때 뺀 신호 가운데 지금은 쓰지 않는 신호가 있어 원본 곡선으로 보여 드립니다.";
  return "지금 자료로 다시 그릴 수 있는지 확인하지 못했습니다.";
}

function Sent({
  detail,
  signalLabel,
}: {
  detail: HistoryDetail;
  signalLabel: string | null;
}) {
  const { explanation } = detail;
  const { submitted, serverDerived, correction, evaluation, achievement } =
    explanation;
  return (
    <section className="history-band">
      <h3>그때 낸 것</h3>
      <p>
        {f.matchSentence(
          detail.matchStatus,
          correction?.multiplier,
          explanation.missHint,
        )}
        {signalLabel ? ` (${signalLabel})` : ""}
      </p>
      <dl>
        {submitted?.periodDays != null && (
          <>
            <dt>고른 주기</dt>
            <dd>{f.periodDays(submitted.periodDays, 3)}</dd>
          </>
        )}
        {submitted?.phaseStart != null && submitted.phaseEnd != null && (
          <>
            <dt>고른 구간</dt>
            <dd>
              위상 {f.phaseRange(submitted.phaseStart, submitted.phaseEnd)}
            </dd>
          </>
        )}
        {correction && (
          <>
            <dt>배수 정정</dt>
            <dd>
              × {String(Number(correction.multiplier.toFixed(2)))} ={" "}
              {f.periodDays(correction.correctedPeriodDays, 3)}
            </dd>
          </>
        )}
        {serverDerived?.durationHours != null && (
          <>
            <dt>가려진 시간</dt>
            <dd>{f.hours(serverDerived.durationHours)}</dd>
          </>
        )}
      </dl>
      {evaluation && f.EVALUATION[evaluation] && (
        <p>{f.EVALUATION[evaluation]}</p>
      )}
      {f.ACHIEVEMENT[achievement.result] && (
        <p>{f.ACHIEVEMENT[achievement.result]}</p>
      )}
    </section>
  );
}

function Now({ detail }: { detail: HistoryDetail }) {
  const { explanation, progress } = detail;
  return (
    <section className="history-band">
      <h3>지금</h3>
      {/* A known signal is never published; nothing to say then. */}
      {explanation.publication.state !== "NOT_ELIGIBLE" && (
        <p>{f.PUBLICATION[explanation.publication.state]}</p>
      )}
      {explanation.achievement.star.count > 0 && (
        <p>
          이 별의 성과 {f.count(explanation.achievement.star.count)}건
          {explanation.achievement.star.grade
            ? ` · 등급 ${explanation.achievement.star.grade}`
            : ""}
        </p>
      )}
      <p>
        {progress.stage === "completed"
          ? "이 별은 탐사 완료입니다."
          : `이 별은 탐사 중입니다. 찾을 수 있는 신호 ${f.count(progress.remainingDiscoverableCount)}개가 남았습니다.`}
      </p>
      {detail.relabel && (
        <p className="history-relabel">
          {f.when(detail.relabel.relabeledAt)}에 분류가{" "}
          {f.dispositionLabel(detail.relabel.newDisposition)}(으)로
          바뀌었습니다. 그때의 판정과 성과는 그대로입니다.
        </p>
      )}
      {detail.isPreviousBundle && (
        <p className="submission-note">
          이 기록은 지금과 다른 자료로 낸 것입니다.
        </p>
      )}
    </section>
  );
}

export function CinemaHistoryDetail({
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
  const ready = detail.phase === "ready" ? detail.detail : null;
  // The member's planets on this star, for "행성 N".
  const sky = useCinemaSky();
  const focus = useStarDetail(sky, ready?.ticId ?? null);
  const planetIds = useMemo(
    () =>
      focus.detail && focus.ticId === ready?.ticId
        ? focus.detail.system.items.map((item) => item.candidateId)
        : null,
    [focus.detail, focus.ticId, ready?.ticId],
  );
  const signal = ready?.explanation.signal ?? null;
  const signalLabel =
    ready && signal
      ? matchedSignalLabel({
          signal,
          planet: planetIds
            ? planetIds.includes(signal.candidateId)
            : signal.disposition === "CONFIRMED",
          planetIds,
          matchedIds: ready.progress.matchedCandidateIds,
        })
      : null;
  // The same name without the period, where the numbers follow anyway.
  const signalName =
    ready && signal
      ? matchedSignalLabel({
          signal,
          planet: planetIds
            ? planetIds.includes(signal.candidateId)
            : signal.disposition === "CONFIRMED",
          planetIds,
          matchedIds: ready.progress.matchedCandidateIds,
          withPeriodDays: false,
        })
      : null;

  return (
    <main className="page history-detail pc-result-page">
      <h2>분석 기록 상세</h2>
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

      {ready && (
        <>
          {(ready.explanation.publication.state !== "NOT_ELIGIBLE" ||
            ready.explanation.publication.publicAnalysisId) && (
            <Link
              to={pagePath(
                "publication",
                { historyId },
                { ticId: ready.ticId, returnTo: currentPath },
              )}
            >
              공개 검토
            </Link>
          )}
          <Link
            to={
              pagePath(
                "analysis",
                { ticId: ready.ticId },
                { returnTo: currentPath },
              ) +
              `&retryOfSubmissionId=${encodeURIComponent(ready.submissionId)}`
            }
          >
            다시 분석
          </Link>
          <Link
            to={pagePath(
              "starResults",
              { ticId: ready.ticId },
              { returnTo: currentPath },
            )}
          >
            분석 결과 보기
          </Link>
          <dl className="history-receipt">
            <div>
              <dt>별</dt>
              <dd>TIC {ready.ticId}</dd>
            </div>
            <div>
              <dt>제출</dt>
              <dd>
                <time dateTime={ready.submittedAt}>
                  {f.when(ready.submittedAt)}
                </time>
              </dd>
            </div>
            <div>
              <dt>곡선</dt>
              <dd>{f.curveStepName(ready.curveContext.curveStep)}</dd>
            </div>
            {signalLabel && (
              <div>
                <dt>찾은 신호</dt>
                <dd>{signalLabel}</dd>
              </div>
            )}
          </dl>

          <section className="history-graph-band">
            <div
              className="history-modes"
              role="group"
              aria-label="그래프 기준"
            >
              <button
                type="button"
                aria-pressed={mode === "CURRENT"}
                onClick={() => setMode("CURRENT")}
              >
                지금 자료로 보기
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
                제출할 때 자료로 보기
              </button>
            </div>
            {snapshotMissing && (
              <p id="history-snapshot-missing">
                제출할 때의 그래프가 저장되지 않아 그때 보기를 쓸 수 없습니다.
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
                  caption={
                    mode === "SUBMITTED"
                      ? "제출할 때의 접힌 곡선"
                      : "지금 자료로 다시 접은 곡선"
                  }
                  windows={
                    mode === "SUBMITTED"
                      ? wrapPhaseWindow(
                          ready.explanation.submitted?.phaseStart ?? null,
                          ready.explanation.submitted?.phaseEnd ?? null,
                        )
                      : wrapPhaseWindow(
                          graph.view.selection.currentPhaseStart,
                          graph.view.selection.currentPhaseEnd,
                        )
                  }
                />
                {fallbackText(
                  graph.view.reproduction.fallbackReason,
                  mode,
                  graph.view.dto.snapshot !== null,
                ) && (
                  <p className="submission-note">
                    {fallbackText(
                      graph.view.reproduction.fallbackReason,
                      mode,
                      graph.view.dto.snapshot !== null,
                    )}
                  </p>
                )}
              </>
            )}
          </section>

          <div className="history-bands">
            <Sent detail={ready} signalLabel={signalName} />
            <Now detail={ready} />
          </div>

          {signal && (
            <section className="history-band">
              <h3>찾은 신호</h3>
              <p>{signalName}</p>
              <p>{classification(signal)}</p>
              <p>
                주기 {f.periodDays(signal.bls.periodDays, 3)} · 가려진 시간{" "}
                {f.hours(signal.bls.durationHours)} · 깊이{" "}
                {f.depthPercent(signal.bls.depthPpm)}
              </p>
              {f.aiLine(signal.ai) && (
                <p>
                  AI 판정: {f.aiLine(signal.ai)} · 성과 판정에는 쓰이지
                  않습니다.
                </p>
              )}
            </section>
          )}

          <details className="pc-result-tech history-band">
            <summary>기술 정보</summary>
            <dl>
              <Row term="기록 번호">{ready.historyId}</Row>
              <Row term="접수 번호">{ready.submissionId}</Row>
              {signal && <Row term="신호 번호">{signal.candidateId}</Row>}
              {ready.explanation.serverDerived?.epochBtjd != null && (
                <Row term="기준 시각">
                  {f.referenceTime(ready.explanation.serverDerived.epochBtjd)}
                </Row>
              )}
              {ready.snapshotParams.foldReferenceTimeBtjd != null && (
                <Row term="그때 접기 기준 시각">
                  {f.referenceTime(ready.snapshotParams.foldReferenceTimeBtjd)}
                </Row>
              )}
              <Row term="자료 판">{ready.versions.data ?? "없음"}</Row>
              <Row term="판정 규칙">{ready.versions.rule ?? "없음"}</Row>
              <Row term="그래프 계산">
                {ready.versions.snapshot ?? "기록 없음"}
              </Row>
            </dl>
          </details>
        </>
      )}

      {/* Back where the address says; also from a record that cannot be read. */}
      <p className="history-back">
        <Link to={returnTo}>{backLabel(returnTo)}</Link>
      </p>
    </main>
  );
}
