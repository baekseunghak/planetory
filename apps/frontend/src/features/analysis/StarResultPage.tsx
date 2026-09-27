import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ApiError, http } from "../../api";
import { pagePath } from "../../app/paths";
import { usePageContext } from "../../app/usePageContext";
import { Ai, Statistics } from "./AnalysisResult";
import { SubmissionHistoryButton } from "./SubmissionHistoryButton";
import { useCinemaCopy } from "./cinema-copy";
import { readStarResult, starResultPath, type StarResult } from "./star-result";
import "./star-result.css";
import type { ResidualStatus } from "./residual-job";
import type { Disposition } from "./submission-result";

const dispositionLabels: Record<Disposition, string> = {
  CONFIRMED: "확정 행성",
  UNCONFIRMED: "미확정",
  FP: "거짓 양성",
};

type State =
  | { phase: "loading" }
  | { phase: "ready"; value: StarResult }
  | { phase: "error"; message: string; retryable: boolean };
const evaluation: Record<string, string> = {
  AGREES: "판단이 맞았습니다",
  DISAGREES: "판단이 달랐습니다",
  UNSURE: "모르겠음으로 제출했습니다",
  UNSCORED: "미확정 신호로 채점하지 않습니다",
  NOT_APPLICABLE: "채점 대상이 아닙니다",
};
const recognition: Record<string, string> = {
  recognized: "성과 인정",
  already_recognized: "이미 인정된 성과",
  pending_publish: "공개 후 성과 판정",
  judgment_mismatch: "판단이 달라 성과 미인정",
  none: "성과 판정 없음",
};
const publication: Record<string, string> = {
  UNPUBLISHED: "미게시",
  PUBLISHED: "게시됨",
  HIDDEN: "운영에 의해 숨겨짐",
  NOT_ELIGIBLE: "게시 대상 아님",
};
const residual: Record<ResidualStatus, string> = {
  COMPLETED: "계산 완료",
  QUEUED: "계산 대기",
  RESIDUAL_CALCULATING: "잔차 계산 중",
  RESIDUAL_READY: "잔차 준비됨 · 주기도 계산 대기",
  PERIODOGRAM_CALCULATING: "주기도 계산 중",
  FAILED: "계산 실패",
};
const judgment: Record<string, string> = {
  LIKELY_PLANET: "행성 같음",
  UNLIKELY_PLANET: "아닌 것 같음",
  UNSURE: "모르겠음",
};
const match: Record<string, string> = {
  not_matched: "일치 신호 없음",
  ambiguous_match: "신호 구분 불가",
  none_wrong: "더 이상 없음 제출",
  skipped: "건너뜀",
};

export function StarResultPage() {
  const { ticId = "", currentPath, returnTo } = usePageContext();
  const location = useLocation();
  // 시네마 앱은 같은 응답을 자기 말로 보여 준다. develop 화면은 그대로다.
  const Entry = useCinemaCopy()?.StarResult ?? StarResultEntry;
  // 같은 TIC의 공개 검토에서 돌아와도 재조회하고 이전 응답을 남기지 않는다.
  return (
    <Entry
      key={`${ticId}:${location.key}`}
      ticId={ticId}
      from={currentPath}
      returnTo={returnTo}
    />
  );
}

