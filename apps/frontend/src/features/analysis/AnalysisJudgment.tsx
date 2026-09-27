import { stageLabels, useAnalysisStage } from "./analysis-stage";
import { OnboardingTip } from "../onboarding/Onboarding";
import { useSustained } from "./fold-progress";
import yesIcon from "./assets/yes.svg";
import noIcon from "./assets/no.svg";
import unsureIcon from "./assets/unsure.svg";
import { useEffect, useId, useRef, useState } from "react";
import type { AnalysisContext } from "./analysis-data";
import { useAnalysisFold, usePhaseDraft } from "./AnalysisSession";
import {
  createCandidateReview,
  evidenceOptions,
  judgments,
  validateJudgment,
  memoCodePoints,
  MEMO_LIMIT,
  type JudgmentDraft,
  type PeriodogramViewport,
} from "./analysis-judgment";
import type { SelectionIssue } from "./selection-rules";
import { useSubmission } from "./use-submission";
import { SpecialSubmissions, SubmissionStatus } from "./AnalysisSubmission";
import { candidateInput } from "./submission-input";
import { useCinemaCopy } from "./cinema-copy";
import "./analysis-judgment.css";

export function AnalysisSteps() {
  const fold = useAnalysisFold();
  const { stage, go, ready, confirmed } = useAnalysisStage();
  return (
    <>
      <OnboardingTip step={stage as 1 | 2 | 3 | 4} />
      <ol className="analysis-steps" aria-label="분석 단계">
        {stageLabels.map((label, index) => (
          <li
            key={label}
            aria-current={stage === index + 1 ? "step" : undefined}
          >
            <button
              type="button"
              disabled={
                index === 0
                  ? !fold.state.change
                  : !ready ||
                    index === 3 ||
                    (index === 1 && stage < 2) ||
                    (index === 2 && !confirmed)
              }
              onClick={() => go((index + 1) as 1 | 2 | 3)}
            >
              {index + 1 < stage ? "✓" : index + 1} {label}
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

export function AnalysisJudgment({
  context,
  getViewport,
}: {
  context: AnalysisContext;
  getViewport: () => PeriodogramViewport;
}) {
  const { state, setState, ready } = usePhaseDraft();
  const fold = useAnalysisFold();
  const { stage, go } = useAnalysisStage();
  const [issues, setIssues] = useState<SelectionIssue[]>([]);
  const headingId = useId(),
    hintId = useId(),
    memoId = useId(),
    errorId = useId();
  const stageRef = useRef<HTMLHeadingElement>(null);
  const judgmentRef = useRef<HTMLInputElement>(null);
  const memoRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useRef<"judgment" | "review" | "range" | null>(null);
  const preview = state.preview?.kind === "preview" ? state.preview : null;
  const confirmed = !!preview && state.confirmed === preview && !state.dragging;
  const enabled = ready && confirmed && stage >= 3;
  // 미세 조정 한 번의 접기는 10ms 남짓이라 !ready를 그대로 쓰면 슬라이더를 끄는
  // 동안 버튼이 프레임마다 깜빡인다. 잠금 자체는 go()가 즉시 하므로 잠긴 모습은
  // 진행 안내가 뜨는 시점과 같게 늦춘다. 실패·취소는 pending이 아니므로 즉시 잠근다.
  const pending = fold.state.status === "pending";
  const slowPending = useSustained(pending);
  const blocked = !ready && (!pending || slowPending);
  const review = enabled ? state.review : null;
  const submission = useSubmission(context);
  // 시네마 화면: 주기 3자리, 위상 3자리, 가려진 시간 1자리. BTJD 기준 시각은
  // 제출값 확인의 「계산·제출 안내」 안에만 둔다.
  const cinema = useCinemaCopy();
  // 잠겨도 제출값 확인 화면은 남겨야 한다. 접수 결과를 그 자리에서 보여 주고,
  // 결과를 모르는 동안 무엇을 보냈는지 사용자가 볼 수 있어야 한다.
  const editable = enabled && !submission.locked;
  // Move focus only after an explicit next/back action, never on graph updates.
  useEffect(() => {
    if (focusAfterRender.current === "range" && stage === 2) {
      stageRef.current?.focus();
      focusAfterRender.current = null;
      return;
    }
    if (!enabled) return;
    if (focusAfterRender.current === "review" && review)
      reviewRef.current?.focus();
    else if (focusAfterRender.current === "judgment" && !review)
      judgmentRef.current?.focus();
    else return;
    focusAfterRender.current = null;
  });
  const edit = (patch: Partial<JudgmentDraft>) => {
    if (!editable) return;
    setIssues([]);
    setState((previous) => ({
      ...previous,
      judgment: { ...previous.judgment, ...patch },
      review: null,
    }));
  };
  const confirm = () => {
    if (!ready || !preview || state.dragging) return;
    setIssues([]);
    focusAfterRender.current = "judgment";
    setState((previous) => ({
      ...previous,
      editingStep: undefined,
      confirmed: preview,
      review: null,
    }));
  };
  const showReview = () => {
    if (!enabled || !preview) return;
    const errors = validateJudgment(state.judgment);
    setIssues(errors);
    if (errors.length) {
      if (errors[0].field === "memo") {
        const details = memoRef.current?.closest("details");
        if (details) details.open = true;
        memoRef.current?.focus();
      } else judgmentRef.current?.focus();
      return;
    }
    try {
      const next = createCandidateReview(
        context.ticId,
        context.curveContext,
        preview,
        state.judgment,
        getViewport(),
        fold.state.view.zoom,
      );
      focusAfterRender.current = "review";
      setState((previous) => ({
        ...previous,
        editingStep: undefined,
        review: next,
      }));
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
  return (
    <section className="analysis-judgment" aria-labelledby={headingId}>
      <h3 ref={stageRef} tabIndex={-1} id={headingId}>
        {stageLabels[stage - 1]}
      </h3>
      {stage === 1 && (
        <>
          <p>
            주기도의 봉우리를 클릭해 주기를 고르고, 밝기가 낮아지는 부분이
            겹치도록 아래 슬라이더로 조절하세요. 봉우리는 몇 번이든 다시 고를 수
            있습니다.
          </p>
          {fold.state.change && (
            <>
              {cinema ? (
                <p>
                  현재 주기{" "}
                  {cinema.format.periodDays(
                    fold.state.change.selection.periodDays,
                    3,
                  )}
                </p>
              ) : (
                <p>
                  현재 주기 {fold.state.change.selection.periodDays.toFixed(6)}
                  일
                </p>
              )}
              <button
                disabled={blocked}
                onClick={() => {
                  focusAfterRender.current = "range";
                  go(2);
                }}
              >
                이 주기로 구간 선택
              </button>
            </>
          )}
          <SpecialSubmissions context={context} submission={submission} />
          <SubmissionStatus submission={submission} />
        </>
      )}
      <p id={hintId} className={stage !== 2 ? "analysis-sr-only" : undefined}>
        {!ready
          ? "주기를 선택하고 접기 계산을 마치면 구간을 확정할 수 있습니다."
          : !preview
            ? "유효한 위상 구간을 선택해 주세요."
            : state.dragging
              ? "구간 조정을 마친 뒤 확정해 주세요."
              : !confirmed
                ? "구간을 확인한 뒤 확정해 주세요. 작성한 판단·근거·메모는 유지됩니다."
                : "판단을 하나 선택하세요. 근거와 메모는 선택 사항입니다. 구간을 바꾸면 다시 확인해야 합니다."}
      </p>
      {stage === 2 && (
        <>
          <p>
            접힌 곡선에서 드래그해 구간을 고르세요. 양 끝 핸들로 범위를 조절할
            수 있어요.
          </p>
          {state.preview?.kind === "invalid" && (
            <p role="status">{state.message}</p>
          )}
          {cinema ? (
            <>
              <p>
                선택 위상{" "}
                {(state.range &&
                  cinema.format.phaseRange(
                    state.range.phaseStart,
                    state.range.phaseEnd,
                  )) ??
                  "—"}
              </p>
              <p>
                가려진 시간{" "}
                {cinema.format.hours(preview?.durationPreviewHours) ?? "—"}
              </p>
            </>
          ) : (
            <>
              <p>
                선택 위상{" "}
                {state.range
                  ? `${state.range.phaseStart.toFixed(4)}–${state.range.phaseEnd.toFixed(4)}`
                  : "—"}
              </p>
              <p>
                기준 시각 {preview?.epochPreviewBtjd.toFixed(6) ?? "—"} BTJD
                <br />
                가려진 시간 {preview?.durationPreviewHours.toFixed(4) ??
                  "—"}{" "}
                시간
              </p>
            </>
          )}
          <button
            type="button"
            disabled={!ready || !preview || state.dragging}
            aria-describedby={hintId}
            onClick={confirm}
          >
            구간 확정하고 판단하기
          </button>
        </>
      )}
      {
        <form
          hidden={stage !== 3 || !!review}
          noValidate
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            showReview();
          }}
        >
          <fieldset
            className="judgment-options"
            disabled={!editable}
            aria-describedby={hintId}
          >
            <legend>판단 (필수)</legend>
            {judgments.map(({ value, label }, index) => (
              <label className="analysis-choice" key={value}>
                <input
                  ref={index === 0 ? judgmentRef : undefined}
                  type="radio"
                  name="userJudgment"
                  value={value}
                  required
                  checked={state.judgment.userJudgment === value}
                  aria-invalid={
                    issues.some((issue) => issue.field === "userJudgment") ||
                    undefined
                  }
                  aria-describedby={`${errorId}-judgment`}
                  onChange={() => edit({ userJudgment: value })}
                />
                <img
                  src={[yesIcon, noIcon, unsureIcon][index]}
                  alt=""
                  width="24"
                  height="24"
                />
                {label}
              </label>
            ))}
            <div id={`${errorId}-judgment`} role="status">
              {enabled &&
                issues
                  .filter((issue) => issue.field === "userJudgment")
                  .map((issue) => <p key={issue.field}>{issue.message}</p>)}
            </div>
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>확인한 근거 (선택)</legend>
            {evidenceOptions.map(({ value, label }) => (
              <label className="analysis-choice" key={value}>
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
            <p>중심 위치: 데이터 없음 (근거로 선택할 수 없음)</p>
          </fieldset>
          <details className="memo-details">
            <summary>＋ 메모 추가 · 최대 200자</summary>
            <label htmlFor={memoId}>메모 (선택)</label>
            <textarea
              id={memoId}
              ref={memoRef}
              name="memo"
              rows={3}
              disabled={!editable}
              value={state.judgment.memo}
              aria-describedby={`${memoId}-hint ${errorId}`}
              aria-invalid={
                issues.some((issue) => issue.field === "memo") || undefined
              }
              onChange={(event) => edit({ memo: event.currentTarget.value })}
            />
            <p id={`${memoId}-hint`}>
              {memoCodePoints(state.judgment.memo).toLocaleString("ko-KR")} /{" "}
              {MEMO_LIMIT.toLocaleString("ko-KR")}자. 초안 저장 상태는 위의 분석
              초안 안내에서 확인할 수 있습니다.
            </p>
          </details>
          <div id={errorId} role="status">
            {enabled &&
              issues
                .filter((issue) => issue.field !== "userJudgment")
                .map((issue) => <p key={issue.field}>{issue.message}</p>)}
          </div>
          <button type="submit" disabled={!editable}>
            제출값 확인
          </button>
        </form>
      }
      {review && (
        <div data-testid="candidate-review">
          <h4 className="analysis-sr-only" ref={reviewRef} tabIndex={-1}>
            제출값 확인
          </h4>
          <p>주기와 선택 구간, 작성한 판단을 마지막으로 확인하세요.</p>
          {cinema ? (
            <dl>
              <dt>주기</dt>
              <dd title={String(review.input.selection.periodDays)}>
                {cinema.format.periodDays(review.input.selection.periodDays, 3)}
              </dd>
              <dt>선택 위상</dt>
              <dd>
                {cinema.format.phaseRange(
                  review.input.selection.phaseStart,
                  review.input.selection.phaseEnd,
                )}
              </dd>
              <dt>가려진 시간</dt>
              <dd>{cinema.format.hours(review.durationPreviewHours)}</dd>
              <dt>판단</dt>
              <dd>
                {
                  judgments.find(
                    ({ value }) => value === review.input.userJudgment,
                  )?.label
                }
              </dd>
              <dt>근거</dt>
              <dd>
                {review.input.evidenceChecks
                  .map(
                    (item) =>
                      evidenceOptions.find(({ value }) => value === item)
                        ?.label,
                  )
                  .join(", ") || "선택 안 함"}
              </dd>
              <dt>메모</dt>
              <dd className="analysis-memo-preview">
                {review.input.memo || "입력 안 함"}
              </dd>
            </dl>
          ) : (
            <dl>
              <dt>주기</dt>
              <dd title={String(review.input.selection.periodDays)}>
                {review.input.selection.periodDays.toFixed(6)}일
              </dd>
              <dt>선택 위상</dt>
              <dd>
                {review.input.selection.phaseStart.toFixed(4)}–
                {review.input.selection.phaseEnd.toFixed(4)}
              </dd>
              <dt>기준 시각</dt>
              <dd title={String(review.epochPreviewBtjd)}>
                {review.epochPreviewBtjd.toFixed(6)} BTJD
              </dd>
              <dt>가려진 시간</dt>
              <dd title={String(review.durationPreviewHours)}>
                {review.durationPreviewHours.toFixed(4)} 시간
              </dd>
              <dt>판단</dt>
              <dd>
                {
                  judgments.find(
                    ({ value }) => value === review.input.userJudgment,
                  )?.label
                }
              </dd>
              <dt>근거</dt>
              <dd>
                {review.input.evidenceChecks
                  .map(
                    (item) =>
                      evidenceOptions.find(({ value }) => value === item)
                        ?.label,
                  )
                  .join(", ") || "선택 안 함"}
              </dd>
              <dt>메모</dt>
              <dd className="analysis-memo-preview">
                {review.input.memo || "입력 안 함"}
              </dd>
            </dl>
          )}
          {cinema ? (
            <details className="review-details">
              <summary>계산·제출 안내</summary>
              <p>
                아직 제출되지 않았습니다. 가려진 시간은 미리보기이며, 제출하면
                서버가 고른 주기와 구간으로 다시 계산해 확인합니다.
              </p>
              <p id={`${hintId}-submit`}>
                연결이 끊겨도 같은 제출은 한 번만 접수됩니다.
              </p>
              <p>
                기준 시각 {cinema.format.referenceTime(review.epochPreviewBtjd)}{" "}
                (TESS 관측 시각, 일)
              </p>
            </details>
          ) : (
            <details className="review-details">
              <summary>계산·제출 안내</summary>
              <p>
                아직 제출되지 않았습니다. 기준 시각과 가려진 시간은
                미리보기이며, 실제 제출 시 서버가 선택 주기·위상으로 다시
                계산하고 검증합니다.
              </p>
              <p id={`${hintId}-submit`}>
                제출하면 요청 번호 하나로 접수를 추적합니다. 응답을 받지 못해도
                같은 번호로 결과를 확인하므로 두 번 접수되지 않습니다. 관측
                공백을 포함한 최종 선택 검증은 서버가 합니다.
              </p>
            </details>
          )}
          <div className="periodogram-toolbar">
            <button
              type="button"
              disabled={submission.locked}
              onClick={() => {
                focusAfterRender.current = "judgment";
                setState((previous) => ({ ...previous, review: null }));
              }}
            >
              판단·메모 수정 →
            </button>
            <button
              type="button"
              disabled={submission.locked}
              aria-describedby={`${hintId}-submit`}
              onClick={() => submission.submit(candidateInput(review))}
            >
              제출하기
            </button>
          </div>
          <SubmissionStatus submission={submission} />
        </div>
      )}
    </section>
  );
}
