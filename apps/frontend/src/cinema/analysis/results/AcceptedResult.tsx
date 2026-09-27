// The result of an accepted submission in the cinema classic analysis (inside
// the classic result dialog, `SubmissionStatus`). Same receipt, same six axes
// read independently, in the cinema's words: a title that says what happened,
// one line of what to do next, the signal by name ("행성 1 · WASP-62 b"),
// numbers by the glossary, internal ids and versions only under 기술 정보,
// and at most two primary actions.
import type { ReactNode, RefObject } from "react";
import { Link } from "react-router-dom";
import { pagePath } from "../../../app/paths";
import type { DetailState } from "../../../features/analysis/AnalysisResult";
import { usePhaseDraft } from "../../../features/analysis/AnalysisSession";
import { celebrationText } from "../../../features/analysis/celebration";
import type {
  NextAction,
  SubmissionReceipt,
} from "../../../features/analysis/submission-data";
import type { SubmissionSignal } from "../../../features/analysis/submission-result";
import * as f from "../format";
import {
  isMemberPlanet,
  matchedSignalLabel,
  useStagePlanetIds,
} from "./labels";
import "./results.css";

export type AcceptedResultProps = {
  receipt: SubmissionReceipt;
  /** Found by checking the request id after a lost response. */
  recovered: boolean;
  detail: DetailState;
  onViewDetail(submissionId: string): void;
  /** 다음 튜토리얼로 (skipped submission of this curve). */
  onSkip(): void;
  /** First view of a recognized result (StrictCelebration rule). */
  celebrate: boolean;
  /** Accepted on a bundle that has changed since. */
  stale: boolean;
  recoverBundle: (() => boolean) | null;
  /** 다음 곡선 단계로, when this screen can go there. */
  nextCurve?: () => void;
  /** Back to editing: the submission state returns to idle. */
  dismiss(): void;
  close(): void;
  returnTo: string;
  currentPath: string;
  headingId: string;
  focusRef: RefObject<HTMLParagraphElement | null>;
};

type Action =
  | { kind: "link"; key: string; label: string; to: string }
  | { kind: "button"; key: string; label: string; run: () => void };

function replayNote(recovered: boolean, outcome: "created" | "replayed") {
  if (!recovered)
    return outcome === "created"
      ? null
      : "이미 접수된 제출이라 그때의 결과를 다시 보여 드립니다.";
  return outcome === "created"
    ? "응답을 받지 못해 다시 확인했고, 이번에 접수되었습니다."
    : "이미 접수돼 있던 제출을 확인했습니다. 두 번 접수되지 않았습니다.";
}

/**
 * "확정 행성 (출처: NASA Exoplanet Archive)", or with the catalog's own word
 * when it says more than ours ("행성 아님(오탐) · 식쌍성 (출처: TESS-EBs v1.0)").
 */
export function classification(
  signal: Pick<SubmissionSignal, "disposition" | "external">,
): string {
  const ours = f.dispositionLabel(signal.disposition);
  const item = signal.external[0];
  if (!item) return ours;
  const theirs = f.dispositionLabel(item.disposition);
  const name = f.knownPlanetName(signal.external);
  const source =
    name === item.externalId
      ? item.source
      : `${item.source} · ${item.externalId}`;
  return `${ours}${theirs !== ours ? ` · ${theirs}` : ""} (출처: ${source})`;
}