function StarResultEntry({
  ticId,
  from,
  returnTo,
}: {
  ticId: string;
  from: string;
  returnTo: string;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });
    void http
      .request<unknown>(starResultPath(ticId), { signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted)
          setState({ phase: "ready", value: readStarResult(body, ticId) });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const unavailable =
          error instanceof ApiError && [403, 404].includes(error.status);
        setState({
          phase: "error",
          retryable: !unavailable,
          message: unavailable
            ? "볼 수 있는 별 결과가 없습니다."
            : "별 결과를 불러오지 못했습니다. 다시 시도해 주세요.",
        });
      });
    return () => controller.abort();
  }, [ticId, attempt]);
  const context = { ticId, returnTo: from };
  // 별지도는 TIC 선택을 `star` 쿼리로 복원한다. 기존 지도 필터도 보존한다.
  const skyPath = (id: string) => {
    const target = new URL(returnTo, "https://planetory.invalid");
    const params =
      target.pathname === "/sky" ? target.searchParams : new URLSearchParams();
    params.set("star", id);
    return `/sky?${params}`;
  };
  const historyLink = (id: string) =>
    pagePath("historyDetail", { historyId: id }, context);
  const retryLink = (id: string) =>
    pagePath("analysis", { ticId }, { returnTo: from }) +
    `&retryOfSubmissionId=${encodeURIComponent(id)}`;
  const result = state.phase === "ready" ? state.value : null;
  return (
    <article className="star-result">
      <h1>TIC {ticId} 별 결과</h1>
      <nav aria-label="결과 화면 이동">
        <Link to={returnTo}>돌아가기</Link>
        <Link to={skyPath(ticId)}>별지도로</Link>
      </nav>
      {state.phase === "loading" && (
        <p role="status">별 결과를 불러오는 중입니다.</p>
      )}
      {state.phase === "error" && (
        <>
          <p role="alert">{state.message}</p>
          {state.retryable && (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              결과 다시 불러오기
            </button>
          )}
        </>
      )}
      {result && (
        <>
          <section aria-labelledby="star-summary">
            <h2 id="star-summary">탐색 요약</h2>
            <p>
              {result.progress.stage === "completed"
                ? "탐색 완료"
                : result.progress.stage === "in_progress"
                  ? "탐색 진행 중"
                  : "탐색 전"}
              {result.unpublishedSignalCount > 0 &&
                ` · 미게시 분석 있음 (${result.unpublishedSignalCount}개 신호)`}
            </p>
            {result.progress.completionReason && (
              <p>
                {
                  {
                    all_found: "찾을 수 있는 신호를 모두 찾았습니다.",
                    undiscoverable_only:
                      "남은 신호는 이 자료에서 찾을 수 없어 탐색을 마쳤습니다.",
                    skipped: "건너뛰어 탐색을 마쳤습니다.",
                  }[result.progress.completionReason]
                }
              </p>
            )}
            {result.progress.reopenPending && (
              <p>새 데이터로 다시 탐색할 수 있습니다.</p>
            )}
            <dl>
              <dt>매칭한 신호</dt>
              <dd>{result.signals.length}개</dd>
              <dt>제출 기록</dt>
              <dd>{result.submissionCount}건</dd>
              <dt>인정 성과</dt>
              <dd>
                {result.achievement.count}개 · 등급{" "}
                {result.achievement.grade ?? "없음"}
              </dd>
              <dt>성과 분류</dt>
              <dd>
                확정 {result.achievement.byType.confirmed} · 미확정{" "}
                {result.achievement.byType.unconfirmed} · 거짓 양성{" "}
                {result.achievement.byType.fp}
              </dd>
              <dt>관측</dt>
              <dd>
                {result.star.sectorCount}개 섹터 · Tmag{" "}
                {result.star.tmag ?? "정보 없음"}
              </dd>
              <dt>현재 데이터</dt>
              <dd>{result.bundle?.bundleId ?? "현재 데이터 없음"}</dd>
            </dl>
            <nav aria-label="별 결과 다음 행동">
              {result.bundle && (
                <Link to={pagePath("analysis", { ticId }, { returnTo: from })}>
                  분석 계속
                </Link>
              )}
              {result.nextActions.includes("PUBLISH_ALL") && (
                <Link to={pagePath("publicationBatch", {}, context)}>
                  모두 게시 검토
                </Link>
              )}
              {result.nextActions.includes("LATER") && (
                <Link to={skyPath(ticId)}>나중에 게시하기</Link>
              )}
              {result.links.boardOpen && (
                <Link to={pagePath("starBoard", { ticId }, context)}>
                  별 게시판
                </Link>
              )}
            </nav>
          </section>
          <section aria-labelledby="signal-list">
            <h2 id="signal-list">매칭한 신호</h2>
            {!result.signals.length && (
              <p>
                아직 매칭한 신호가 없습니다. 제출 기록은 아래에서 확인할 수
                있습니다.
              </p>
            )}
            {result.signals.map((signal) => (
              <section
                className="star-result-card"
                key={signal.candidateId}
                aria-label={`신호 ${signal.candidateId}`}
              >
                <h3>신호 {signal.candidateId}</h3>
                <p>
                  {dispositionLabels[signal.disposition]}
                  {signal.status === "retired" && " · 은퇴한 신호"} ·{" "}
                  {publication[signal.publication.state]}
                </p>
                <p>
                  당시 판단:{" "}
                  {signal.userJudgment
                    ? judgment[signal.userJudgment]
                    : "기록 없음"}{" "}
                  ·{" "}
                  {signal.judgmentEvaluation
                    ? evaluation[signal.judgmentEvaluation]
                    : "당시 채점 정보 없음"}
                </p>
                <p>
                  {recognition[signal.achievement.result]}
                  {signal.achievement.recognizedAt &&
                    ` · ${new Date(signal.achievement.recognizedAt).toLocaleString("ko-KR")}`}
                </p>
                {signal.relabel && (
                  <p>
                    분류 변경:{" "}
                    {dispositionLabels[signal.relabel.newDisposition]} ·{" "}
                    {new Date(signal.relabel.relabeledAt).toLocaleString(
                      "ko-KR",
                    )}
                    . 당시 판단을 다시 채점한 값이 아닙니다.
                  </p>
                )}
                <Ai signal={signal} heading="h4" />
                {signal.statistics && (
                  <Statistics value={signal.statistics} heading="h4" />
                )}
                <p>
                  첫 매칭 단계: {signal.curveStepAtMatch ?? "정보 없음"} · 제출{" "}
                  {signal.submissionIds.length}건
                </p>
                <details>
                  <summary>
                    제출 기록 {signal.submissionIds.length}건 확인
                  </summary>
                  <ul>
                    {signal.submissionIds.map((id) => (
                      <li key={id}>
                        <SubmissionHistoryButton
                          submissionId={id}
                          ticId={ticId}
                          returnTo={from}
                        />
                        {id === signal.latestSubmissionId && " (최신)"}
                      </li>
                    ))}
                  </ul>
                </details>
                <nav aria-label={`신호 ${signal.candidateId} 이동`}>
                  {signal.latestHistoryId && (
                    <Link to={historyLink(signal.latestHistoryId)}>
                      최신 기록과 곡선 보기
                    </Link>
                  )}
                  {signal.latestHistoryId &&
                    signal.publication.state === "UNPUBLISHED" && (
                      <Link
                        to={pagePath(
                          "publication",
                          { historyId: signal.latestHistoryId },
                          context,
                        )}
                      >
                        분석 공개 검토
                      </Link>
                    )}
                  {signal.publication.state === "PUBLISHED" &&
                    signal.publication.publicAnalysisId && (
                      <Link
                        to={pagePath(
                          "publicAnalysis",
                          { analysisId: signal.publication.publicAnalysisId },
                          context,
                        )}
                      >
                        공개 분석 보기
                      </Link>
                    )}
                  {signal.threadId && (
                    <Link
                      to={pagePath(
                        "thread",
                        { threadId: signal.threadId },
                        context,
                      )}
                    >
                      공식 신호 스레드
                    </Link>
                  )}
                  {result.nextActions.includes("RETRY") &&
                    signal.status !== "retired" && (
                      <Link to={retryLink(signal.latestSubmissionId)}>
                        이 제출 재분석
                      </Link>
                    )}
                </nav>
              </section>
            ))}
          </section>
          <section>
            <h2>매칭되지 않은 제출</h2>
            {!result.unmatchedSubmissions.length && (
              <p>매칭되지 않은 제출이 없습니다.</p>
            )}
            <ul>
              {result.unmatchedSubmissions.map((item) => (
                <li key={item.submissionId}>
                  {item.submissionId} · {match[item.matchResult]} ·{" "}
                  {new Date(item.submittedAt).toLocaleString("ko-KR")}{" "}
                  {item.historyId && (
                    <Link to={historyLink(item.historyId)}>기록 보기</Link>
                  )}
                  {result.nextActions.includes("RETRY") && (
                    <Link to={retryLink(item.submissionId)}>
                      이 제출 재분석
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>제출한 곡선 단계</h2>
            <p>
              제출 당시 문맥의 계산 상태입니다. 현재 데이터의 준비 상태를 뜻하지
              않습니다. 과거 곡선은 각 기록에서 확인하고, 분석 계속에서 최신
              문맥을 조회합니다.
            </p>
            <ul>
              {result.curveSteps.map((step) => (
                <li key={step.curveStep}>
                  {step.curveStep === 0 ? "원본" : `${step.curveStep}단계`} ·{" "}
                  {step.residual.status
                    ? residual[step.residual.status]
                    : "계산 정보 없음"}
                </li>
              ))}
            </ul>
            {!result.curveSteps.length && <p>제출한 단계가 없습니다.</p>}
          </section>
          <section>
            <h2>새로 열린 별</h2>
            {!result.discoveredStars.length && (
              <p>이 별에서 새로 열린 별이 없습니다.</p>
            )}
            <ul>
              {result.discoveredStars.map((star) => (
                <li key={star.ticId}>
                  <Link to={skyPath(star.ticId)}>TIC {star.ticId}</Link> ·{" "}
                  {new Date(star.unlockedAt).toLocaleString("ko-KR")}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </article>
  );
}
