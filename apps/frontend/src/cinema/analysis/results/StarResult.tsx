// `/results/:ticId` in the cinema app: the same star result (API 8.4, read by
// features/analysis/star-result.ts) in the cinema's words. Signals are named
// as the star panel names them ("행성 1 · WASP-62 b"), numbers follow the
// glossary, and ids, versions and pipeline states sit under 기술 정보.
// StarResultPage hands over here only when the cinema app provides the copy.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, http } from "../../../api";
import { pagePath } from "../../../app/paths";
import { SubmissionHistoryButton } from "../../../features/analysis/SubmissionHistoryButton";
import {
  readStarResult,
  starResultPath,
  type StarResult,
} from "../../../features/analysis/star-result";
import { useCinemaSky } from "../../shell/sky";
import { galaxySearch } from "../../shell/stage";
import { useStarDetail } from "../../shell/star-detail";
import * as f from "../format";
import { Row } from "./AcceptedResult";
import { useKnownPlanetNames } from "./labels";
import "./results.css";
import { explorationOrigin, explorationBackLabel, starResultsLocation } from "./navigation";

type State =
  | { phase: "loading" }
  | { phase: "ready"; value: StarResult }
  | { phase: "error"; message: string; retryable: boolean };

type Signal = StarResult["signals"][number];

const RESIDUAL: Record<string, string> = {
  COMPLETED: "계산 완료",
  QUEUED: "계산 대기",
  RESIDUAL_CALCULATING: "잔차 계산 중",
  RESIDUAL_READY: "잔차 준비됨",
  PERIODOGRAM_CALCULATING: "주기도 계산 중",
  FAILED: "계산 실패",
};

/** HOME-05 on the result's own data, until the star detail is read. */
const likelyPlanet = (signal: Signal) =>
  signal.disposition === "CONFIRMED" ||
  (signal.disposition === "UNCONFIRMED" &&
    signal.userJudgment === "LIKELY_PLANET");

/** The analysis entry by the star's state (glossary). */
const entryLabel = (stage: string) =>
  stage === "completed"
    ? "다시 분석"
    : stage === "in_progress"
      ? "이어서 분석"
      : "분석 시작";

