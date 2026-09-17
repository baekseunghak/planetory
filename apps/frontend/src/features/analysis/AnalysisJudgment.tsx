import { useEffect, useId, useRef, useState } from "react";
import type { AnalysisContext } from "./analysis-data";
import { useAnalysisFold, usePhaseDraft } from "./AnalysisSession";
import {
  createCandidateReview,
  evidenceOptions,
  judgments,
  validateJudgment,
  memoCodePoints,
  PROVISIONAL_MEMO_LIMIT,
  type JudgmentDraft,
  type PeriodogramViewport,
} from "./analysis-judgment";
import type { SelectionIssue } from "./selection-rules";
import "./analysis-judgment.css";

export function AnalysisSteps() {
  const session = useAnalysisFold();
  const { state, ready } = usePhaseDraft();
  const current = !session.state.change
    ? 0
    : !ready || !state.range
      ? 1
      : !state.confirmed || state.confirmed !== state.preview || state.dragging
        ? 2
        : state.review
          ? 4
          : 3;
  return (
    <ol className="analysis-steps" aria-label="분석 단계">
      {["봉우리 선택", "주기 맞추기", "구간 선택", "판단", "제출값 확인"].map(
        (label, index) => (
          <li key={label} aria-current={current === index ? "step" : undefined}>
            {index + 1}. {label}
            {current === index ? " (현재)" : ""}
          </li>
        ),
      )}
    </ol>
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
  const [issues, setIssues] = useState<SelectionIssue[]>([]);
  const headingId = useId(),
    hintId = useId(),
    memoId = useId(),
    errorId = useId();
  const judgmentRef = useRef<HTMLInputElement>(null);
  const memoRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useRef<"judgment" | "review" | null>(null);
  const preview = state.preview?.kind === "preview" ? state.preview : null;
  const confirmed = !!preview && state.confirmed === preview && !state.dragging;
  const enabled = ready && confirmed;
  const review = enabled ? state.review : null;
  // Move focus only after an explicit next/back action, never on graph updates.
  useEffect(() => {
    if (!enabled) return;
    if (focusAfterRender.current === "review" && review)
      reviewRef.current?.focus();
    else if (focusAfterRender.current === "judgment" && !review)
      judgmentRef.current?.focus();
    else return;
    focusAfterRender.current = null;
  });
  const edit = (patch: Partial<JudgmentDraft>) => {
    if (!enabled) return;
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
    setState((previous) => ({ ...previous, confirmed: preview, review: null }));
  };
  const showReview = () => {
    if (!enabled || !preview) return;
    const errors = validateJudgment(state.judgment);
    setIssues(errors);
    if (errors.length) {
      if (errors[0].field === "memo") memoRef.current?.focus();
      else judgmentRef.current?.focus();
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
      setState((previous) => ({ ...previous, review: next }));
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
      <h3 id={headingId}>판단과 제출값 확인</h3>
      <p id={hintId}>
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
      <button
        type="button"
        disabled={!ready || !preview || state.dragging || confirmed}
        aria-describedby={hintId}
        onClick={confirm}
      >
        구간 확정하고 판단하기
      </button>
      {!review && (
        <form
          noValidate
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            showReview();
          }}
        >
          <fieldset disabled={!enabled} aria-describedby={hintId}>
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
          <fieldset disabled={!enabled}>
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
          <label htmlFor={memoId}>메모 (선택)</label>
          <textarea
            id={memoId}
            ref={memoRef}
            name="memo"
            rows={3}
            disabled={!enabled}
            value={state.judgment.memo}
            aria-describedby={`${memoId}-hint ${errorId}`}
            aria-invalid={
              issues.some((issue) => issue.field === "memo") || undefined
            }
            onChange={(event) => edit({ memo: event.currentTarget.value })}
          />
          <p id={`${memoId}-hint`}>
            {memoCodePoints(state.judgment.memo).toLocaleString("ko-KR")} /{" "}
            {PROVISIONAL_MEMO_LIMIT.toLocaleString("ko-KR")}자. 초안은
            새로고침하거나 화면을 나가면 사라집니다.
          </p>
          <div id={errorId} role="status">
            {enabled &&
              issues
                .filter((issue) => issue.field !== "userJudgment")
                .map((issue) => <p key={issue.field}>{issue.message}</p>)}
          </div>
          <button type="submit" disabled={!enabled}>
            제출값 확인
          </button>
        </form>
      )}
      {review && (
        <div data-testid="candidate-review">
          <h4 ref={reviewRef} tabIndex={-1}>
            제출값 확인
          </h4>
          <dl>
            <dt>별</dt>
            <dd>TIC {review.ticId}</dd>
            <dt>자료·곡선 단계</dt>
            <dd>
              {review.input.curveContext.bundleId} ·{" "}
              {review.input.curveContext.curveStep}
            </dd>
            <dt>선택 주기 (일)</dt>
            <dd>{review.input.selection.periodDays}</dd>
            <dt>봉우리 출처</dt>
            <dd>
              {review.input.selection.sourcePeakGridIndex === null
                ? "직접 선택"
                : `격자 ${review.input.selection.sourcePeakGridIndex}`}
            </dd>
            <dt>선택 위상</dt>
            <dd>
              {review.input.selection.phaseStart} ~{" "}
              {review.input.selection.phaseEnd}
            </dd>
            <dt>기준 시각 미리보기 (BTJD)</dt>
            <dd>{review.epochPreviewBtjd}</dd>
            <dt>가려진 시간 미리보기 (시간)</dt>
            <dd>{review.durationPreviewHours}</dd>
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
                    evidenceOptions.find(({ value }) => value === item)?.label,
                )
                .join(", ") || "선택 안 함"}
            </dd>
            <dt>메모</dt>
            <dd className="analysis-memo-preview">
              {review.input.memo || "입력 안 함"}
            </dd>
          </dl>
          <p>
            아직 제출되지 않았습니다. 기준 시각과 가려진 시간은 미리보기이며,
            실제 제출 시 서버가 선택 주기·위상으로 다시 계산하고 검증합니다.
          </p>
          <p id={`${hintId}-submit`}>
            현재는 제출 API가 연결되지 않아 제출할 수 없습니다. 관측 공백을
            포함한 최종 선택 검증도 남아 있습니다.
          </p>
          <div className="periodogram-toolbar">
            <button
              type="button"
              onClick={() => {
                focusAfterRender.current = "judgment";
                setState((previous) => ({ ...previous, review: null }));
              }}
            >
              판단 수정
            </button>
            <button
              type="button"
              disabled
              aria-describedby={`${hintId}-submit`}
            >
              제출
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
