import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { pagePath } from "../../app/paths";
import { usePageContext } from "../../app/usePageContext";
import type { AnalysisContext } from "../../features/analysis/analysis-data";
import {
  createCandidateReview,
  evidenceOptions,
  judgments,
  MEMO_LIMIT,
  memoCodePoints,
  validateJudgment,
  type CandidateReview,
  type Judgment,
  type JudgmentDraft,
  type PeriodogramViewport,
} from "../../features/analysis/analysis-judgment";
import {
  useAnalysisFold,
  useBundleRecovery,
  useCurveStepSession,
  usePhaseDraft,
} from "../../features/analysis/AnalysisSession";
import { useAnalysisStage } from "../../features/analysis/analysis-stage";
import type { SelectionIssue } from "../../features/analysis/selection-rules";
import {
  acceptedOnOlderBundle,
  type SubmissionReceipt,
} from "../../features/analysis/submission-data";
import {
  candidateInput,
  noCandidateInput,
  skippedInput,
  specialSubmissions,
} from "../../features/analysis/submission-input";
import type { useSubmission } from "../../features/analysis/use-submission";
import { useModalDialog } from "../../features/analysis/use-modal-dialog";
import type { AnalysisOutcome } from "../analysis/bridge";
import * as f from "../analysis/format";
import {
  isMemberPlanet,
  matchedSignalLabel,
  useStagePlanetIds,
} from "../analysis/results/labels";
import {
  acceptedNotice,
  format,
  inlineResult,
  submissionView,
  type SubmissionAction,
} from "./model";
import type { AreaState } from "./PeriodArea";
import { ResultDialog } from "./ResultDialog";

type Submission = ReturnType<typeof useSubmission>;

const ACTION_LABEL: Record<SubmissionAction, string> = {
  check: "접수 결과 확인",
  resend: "같은 내용으로 다시 보내기",
  submitAsNew: "별도 제출로 보내기",
  prepare: "이 단계 계산 준비하기",
  reloadBundle: "최신 자료 불러오기",
  dismiss: "입력으로 돌아가기",
};

/**
 * Judgment, submission and the compact result. The judgment model, request
 * IDs, recovery after a lost response and every refusal come from the
 * classic hooks; this only lays them out.
 *
 * Choosing a judgment while a valid window is shown confirms that window,
 * the same state change as the classic "구간 확정하고 판단하기". "제출값 확인"
 * builds the classic review snapshot (EXP-12 제출값 확인) and shows it; only
 * "제출하기" there sends it, with one request ID. Any edit to the window,
 * judgment, evidence or memo drops the review, as in the classic.
 */