export function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Mine next to the signal's; rows where both are missing are left out. */
function Comparison({
  receipt,
  signal,
  signalLabel,
}: {
  receipt: SubmissionReceipt;
  signal: SubmissionSignal | null;
  signalLabel: string | null;
}) {
  const { submitted, serverDerived, correction } = receipt.explanation;
  const bls = signal?.bls;
  const rows = [
    {
      label: "주기",
      mine: f.periodDays(submitted?.periodDays, 3),
      theirs: f.periodDays(bls?.periodDays, 3),
    },
    {
      label: "위상 구간",
      mine: f.phaseRange(submitted?.phaseStart, submitted?.phaseEnd),
      theirs: null,
    },
    {
      label: "가려진 시간",
      mine: f.hours(serverDerived?.durationHours),
      theirs: f.hours(bls?.durationHours),
    },
    { label: "깊이", mine: null, theirs: f.depthPercent(bls?.depthPpm) },
  ].filter((row) => row.mine !== null || row.theirs !== null);
  if (!rows.length) return null;
  const other = signal !== null;
  return (
    <section className="result-compare pc-result-compare">
      <table
        aria-label={
          other
            ? `내가 고른 값과 ${signalLabel ?? "신호"} 비교`
            : "내가 고른 값"
        }
      >
        <thead>
          <tr>
            <th scope="col">항목</th>
            <th scope="col">내가 고른 값</th>
            {other && <th scope="col">{signalLabel ?? "신호"}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.mine ?? <span className="result-none">—</span>}</td>
              {other && (
                <td>{row.theirs ?? <span className="result-none">—</span>}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {correction && (
        <p className="submission-note">
          고른 주기 × {String(Number(correction.multiplier.toFixed(2)))} ={" "}
          {f.periodDays(correction.correctedPeriodDays, 3)}로 맞췄습니다.
        </p>
      )}
    </section>
  );
}

export function AcceptedResult(props: AcceptedResultProps) {
  const {
    receipt,
    recovered,
    detail,
    onViewDetail,
    onSkip,
    celebrate,
    stale,
    recoverBundle,
    nextCurve,
    dismiss,
    close,
    returnTo,
    currentPath,
    headingId,
    focusRef,
  } = props;
  const { setState: setDraft } = usePhaseDraft();
  const planetIds = useStagePlanetIds(receipt.ticId);
  const { explanation, progress, matchStatus } = receipt;
  const {
    signal,
    evaluation,
    achievement,
    publication,
    statistics,
    correction,
  } = explanation;
  const shownSignal: SubmissionSignal | null =
    signal ?? (detail.phase === "shown" ? detail.view.signal : null);
  const planet = signal
    ? isMemberPlanet(signal, receipt.submissionId, planetIds)
    : false;
  const signalLabel = signal
    ? matchedSignalLabel({
        signal,
        planet,
        planetIds,
        matchedIds: progress.matchedCandidateIds,
        withPeriodDays: false,
      })
    : shownSignal
      ? "이 단계의 신호"
      : null;
  const knownName = signal ? f.knownPlanetName(signal.external) : null;
  const title = f.resultTitle({
    matchStatus,
    achievement: achievement.result,
    disposition: signal?.disposition,
    knownName,
  });
  const missed = matchStatus === "not_matched";
  const ambiguous = matchStatus === "ambiguous_match";
  const lead = missed
    ? f.NOT_MATCHED_HINT
    : ambiguous
      ? "주기나 구간을 조금 바꿔 다시 풀어 보세요."
      : f.matchSentence(matchStatus, correction?.multiplier);
  const cheer = celebrationText(celebrate, achievement.result);
  const note = replayNote(recovered, receipt.outcome);
  const completed = progress.stage === "completed";

  // ---- actions: 「나의 은하로」 + the most relevant next step; the rest small.
  const offered = new Set<NextAction>(receipt.nextActions);
  const { ticId, historyId } = receipt;
  const links: Partial<Record<NextAction, Action>> = {
    RETRY: {
      kind: "link",
      key: "RETRY",
      label: "다시 풀기",
      to:
        pagePath("analysis", { ticId }, { returnTo }) +
        `&retryOfSubmissionId=${encodeURIComponent(receipt.submissionId)}`,
    },
    PUBLISH_ANALYSIS: {
      kind: "link",
      key: "PUBLISH_ANALYSIS",
      label: "공개 검토",
      to: pagePath("publication", { historyId }, { returnTo: currentPath }),
    },
    VIEW_RESULT: {
      kind: "link",
      key: "VIEW_RESULT",
      label: "분석 결과 보기",
      to: pagePath("starResults", { ticId }, { returnTo: currentPath }),
    },
    DISCUSS: {
      kind: "link",
      key: "DISCUSS",
      label: "토론 글 쓰기",
      to:
        pagePath(
          "postCreate",
          {},
          { ticId, historyId, returnTo: currentPath },
        ) + "&purposeTag=DISCUSSION",
    },
  };
  // A fully explored star has no next curve to go to.
  if (offered.has("NEXT_CURVE") && nextCurve && !completed)
    links.NEXT_CURVE = {
      kind: "button",
      key: "NEXT_CURVE",
      label: "다음 곡선 단계로",
      run: nextCurve,
    };
  const again = (
    step: 1 | 2,
    label = step === 2 ? "구간 다시 잡기" : "주기부터 다시 고르기",
  ): Action => ({
    kind: "button",
    key: `AGAIN-${step}`,
    label,
    run: () => {
      // Back to the analysis with the period (and window) as they were, at
      // that step (as its step button does); the result closes and a new
      // submission can be made. A new period there clears the window and
      // judgment once it has folded, as it always does.
      dismiss();
      setDraft((previous) => ({
        ...previous,
        editingStep: step,
        review: null,
      }));
    },
  });
  const home: Action = {
    kind: "link",
    key: "HOME",
    label: "나의 은하로",
    to: "/sky",
  };
  let next: Action | null;
  let rest: Action[];
  if (missed) {
    // The window is the usual miss; the period may be too.
    next = again(2);
    rest = [again(1, "주기 다시 고르기")];
  } else if (ambiguous) {
    next = again(1);
    rest = [];
  } else {
    const order: NextAction[] =
      achievement.result === "pending_publish"
        ? ["PUBLISH_ANALYSIS", "NEXT_CURVE", "VIEW_RESULT", "DISCUSS", "RETRY"]
        : ["NEXT_CURVE", "VIEW_RESULT", "PUBLISH_ANALYSIS", "DISCUSS", "RETRY"];
    const available = order
      .filter((action) => offered.has(action) && links[action])
      .map((action) => links[action]!);
    next = available[0] ?? null;
    rest = available.slice(1);
  }
  const render = (action: Action, className: string) =>
    action.kind === "link" ? (
      <Link key={action.key} className={className} to={action.to}>
        {action.label}
      </Link>
    ) : (
      <button
        key={action.key}
        type="button"
        className={className}
        onClick={action.run}
      >
        {action.label}
      </button>
    );

  const detailTarget = explanation.detail.targetKind;
  return (
    <>
      <div className="pc-result" data-match={matchStatus}>
        <p className="pc-result-eyebrow">분석 결과</p>
        <h4 id={headingId}>{title}</h4>
        <p
          ref={focusRef}
          tabIndex={-1}
          role="status"
          className="pc-result-lead"
        >
          {lead}
        </p>
        {cheer && <p className="result-celebrate">{cheer}</p>}
        {note && <p className="submission-note">{note}</p>}
        {stale && (
          <p className="submission-note" data-testid="stale-bundle">
            이 결과는 제출할 때의 자료 기준입니다. 그 뒤 별의 자료가 바뀌었으니
            이어서 분석하려면 최신 자료를 불러와 주세요.{" "}
            {recoverBundle && (
              <button
                type="button"
                className="pc-result-inline"
                onClick={recoverBundle}
              >
                최신 자료 불러오기
              </button>
            )}
          </p>
        )}

        <Comparison
          receipt={receipt}
          signal={shownSignal}
          signalLabel={signalLabel}
        />

        <dl className="pc-result-facts">
          {signal && (
            <Row term="찾은 신호">
              {matchedSignalLabel({
                signal,
                planet,
                planetIds,
                matchedIds: progress.matchedCandidateIds,
              })}
            </Row>
          )}
          {signal && <Row term="분류">{classification(signal)}</Row>}
          {evaluation && f.EVALUATION[evaluation] && (
            <Row term="내 판단">{f.EVALUATION[evaluation]}</Row>
          )}
          {achievement.result !== "none" &&
            f.ACHIEVEMENT[achievement.result] && (
              <Row term="성과">
                {f.ACHIEVEMENT[achievement.result]}
                {achievement.star.count > 0 &&
                  ` 이 별의 성과 ${f.count(achievement.star.count)}건${achievement.star.grade ? ` · 등급 ${achievement.star.grade}` : ""}.`}
              </Row>
            )}
          {achievement.unlockedTicIds.length > 0 ? (
            <Row term="새로 열린 별">
              {f.count(achievement.unlockedTicIds.length)}개
            </Row>
          ) : (
            achievement.result === "recognized" && (
              <Row term="새로 열린 별">{f.NO_NEW_STAR}</Row>
            )
          )}
          <Row term="이 별의 탐사">
            {completed
              ? `탐사 완료${progress.completionReason ? ` · ${f.COMPLETION[progress.completionReason] ?? ""}` : ""}`
              : `탐사 중 · 찾을 수 있는 신호 ${f.count(progress.remainingDiscoverableCount)}개 남음`}
          </Row>
          {publication.state === "UNPUBLISHED" && (
            <Row term="공개">이 분석은 공개할 수 있습니다.</Row>
          )}
          {signal && f.aiLine(signal.ai) && (
            <Row term="AI 판정">
              {f.aiLine(signal.ai)} · 성과 판정에는 쓰이지 않습니다.
            </Row>
          )}
          {statistics && (
            <Row term="다른 사람의 판단">{f.statisticsLine(statistics)}</Row>
          )}
        </dl>

        {explanation.detail.available && detail.phase === "idle" && (
          <p className="pc-result-more">
            <button
              type="button"
              className="pc-result-inline"
              onClick={() => onViewDetail(receipt.submissionId)}
            >
              {detailTarget === "CURRENT_CURVE_HINT"
                ? "이 곡선에서 찾을 수 있었던 신호 보기"
                : "이 신호 자세히 보기"}
            </button>
          </p>
        )}
        {detail.phase === "loading" && (
          <p role="status" className="pc-result-more">
            신호 정보를 불러오고 있습니다.
          </p>
        )}
        {detail.phase === "unavailable" && (
          <p role="alert" className="pc-result-more">
            {detail.message}
          </p>
        )}
        {detail.phase === "shown" && (
          <section className="pc-result-detail">
            <h5>
              {detail.view.targetKind === "CURRENT_MATCH"
                ? "이 신호는"
                : "이 곡선에서 찾을 수 있었던 신호"}
            </h5>
            {!signal && (
              <p>
                주기 {f.periodDays(detail.view.signal.bls.periodDays, 3)} ·
                가려진 시간 {f.hours(detail.view.signal.bls.durationHours)} ·
                깊이 {f.depthPercent(detail.view.signal.bls.depthPpm)}
              </p>
            )}
            <p>
              {detail.view.signal.explanation ??
                "이 신호의 해설은 아직 없습니다. 위 표의 수치로 견주어 보세요."}
            </p>
            {detail.view.userJudgmentAgrees !== null && (
              <p>
                {detail.view.userJudgmentAgrees
                  ? "내 판단과 같습니다."
                  : "내 판단과 다릅니다."}
              </p>
            )}
            {detail.view.tutorial.skipAvailable && (
              <p>
                <button
                  type="button"
                  className="pc-result-inline"
                  onClick={onSkip}
                >
                  다음 튜토리얼로
                </button>
              </p>
            )}
          </section>
        )}

        <details className="pc-result-tech">
          <summary>기술 정보</summary>
          <dl>
            <Row term="접수 번호">{receipt.submissionId}</Row>
            <Row term="기록 번호">{receipt.historyId}</Row>
            <Row term="접수 시각">
              <time dateTime={receipt.submittedAt}>
                {f.when(receipt.submittedAt)}
              </time>
            </Row>
            <Row term="곡선">
              {f.curveStepName(receipt.curveContext.curveStep)}
            </Row>
            {shownSignal && (
              <Row term="신호 번호">{shownSignal.candidateId}</Row>
            )}
            {explanation.serverDerived?.epochBtjd != null && (
              <Row term="기준 시각 (내 값)">
                {f.referenceTime(explanation.serverDerived.epochBtjd)}
              </Row>
            )}
            {shownSignal && (
              <Row term="기준 시각 (신호)">
                {f.referenceTime(shownSignal.bls.epochBtjd)}
              </Row>
            )}
            {shownSignal?.bls.sde != null && (
              <Row term="SDE">{shownSignal.bls.sde.toFixed(1)}</Row>
            )}
            {shownSignal?.bls.snr != null && (
              <Row term="SNR">{shownSignal.bls.snr.toFixed(1)}</Row>
            )}
            {shownSignal?.ai.modelVersion && (
              <Row term="AI 모델">{shownSignal.ai.modelVersion}</Row>
            )}
            {correction?.reason && (
              <Row term="배수 정정 근거">{correction.reason}</Row>
            )}
            {shownSignal?.external.map((item) => (
              <Row key={`${item.source}:${item.externalId}`} term="외부 자료">
                {item.source} {item.externalId} · {item.disposition} ·{" "}
                {item.fetchedOn} 조회
              </Row>
            ))}
          </dl>
        </details>
      </div>

      <div className="pc-result-actions" data-testid="next-actions">
        <div className="pc-result-primary">
          {next && render(next, "pc-result-button pc-result-button-main")}
          {render(home, "pc-result-button")}
        </div>
        <div className="pc-result-secondary">
          {rest.map((action) => render(action, "pc-result-inline"))}
          <button type="button" className="pc-result-inline" onClick={close}>
            닫기
          </button>
        </div>
      </div>
    </>
  );
}