export function CinemaStarResult({
  ticId,
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
            ? "볼 수 있는 분석 결과가 없습니다."
            : "분석 결과를 불러오지 못했습니다. 다시 시도해 주세요.",
        });
      });
    return () => controller.abort();
  }, [ticId, attempt]);

  // The member's planets on this star, as the star panel lists them.
  const sky = useCinemaSky();
  const focus = useStarDetail(sky, ticId);
  const detail = focus.ticId === ticId ? focus.detail : null;
  const names = useKnownPlanetNames(detail);
  const result = state.phase === "ready" ? state.value : null;
  const planets = useMemo(() => {
    if (detail) return detail.system.items;
    return (result?.signals ?? []).filter(likelyPlanet).map((signal) => ({
      candidateId: signal.candidateId,
      periodDays: null as number | null,
    }));
  }, [detail, result]);
  const labels = useMemo(
    () =>
      f.signalLabels(
        result?.signals.map((signal) => signal.candidateId) ?? [],
        planets.map((planet) => planet.candidateId),
        names,
      ),
    [result, planets, names],
  );
  const periodOf = (id: string) =>
    planets.find((planet) => planet.candidateId === id)?.periodDays ?? null;

  const origin = explorationOrigin(returnTo, ticId);
  const from = starResultsLocation(ticId, returnTo);
  const context = { ticId, returnTo: from };
  // The galaxy restores the selection from `star`; keep the sky filters.
  const skyPath = (id: string) => {
    const target = new URL(origin, "https://planetory.invalid");
    const params =
      target.pathname === "/sky" ? target.searchParams : new URLSearchParams();
    params.set("star", id);
    return `/sky?${params}`;
  };
  const historyLink = (id: string) =>
    pagePath("historyDetail", { historyId: id }, context);
  const retryLink = (id: string) =>
    pagePath("analysis", { ticId }, { returnTo: origin }) +
    `&retryOfSubmissionId=${encodeURIComponent(id)}`;
  // Planets first in their order, then the other signals.
  const isPlanet = (id: string) =>
    planets.some((planet) => planet.candidateId === id);
  const byId = (a: Signal, b: Signal) =>
    a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
  const ordered = result
    ? [
        ...result.signals.filter((s) => isPlanet(s.candidateId)).sort(byId),
        ...result.signals.filter((s) => !isPlanet(s.candidateId)).sort(byId),
      ]
    : [];
  const planetCount = result
    ? result.signals.filter((signal) => isPlanet(signal.candidateId)).length
    : 0;
  // A cumulative result is not necessarily a successful or finished search.
  // Old failures must not displace continuing a star with matched signals.
  const retrySubmission = result?.signals.length === 0 && result.nextActions.includes("RETRY")
    ? result.unmatchedSubmissions
        .filter((item) => item.matchResult !== "skipped")
        .reduce<(typeof result.unmatchedSubmissions)[number] | null>(
          (latest, item) => !latest || Date.parse(item.submittedAt) > Date.parse(latest.submittedAt) ? item : latest,
          null,
        )
    : null;
  const continueFirst = !!result?.bundle &&
    (result.progress.stage !== "completed" || result.progress.reopenPending);
  const analysisAction = result?.bundle ? {
    key: "analysis",
    label: result.progress.reopenPending ? "새 자료로 분석" :
      continueFirst && retrySubmission ? "다시 분석" : entryLabel(result.progress.stage),
    to: continueFirst && !result.progress.reopenPending && retrySubmission
      ? retryLink(retrySubmission.submissionId)
      : pagePath("analysis", { ticId }, { returnTo: origin }),
  } : null;
  const galaxyUrl = `/sky${galaxySearch(new URL(skyPath(ticId), "https://planetory.invalid").search)}`;
  const fromGalaxy = new URL(origin, "https://planetory.invalid").pathname === "/sky";
  const galaxyAction = { key: "galaxy", label: "나의 은하로 돌아가기", to: galaxyUrl };
  const mainActions = continueFirst && analysisAction
    ? [analysisAction, galaxyAction]
    : [galaxyAction, ...(analysisAction ? [analysisAction] : [])];

  return (
    <article className="star-result pc-result-page">
      <h1>TIC {ticId} 탐사 결과</h1>
      <p>이 별에서 찾은 신호와 누적 성과, 제출 기록을 모았습니다.</p>
      {!result && <nav aria-label="결과 화면 이동">
        <Link to={fromGalaxy ? galaxyUrl : origin}>{explorationBackLabel(origin)}</Link>
        {!fromGalaxy && (
          <Link to={galaxyUrl}>나의 은하로 돌아가기</Link>
        )}
      </nav>}
      {state.phase === "loading" && (
        <p role="status">분석 결과를 불러오는 중입니다.</p>
      )}
      {state.phase === "error" && (
        <>
          <p role="alert">{state.message}</p>
          {state.retryable && (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              다시 불러오기
            </button>
          )}
        </>
      )}
      {result && (
        <>
          <section aria-labelledby="star-summary">
            <h2 id="star-summary">탐사 요약</h2>
            <p>
              {f.explorationStatus(result.progress.stage)}
              {result.progress.completionReason &&
                ` · ${f.COMPLETION[result.progress.completionReason] ?? ""}`}
            </p>
            {result.unpublishedSignalCount > 0 && (
              <p>
                아직 공개하지 않은 분석이 있습니다(신호{" "}
                {f.count(result.unpublishedSignalCount)}개).
              </p>
            )}
            {result.progress.reopenPending && (
              <p>새 자료로 다시 탐사할 수 있습니다.</p>
            )}
            <dl>
              <dt>찾은 신호</dt>
              <dd>
                {f.count(result.signals.length)}개
                {result.signals.length > 0 &&
                  ` (행성 ${f.count(planetCount)}개)`}
              </dd>
              <dt>제출</dt>
              <dd>{f.count(result.submissionCount)}번</dd>
              <dt>인정된 성과</dt>
              <dd>
                {f.count(result.achievement.count)}건
                {result.achievement.grade
                  ? ` · 등급 ${result.achievement.grade}`
                  : ""}
              </dd>
              <dt>관측</dt>
              <dd>
                섹터 {f.count(result.star.sectorCount)}개
                {result.star.tmag !== null
                  ? ` · 밝기 등급 ${result.star.tmag.toFixed(1)}`
                  : ""}
              </dd>
            </dl>
            <nav aria-label="분석 결과 다음 행동">
              {mainActions.map((action, index) => (
                <Link key={action.key} className={index === 0 ? "pc-result-return" : undefined} to={action.to}>
                  {action.label}
                </Link>
              ))}
              {result.nextActions.includes("PUBLISH_ALL") && (
                <Link to={pagePath("publicationBatch", {}, context)}>
                  공개 검토
                </Link>
              )}
              {result.links.boardOpen && (
                <Link to={pagePath("starBoard", { ticId }, context)}>
                  별 게시판
                </Link>
              )}
              {!fromGalaxy && (
                <Link to={origin}>{explorationBackLabel(origin)}</Link>
              )}
            </nav>
          </section>

          <section aria-labelledby="signal-list">
            <h2 id="signal-list">찾은 신호</h2>
            {!result.signals.length && (
              <p>아직 찾은 신호가 없습니다. 제출한 기록은 아래에 있습니다.</p>
            )}
            {ordered.map((signal) => {
              const label = labels.get(signal.candidateId) ?? "신호";
              const ai = f.aiLine(signal.ai);
              return (
                <section
                  className="star-result-card"
                  key={signal.candidateId}
                  aria-label={label}
                >
                  <h3>{f.withPeriod(label, periodOf(signal.candidateId))}</h3>
                  <p>
                    {f.dispositionLabel(signal.disposition)}
                    {signal.status === "retired" && " · 지금은 쓰지 않는 신호"}
                    {/* A known signal is never published; say nothing then. */}
                    {signal.publication.state !== "NOT_ELIGIBLE" &&
                      ` · ${f.PUBLICATION_SHORT[signal.publication.state]}`}
                  </p>
                  <p>
                    내 판단:{" "}
                    {signal.userJudgment
                      ? f.JUDGMENT[signal.userJudgment]
                      : "기록 없음"}
                    {signal.judgmentEvaluation &&
                    f.EVALUATION[signal.judgmentEvaluation]
                      ? ` · ${f.EVALUATION[signal.judgmentEvaluation]}`
                      : ""}
                  </p>
                  {signal.achievement.result !== "none" && (
                    <p>
                      {f.ACHIEVEMENT[signal.achievement.result] ?? ""}
                      {signal.achievement.recognizedAt &&
                        ` (${f.when(signal.achievement.recognizedAt)})`}
                    </p>
                  )}
                  {signal.relabel && (
                    <p>
                      {f.when(signal.relabel.relabeledAt)}에 분류가{" "}
                      {f.dispositionLabel(signal.relabel.newDisposition)}(으)로
                      바뀌었습니다. 그때의 판단은 다시 채점하지 않습니다.
                    </p>
                  )}
                  {ai && <p>AI 판정: {ai} · 성과 판정에는 쓰이지 않습니다.</p>}
                  {signal.statistics && (
                    <p>
                      다른 사람의 판단: {f.statisticsLine(signal.statistics)}
                    </p>
                  )}
                  <p>
                    {f.curveStepName(signal.curveStepAtMatch)}에서 찾음 · 제출{" "}
                    {f.count(signal.submissionIds.length)}번
                  </p>
                  <nav aria-label={`${label} 이동`}>
                    {signal.latestHistoryId && (
                      <Link to={historyLink(signal.latestHistoryId)}>
                        제출 기록 상세
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
                          공개 검토
                        </Link>
                      )}
                    {signal.publication.state === "PUBLISHED" &&
                      signal.publication.publicAnalysisId && (
                        <Link
                          to={pagePath(
                            "publicAnalysis",
                            {
                              analysisId: signal.publication.publicAnalysisId,
                            },
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
                        신호 토론 보기
                      </Link>
                    )}
                    {result.nextActions.includes("RETRY") &&
                      signal.status !== "retired" && (
                        <Link to={retryLink(signal.latestSubmissionId)}>
                          이 신호 다시 분석
                        </Link>
                      )}
                  </nav>
                  {signal.submissionIds.length > 1 && (
                    <details>
                      <summary>
                        제출 기록 {f.count(signal.submissionIds.length)}건
                      </summary>
                      <ul>
                        {signal.submissionIds.map((id, index) => (
                          <li key={id}>
                            <SubmissionHistoryButton
                              submissionId={id}
                              ticId={ticId}
                              returnTo={from}
                              label={`${index + 1}번째 제출 기록 보기${id === signal.latestSubmissionId ? " (최신)" : ""}`}
                            />
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </section>
              );
            })}
          </section>

          {result.unmatchedSubmissions.length > 0 && (
            <section aria-labelledby="unmatched-list">
              <h2 id="unmatched-list">신호를 찾지 못한 제출</h2>
              <ul>
                {result.unmatchedSubmissions.map((item) => (
                  <li key={item.submissionId}>
                    {f.when(item.submittedAt)} ·{" "}
                    {f.MATCH_SHORT[item.matchResult] ?? item.matchResult}{" "}
                    {item.historyId && (
                      <Link to={historyLink(item.historyId)}>기록 보기</Link>
                    )}
                    {result.nextActions.includes("RETRY") && (
                      <Link to={retryLink(item.submissionId)}>다시 분석</Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="unlocked-list">
            <h2 id="unlocked-list">이 별에서 새로 열린 별</h2>
            {!result.discoveredStars.length && (
              <p>이 별에서 새로 열린 별은 아직 없습니다.</p>
            )}
            <ul>
              {result.discoveredStars.map((star) => (
                <li key={star.ticId}>
                  <Link to={skyPath(star.ticId)}>TIC {star.ticId}</Link> ·{" "}
                  {f.when(star.unlockedAt)}
                </li>
              ))}
            </ul>
          </section>

          <details className="pc-result-tech">
            <summary>기술 정보</summary>
            <dl>
              {result.bundle && (
                <Row term="자료 판">{result.bundle.bundleId}</Row>
              )}
              {result.bundle && (
                <Row term="자료 공개">{f.when(result.bundle.publishedAt)}</Row>
              )}
              {result.curveSteps.map((step) => (
                <Row
                  key={step.curveStep}
                  term={`${f.curveStepName(step.curveStep)} 계산`}
                >
                  {step.residual.status
                    ? (RESIDUAL[step.residual.status] ?? step.residual.status)
                    : "정보 없음"}
                </Row>
              ))}
              {result.signals.map((signal) => (
                <Row
                  key={signal.candidateId}
                  term={`${labels.get(signal.candidateId) ?? "신호"} 번호`}
                >
                  {signal.candidateId}
                </Row>
              ))}
            </dl>
          </details>
        </>
      )}
    </article>
  );
}