export function JudgeArea({
  context,
  submission,
  outcome,
  celebrate,
  areaState,
  getViewport,
  foldedZoom,
  onSend,
}: {
  context: AnalysisContext;
  submission: Submission;
  outcome: AnalysisOutcome | null;
  celebrate: boolean;
  areaState: AreaState;
  getViewport: () => PeriodogramViewport;
  /** Current display zoom capped to the API range (1–32). */
  foldedZoom: number;
  /** The judgment actually sent, for the outcome event. */
  onSend: (judgment: Judgment | null) => void;
}) {
  const { state, setState, ready } = usePhaseDraft();
  const fold = useAnalysisFold();
  const { stage, confirmed } = useAnalysisStage();
  const recoverBundle = useBundleRecovery();
  const curveStep = useCurveStepSession();
  const { returnTo, currentPath } = usePageContext();
  const [issues, setIssues] = useState<SelectionIssue[]>([]);
  // Which accepted submission's full result is open. Keyed to the
  // submission, so a result left through "구간 다시 잡기" (which never closes
  // the dialog itself) does not open the next result's dialog on its own.
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const hintId = useId(),
    memoId = useId(),
    errorId = useId();
  const judgmentRef = useRef<HTMLInputElement>(null);
  const memoRef = useRef<HTMLTextAreaElement>(null);
  const memoDetails = useRef<HTMLDetailsElement>(null);
  const settledRef = useRef<HTMLHeadingElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<"review" | "judgment" | null>(null);
  const preview = state.preview?.kind === "preview" ? state.preview : null;
  const locked = submission.locked;
  const choosable = ready && !!preview && !state.dragging && !locked;
  const editable = ready && confirmed && stage >= 3 && !locked;
  // The review stays while a send is in flight or unresolved, so the member
  // sees what was sent.
  const review = ready && confirmed && stage >= 3 ? state.review : null;
  useEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    if (next === "review" && review) reviewRef.current?.focus();
    else if (next === "judgment" && !review) judgmentRef.current?.focus();
    else return;
    focusNext.current = null;
  });
  const settled =
    submission.state.phase === "settled" ? submission.state : null;
  const accepted = submission.accepted;
  // Leaving the result (a new submission, "구간 다시 잡기") closes it too.
  useEffect(() => {
    if (!accepted) setDetailFor(null);
  }, [accepted]);

  // Move focus to the result or the problem only when it appears.
  const lastSettled = useRef<unknown>(null);
  useEffect(() => {
    if (!settled || lastSettled.current === settled) return;
    lastSettled.current = settled;
    settledRef.current?.focus({ preventScroll: true });
  }, [settled]);

  const choose = (value: Judgment) => {
    if (!choosable) return;
    setIssues([]);
    setState((previous) => {
      const current =
        previous.preview?.kind === "preview" ? previous.preview : null;
      if (!current || previous.dragging) return previous;
      return {
        ...previous,
        editingStep: undefined,
        confirmed: current,
        review: null,
        judgment: { ...previous.judgment, userJudgment: value },
      };
    });
  };
  const edit = (patch: Partial<JudgmentDraft>) => {
    if (!editable) return;
    setIssues([]);
    setState((previous) => ({
      ...previous,
      judgment: { ...previous.judgment, ...patch },
      review: null,
    }));
  };
  const send = () => {
    if (!editable || !preview) return;
    const errors = validateJudgment(state.judgment);
    setIssues(errors);
    if (errors.length) {
      if (errors[0].field === "memo") {
        if (memoDetails.current) memoDetails.current.open = true;
        memoRef.current?.focus();
      } else judgmentRef.current?.focus();
      return;
    }
    try {
      const review = createCandidateReview(
        context.ticId,
        context.curveContext,
        preview,
        state.judgment,
        getViewport(),
        foldedZoom,
      );
      focusNext.current = "review";
      setState((previous) => ({ ...previous, editingStep: undefined, review }));
    } catch (error) {
      setIssues([
        {
          field: "viewState",
          code: "INVALID_VIEW",
          message: (error as Error).message,
        },
      ]);
    }
  };

  const sendReview = () => {
    if (!review || locked) return;
    onSend(review.input.userJudgment);
    void submission.submit(candidateInput(review));
  };
  const editReview = () => {
    if (locked) return;
    focusNext.current = "judgment";
    setState((previous) => ({ ...previous, review: null }));
  };

  const view = submissionView(submission.state, {
    resendable: submission.resendable,
    canPrepare: Boolean(curveStep) && settled?.state === "context-not-ready",
  });
  const act = (action: SubmissionAction) => {
    switch (action) {
      case "check":
        return void submission.check();
      case "resend":
        return void submission.resend();
      case "submitAsNew":
        return void submission.submitAsNew();
      case "prepare":
        return void curveStep?.prepare();
      case "reloadBundle":
        // A new request ID starts here, after the member confirmed it.
        submission.discardRequest();
        recoverBundle?.();
        return submission.dismiss();
      case "dismiss":
        return submission.dismiss();
    }
  };

  const stale = Boolean(
    accepted &&
    acceptedOnOlderBundle(accepted.receipt, accepted.currentBundleId),
  );
  const nextCurve =
    curveStep && accepted && !stale
      ? () => {
          const { curveContext, progress } = accepted.receipt;
          curveStep.goTo({
            ...curveContext,
            curveStep: progress.matchedCandidateIds.length,
            removedCandidateIds: progress.matchedCandidateIds,
          });
          setDetailFor(null);
        }
      : undefined;

  const result = accepted && outcome ? inlineResult(outcome) : null;
  // A judgment belongs to the window it confirmed. After the window changes
  // (a new drag, or "구간 다시 잡기") it shows unchosen until picked again,
  // which confirms the new window; a stale tick next to a disabled
  // "제출값 확인" reads as a broken button.
  const chosen =
    ready && confirmed && stage >= 3 ? state.judgment.userJudgment : null;
  const planetIds = useStagePlanetIds(context.ticId);
  const memoCount = memoCodePoints(state.judgment.memo);
  /**
   * Back to a step with the period (and window) as they were: the result
   * leaves (the submission returns to idle) and a new submission can be
   * made. The same move as the result dialog's "구간 다시 잡기" /
   * "주기 다시 고르기". Going back to the window hands focus to its handle.
   */
  const again = (step: 1 | 2) => {
    setDetailFor(null);
    submission.dismiss();
    setState((previous) => ({
      ...previous,
      editingStep: step,
      review: null,
      focus: step === 2 && previous.range ? previous.focus + 1 : previous.focus,
    }));
  };

  return (
    <section
      className="cx-area"
      data-area="judge"
      data-state={areaState}
      aria-label="판단과 제출"
    >
      <div className="cx-row">
        <h2 className="cx-label">
          판단
          <em>
            {result
              ? "결과"
              : review
                ? "제출값 확인"
                : editable
                ? "근거와 메모는 선택"
                : choosable
                  ? "행성 같은지 골라주세요"
                  : ""}
          </em>
          {review && (
            <details className="cx-calc-info">
              <summary aria-label="계산 안내">ⓘ</summary>
              <div className="cx-calc-popover">
                <p>아직 제출되지 않았습니다.</p>
                <p>가려진 시간은 미리보기이며, 제출하면 서버가 고른 주기와 구간으로 다시 계산해 확인합니다. 연결이 끊겨도 같은 제출은 한 번만 접수됩니다.</p>
                <p>기준 시각 {f.referenceTime(review.epochPreviewBtjd)} (TESS 관측 시각, 일)</p>
              </div>
            </details>
          )}
        </h2>
      </div>

      {accepted && result && outcome ? (
        <div
          className="cx-result"
          // The shell's discovery card hands focus to this region.
          role="region"
          aria-label="제출 결과"
          tabIndex={-1}
          data-tone={result.tone}
          data-kind={result.kind}
          data-testid="cx-result"
          data-analysis-result=""
        >
          <p className="cx-eyebrow">제출 완료 · {result.eyebrow}</p>
          <div className="cx-result-heading">
          <h3 ref={settledRef} tabIndex={-1}>
            {result.title}
          </h3>
          <p className="cx-result-lead" data-testid="cx-result-lead">
            {resultLead(accepted.receipt, outcome, planetIds)}
          </p>
          </div>
          {result.chips.length > 0 && (
            <ul className="cx-result-chips" aria-label="결과 요약">
              {result.chips.map((chip) => (
                <li key={chip.label} data-tone={chip.tone}>
                  {chip.label}
                </li>
              ))}
            </ul>
          )}
          {(accepted.recovered || accepted.receipt.outcome === "replayed") && (
            <p className="cx-note">
              {acceptedNotice(accepted.recovered, accepted.receipt.outcome)}
            </p>
          )}
          {stale && (
            <p className="cx-note" data-tone="warn" data-testid="cx-stale">
              이 결과는 제출할 때의 자료 기준입니다. 그 뒤 별의 자료가
              바뀌었으니 이어서 분석하려면 최신 자료를 불러와 주세요.{" "}
              {recoverBundle && (
                <button
                  type="button"
                  className="cx-link"
                  onClick={recoverBundle}
                >
                  최신 자료 불러오기
                </button>
              )}
            </p>
          )}
          <ResultActions
            receipt={accepted.receipt}
            kind={outcome.kind}
            nextCurve={nextCurve}
            onDetails={() => setDetailFor(accepted.receipt.submissionId)}
            onAgain={again}
          />
          <ResultDialog
            open={detailFor === accepted.receipt.submissionId}
            onClose={() => setDetailFor(null)}
            accepted={accepted}
            submission={submission}
            celebrate={celebrate}
            stale={stale}
            nextCurve={nextCurve}
            returnTo={returnTo}
            currentPath={currentPath}
            recoverBundle={recoverBundle}
          />
        </div>
      ) : (
        <>
          {review ? (
            <ReviewBlock
              review={review}
              headingRef={reviewRef}
              locked={locked}
              sending={submission.state.phase === "sending"}
              hintId={hintId}
              onEdit={editReview}
              onSend={sendReview}
            />
          ) : (
            <>
              <fieldset
                className="cx-options"
                disabled={!choosable && !editable}
                aria-describedby={hintId}
              >
                <legend className="cx-sr">판단 (필수)</legend>
                {judgments.map(({ value, label }, index) => (
                  <label
                    className="cx-option"
                    key={value}
                    data-checked={chosen === value}
                  >
                    <input
                      ref={index === 0 ? judgmentRef : undefined}
                      type="radio"
                      name={`cx-judgment-${context.ticId}`}
                      value={value}
                      checked={chosen === value}
                      aria-invalid={
                        issues.some(
                          (issue) => issue.field === "userJudgment",
                        ) || undefined
                      }
                      aria-describedby={`${errorId}-judgment`}
                      onChange={() => choose(value)}
                      onClick={() => choose(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              <p id={hintId} className="cx-sr">
                {!ready
                  ? "주기를 선택하고 접기 계산을 마치면 구간을 확정할 수 있습니다."
                  : !preview
                    ? "유효한 위상 구간을 선택해 주세요."
                    : state.dragging
                      ? "구간 조정을 마친 뒤 확정해 주세요."
                      : "판단을 고르면 지금 구간으로 확정합니다. 근거와 메모는 선택 사항입니다. 구간을 바꾸면 다시 확인해야 합니다."}
              </p>
              <div
                id={`${errorId}-judgment`}
                role="status"
                className="cx-note"
                data-tone="bad"
              >
                {issues
                  .filter((issue) => issue.field === "userJudgment")
                  .map((issue) => issue.message)
                  .join(" ")}
              </div>
              <details className="cx-more" ref={memoDetails}>
                <summary>
                  근거·메모
                  <span className="cx-ro">
                    {state.judgment.evidenceChecks.length
                      ? ` ${state.judgment.evidenceChecks.length}개`
                      : ""}
                    {state.judgment.memo ? " · 메모" : ""}
                  </span>
                </summary>
                <div className="cx-memo-body">
                <fieldset disabled={!editable}>
                  <legend className="cx-sr">확인한 근거 (선택)</legend>
                  {evidenceOptions.map(({ value, label }) => (
                    <label className="cx-check" key={value}>
                      <input
                        type="checkbox"
                        name="evidenceChecks"
                        value={value}
                        checked={state.judgment.evidenceChecks.includes(value)}
                        onChange={(event) =>
                          edit({
                            evidenceChecks: event.currentTarget.checked
                              ? [...state.judgment.evidenceChecks, value]
                              : state.judgment.evidenceChecks.filter(
                                  (item) => item !== value,
                                ),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <label htmlFor={memoId} className="cx-sr">
                  메모 (선택)
                </label>
                <textarea
                  id={memoId}
                  ref={memoRef}
                  name="memo"
                  rows={2}
                  placeholder="메모 (선택)"
                  disabled={!editable}
                  value={state.judgment.memo}
                  aria-describedby={`${memoId}-count ${errorId}`}
                  aria-invalid={
                    issues.some((issue) => issue.field === "memo") || undefined
                  }
                  onChange={(event) =>
                    edit({ memo: event.currentTarget.value })
                  }
                />
                <p
                  id={`${memoId}-count`}
                  className="cx-ro cx-count"
                  data-over={memoCount > MEMO_LIMIT || undefined}
                >
                  {memoCount.toLocaleString("ko-KR")} /{" "}
                  {MEMO_LIMIT.toLocaleString("ko-KR")}자
                </p>
                </div>
              </details>
              <div
                id={errorId}
                role="status"
                className="cx-note"
                data-tone="bad"
              >
                {issues
                  .filter((issue) => issue.field !== "userJudgment")
                  .map((issue) => issue.message)
                  .join(" ")}
              </div>
              <button
                type="button"
                className="cx-primary cx-submit"
                disabled={!editable}
                onClick={send}
              >
                제출값 확인
              </button>
            </>
          )}
          <p id={`${hintId}-submit`} className="cx-sr">
            연결이 끊겨도 같은 제출은 한 번만 접수됩니다. 가려진 시간은
            미리보기이며, 최종 확인은 서버가 합니다.
          </p>
          {view && !(review && submission.state.phase === "sending") && (
            <div
              className="cx-sub"
              data-busy={view.busy || undefined}
              data-testid="cx-submission"
              data-state={settled?.state ?? submission.state.phase}
            >
              <h3 ref={settledRef} tabIndex={-1}>
                {view.title}
              </h3>
              <p role={view.alert ? "alert" : "status"}>{view.message}</p>
              {view.note && <p className="cx-note">{view.note}</p>}
              {view.fieldErrors.length > 0 && (
                <ul>
                  {view.fieldErrors.map((error) => (
                    <li key={error.field}>
                      {error.label}: {error.reason}
                    </li>
                  ))}
                </ul>
              )}
              {!view.busy && submission.volatileId && (
                <p className="cx-note">
                  브라우저 저장소를 쓸 수 없어 새로고침하면 이 제출의 접수
                  여부를 다시 확인할 수 없습니다.
                </p>
              )}
              {view.actions.length > 0 && (
                <div className="cx-actions">
                  {view.actions.map((action) => (
                    <button
                      key={action}
                      type="button"
                      className={
                        action === "dismiss" ? "cx-link" : "cx-secondary"
                      }
                      onClick={() => act(action)}
                    >
                      {ACTION_LABEL[action]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {stage === 1 && !view && (
            <OtherSubmissions
              context={context}
              submission={submission}
              onSend={() => onSend(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * One line under the result title: the signal by its star-panel name and
 * its numbers ("행성 1 · WASP-62 b · 주기 4.412일 · 깊이 1.32%"), or what to
 * try after a miss. Words and numbers from ../analysis/format.ts.
 */
function resultLead(
  receipt: SubmissionReceipt,
  outcome: AnalysisOutcome,
  planetIds: string[] | null,
): string {
  const signal = receipt.explanation.signal;
  switch (outcome.kind) {
    case "numericMismatch":
      return f.notMatchedHint(receipt.explanation.missHint);
    case "ambiguous":
      return "주기나 구간을 조금 바꿔 다시 풀어 보세요.";
    case "noCandidate":
    case "skipped":
      return f.matchSentence(receipt.matchStatus);
  }
  if (!signal) return f.matchSentence(receipt.matchStatus);
  const planet = isMemberPlanet(signal, receipt.submissionId, planetIds);
  const name = matchedSignalLabel({
    signal,
    planet,
    planetIds,
    matchedIds: receipt.progress.matchedCandidateIds,
    withPeriodDays: false,
  });
  return [
    name,
    `주기 ${f.periodDays(signal.bls.periodDays, 3)}`,
    `깊이 ${f.depthPercent(signal.bls.depthPpm)}`,
  ].join(" · ");
}

/**
 * The result's actions, at most two buttons (as in the result dialog):
 * after a window that matched nothing "구간 다시 잡기" (period kept) and
 * "주기 다시 고르기"; otherwise "이번 제출 결과" and, while the star has
 * more to find, "다음 곡선 단계로". "은하로 돌아가기" is a small link; the rest
 * (별 결과, 공개 검토, 토론) is in the result dialog.
 */
function ResultActions({
  receipt,
  kind,
  nextCurve,
  onDetails,
  onAgain,
}: {
  receipt: SubmissionReceipt;
  kind: AnalysisOutcome["kind"];
  nextCurve?: () => void;
  onDetails(): void;
  onAgain(step: 1 | 2): void;
}) {
  const { currentPath } = usePageContext();
  const publish = receipt.nextActions.includes("PUBLISH_ANALYSIS");
  const publishUrl = pagePath("publicationBatch", {}, { ticId: receipt.ticId, returnTo: currentPath });
  const details = (className: string) => (
    <button
      type="button"
      className={className}
      // The discovery card's "이번 제출 결과" opens this same view.
      data-result-details=""
      onClick={onDetails}
    >
      이번 제출 결과
    </button>
  );
  const next =
    receipt.nextActions.includes("NEXT_CURVE") &&
    nextCurve &&
    receipt.progress.stage !== "completed" ? (
      <button type="button" className="cx-primary" onClick={nextCurve}>
        분석 이어서 하기
      </button>
    ) : null;
  const missed = kind === "numericMismatch";
  const ambiguous = kind === "ambiguous";
  return (
    <>
      {next && <p className="cx-note">분석 기록은 나중에 모아서 공개할 수 있습니다.</p>}
      <div className="cx-actions cx-result-flow" data-testid="cx-result-actions">
        <Link className="cx-secondary cx-result-home" to="/sky">나의 은하로</Link>
        {missed ? (
          <>
            <button
              type="button"
              className="cx-primary"
              onClick={() => onAgain(2)}
            >
              구간 다시 잡기
            </button>
            <button
              type="button"
              className="cx-secondary"
              onClick={() => onAgain(1)}
            >
              주기 다시 고르기
            </button>
          </>
        ) : ambiguous ? (
          <button
            type="button"
            className="cx-primary"
            onClick={() => onAgain(1)}
          >
            주기 다시 고르기
          </button>
        ) : (
          <>
            {publish && <Link className={next ? "cx-secondary" : "cx-primary"} to={publishUrl}>{next ? "공개 검토" : "이 별의 분석 공개 검토"}</Link>}
            {next}
            {!publish && !next && details("cx-primary")}
          </>
        )}
      </div>
      <p className="cx-next">
        {details("cx-link")}
      </p>
    </>
  );
}

/** EXP-12 제출값 확인: what will be sent, before the irreversible send. */
function ReviewBlock({
  review,
  headingRef,
  locked,
  sending,
  hintId,
  onEdit,
  onSend,
}: {
  review: CandidateReview;
  headingRef: RefObject<HTMLHeadingElement | null>;
  locked: boolean;
  sending: boolean;
  hintId: string;
  onEdit(): void;
  onSend(): void;
}) {
  const { selection, userJudgment, evidenceChecks, memo } = review.input;
  return (
    <div className="cx-review" data-testid="cx-review">
      <h3 ref={headingRef} tabIndex={-1} className="cx-sr">
        제출값 확인
      </h3>
      <dl className="cx-review-list">
        <dt>주기</dt>
        <dd title={String(selection.periodDays)}>
          <b>{format.period(selection.periodDays)}</b>일
        </dd>
        <dt>선택 위상</dt>
        <dd>
          <b>
            {format.phase(selection.phaseStart)}–
            {format.phase(selection.phaseEnd)}
          </b>
        </dd>
        <dt>가려진 시간</dt>
        <dd>
          <b>{format.hours(review.durationPreviewHours)}</b>시간
        </dd>
        <dt>판단</dt>
        <dd>
          {judgments.find(({ value }) => value === userJudgment)?.label ?? "—"}
        </dd>
        <dt>근거</dt>
        <dd>
          {evidenceChecks
            .map(
              (item) =>
                evidenceOptions.find(({ value }) => value === item)?.label,
            )
            .join(", ") || "선택 안 함"}
        </dd>
        <dt>메모</dt>
        <dd className="cx-review-memo">{memo || "입력 안 함"}</dd>
      </dl>

      <div className="cx-actions">
        <button
          type="button"
          className="cx-secondary"
          disabled={locked}
          onClick={onEdit}
        >
          판단·메모 수정
        </button>
        <button
          type="button"
          className="cx-primary"
          disabled={locked}
          aria-describedby={`${hintId}-submit`}
          onClick={onSend}
        >
          <span role="status">{sending ? "제출 중…" : "제출하기"}</span>
        </button>
      </div>
    </div>
  );
}

const confirmText: Record<"no_candidate" | "skipped", string> = {
  no_candidate:
    "이 별에 더 이상 후보가 없다고 제출합니다. 선택·판단·근거는 함께 보내지 않으며 되돌릴 수 없습니다.",
  skipped:
    "이 별을 건너뜁니다. 선택·판단·근거는 함께 보내지 않으며 되돌릴 수 없습니다.",
};

/** 더 이상 없음 · 건너뛰기, asked once more like the classic. */
function OtherSubmissions({
  context,
  submission,
  onSend,
}: {
  context: AnalysisContext;
  submission: Submission;
  onSend: () => void;
}) {
  const hintId = useId();
  const headingId = useId();
  const options = specialSubmissions(context);
  const busy = submission.state.phase !== "idle";
  const [asking, setAsking] = useState<"no_candidate" | "skipped" | null>(null);
  const dialogRef = useModalDialog({
    open: asking !== null,
    onClose: () => setAsking(null),
  });
  const send = () => {
    if (!asking) return;
    const kind = asking;
    setAsking(null);
    onSend();
    void submission.submit(
      kind === "no_candidate"
        ? noCandidateInput(context.curveContext)
        : skippedInput(context.curveContext),
    );
  };
  return (
    <div className="cx-other">
      <p id={hintId} className="cx-sr">
        이 별에서 더 찾을 것이 없거나 지금은 넘어가고 싶다면 아래를 선택하세요.
        선택·판단·근거는 함께 보내지 않습니다.
      </p>
      <span className="cx-ro">다른 선택</span>
      {options.map((option) => (
        <button
          key={option.kind}
          type="button"
          className="cx-link"
          disabled={busy || option.unavailable !== null}
          aria-describedby={hintId}
          title={option.unavailable ?? undefined}
          onClick={() => setAsking(option.kind)}
        >
          {option.label}
        </button>
      ))}
      {options.some((option) => option.unavailable) && (
        // Disabled buttons say why on hover (title) and to screen readers;
        // a standing line of refusals under every step is noise.
        <p className="cx-sr">
          {options
            .filter((option) => option.unavailable)
            .map((option) => `${option.label}: ${option.unavailable}`)
            .join(" · ")}
        </p>
      )}
      <dialog
        ref={dialogRef}
        className="cx-dialog cx-confirm"
        data-testid="cx-submission-confirm"
        aria-labelledby={headingId}
      >
        <h2 id={headingId}>
          {asking === "skipped"
            ? "이 별을 건너뛸까요?"
            : "더 이상 없다고 보낼까요?"}
        </h2>
        <p>{asking ? confirmText[asking] : null}</p>
        <div className="cx-actions" hidden={!asking}>
          <button
            type="button"
            className="cx-secondary"
            autoFocus
            onClick={() => setAsking(null)}
          >
            취소
          </button>
          <button type="button" className="cx-primary" onClick={send}>
            보내기
          </button>
        </div>
      </dialog>
    </div>
  );
}
