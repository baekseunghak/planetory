import { useEffect, useId, useRef } from "react";
import type { AnalysisContext } from "./analysis-data";
import {
  noCandidateInput,
  skippedInput,
  specialSubmissions,
} from "./submission-input";
import type { MatchStatus } from "./submission-data";
import type { useSubmission } from "./use-submission";

type Submission = ReturnType<typeof useSubmission>;

const matchSummary: Record<MatchStatus, string> = {
  matched: "신호와 일치했습니다.",
  matched_harmonic: "신호의 배수 주기와 일치했습니다.",
  not_matched: "일치하는 신호를 찾지 못했습니다.",
  duplicate: "이미 찾은 신호입니다.",
  ambiguous_match: "어느 신호인지 가리지 못했습니다.",
  none_wrong: "더 이상 없음으로 접수했습니다.",
  skipped: "이 별을 건너뛰었습니다.",
};

/**
 * 제출 상태를 한 곳에서 알린다. 색만으로 구분하지 않으며 문구와 포커스 이동이
 * 1차 신호다. 결과 해설(A06-2)이 아니라 **접수 사실**만 다룬다.
 */
export function SubmissionStatus({ submission }: { submission: Submission }) {
  const { state, volatileId } = submission;
  const headingId = useId();
  const focusRef = useRef<HTMLParagraphElement>(null);
  const settled = state.phase === "settled";
  // 결과가 정해진 순간에만 옮긴다. 진행 중 갱신으로는 옮기지 않는다.
  useEffect(() => {
    if (settled) focusRef.current?.focus();
  }, [settled, state]);

  if (state.phase === "idle") return null;
  if (state.phase === "sending" || state.phase === "checking")
    return (
      <p className="submission-progress" role="status">
        {state.phase === "sending"
          ? "제출하고 있습니다. 창을 닫지 말아 주세요."
          : "접수 결과를 확인하고 있습니다."}
      </p>
    );

  if (state.state === "accepted")
    return (
      <section className="submission-receipt" aria-labelledby={headingId}>
        <h4 id={headingId}>접수되었습니다</h4>
        <p ref={focusRef} tabIndex={-1} role="status">
          {acceptedNotice(state.recovered, state.receipt.outcome)}{" "}
          {matchSummary[state.receipt.matchStatus]}
        </p>
        <dl>
          <dt>접수 번호</dt>
          <dd>{state.receipt.submissionId}</dd>
          <dt>기록 번호</dt>
          <dd>{state.receipt.historyId}</dd>
          <dt>접수 시각</dt>
          <dd>
            <time dateTime={state.receipt.submittedAt}>
              {new Date(state.receipt.submittedAt).toLocaleString("ko-KR")}
            </time>
          </dd>
        </dl>
        <p className="submission-note">
          자세한 결과 풀이와 다음 단계는 아직 연결되지 않았습니다.
        </p>
      </section>
    );

  if (state.state === "unresolved")
    return (
      <section className="submission-unresolved" aria-labelledby={headingId}>
        <h4 id={headingId}>접수 여부를 확인해 주세요</h4>
        {/* 404를 근거로 "제출되지 않았습니다"라고 단정하지 않는다. */}
        <p ref={focusRef} tabIndex={-1} role="alert">
          {state.message}
        </p>
        <button type="button" onClick={() => submission.check()}>
          접수 결과 확인
        </button>
      </section>
    );

  // 남은 것은 거절이다. 어느 쪽이든 접수는 일어나지 않았다.
  const guide =
    state.state === "bundle-changed"
      ? "별의 데이터 판이 바뀌었습니다. 최신 자료를 다시 불러온 뒤 주기와 구간을 다시 골라 주세요."
      : state.state === "expired"
        ? "로그인이 만료되었습니다. 다시 로그인한 뒤 제출해 주세요."
        : state.message;
  return (
    <section className="submission-failure" aria-labelledby={headingId}>
      <h4 id={headingId}>제출하지 못했습니다</h4>
      <p ref={focusRef} tabIndex={-1} role="alert">
        {guide}
      </p>
      {state.state === "rejected" && state.fieldErrors.length > 0 && (
        <ul>
          {state.fieldErrors.map((error) => (
            <li key={error.field}>
              {fieldLabel(error.field)}: {error.reason}
            </li>
          ))}
        </ul>
      )}
      {volatileId && (
        <p className="submission-note">
          브라우저 저장소를 쓸 수 없어 이 요청 번호는 새로고침하면 사라집니다.
        </p>
      )}
      <button type="button" onClick={submission.dismiss}>
        입력으로 돌아가기
      </button>
    </section>
  );
}

/**
 * 접수 경위를 있는 그대로 알린다. 복구했다고 해서 늘 「이미 접수돼 있던」
 * 것은 아니다. 조회가 미접수를 알려 같은 번호로 다시 보내 이번에 접수된
 * 경우도 있다. 둘을 같은 문구로 뭉치면 무슨 일이 있었는지 알 수 없다.
 */
function acceptedNotice(recovered: boolean, outcome: "created" | "replayed") {
  if (!recovered)
    return outcome === "created"
      ? "제출이 접수되었습니다."
      : "같은 내용이 이미 접수돼 있어 그 결과를 그대로 보여 줍니다.";
  return outcome === "created"
    ? "응답을 받지 못해 다시 확인했고, 이번에 접수되었습니다."
    : "이미 접수돼 있던 제출을 확인했습니다. 다시 접수되지 않았습니다.";
}

// 서버가 주는 필드 경로를 화면의 말로 바꾼다. 모르는 경로는 그대로 보여 준다.
function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    "selection.periodDays": "주기",
    "selection.phaseStart": "구간 시작",
    "selection.phaseEnd": "구간 끝",
    "selection.sourcePeakGridIndex": "선택한 봉우리",
    selection: "선택 구간",
    userJudgment: "판단",
    evidenceChecks: "근거",
    memo: "메모",
    curveContext: "분석 자료 상태",
    requestId: "요청 번호",
  };
  return labels[field] ?? field;
}

/**
 * 더 없음·건너뛰기. 후보 제출과 달리 선택·판단·근거를 보내지 않으므로
 * 제출값 확인 단계를 거치지 않는다. 되돌릴 수 없으므로 한 번 더 묻는다.
 */
export function SpecialSubmissions({
  context,
  submission,
}: {
  context: AnalysisContext;
  submission: Submission;
}) {
  const hintId = useId();
  const options = specialSubmissions(context);
  const busy = submission.state.phase !== "idle";
  return (
    <div className="submission-alternatives">
      <p id={hintId}>
        이 별에서 더 찾을 것이 없거나 지금은 넘어가고 싶다면 아래를 선택하세요.
        선택·판단·근거는 함께 보내지 않습니다.
      </p>
      {options.map((option) => (
        <p key={option.kind}>
          <button
            type="button"
            disabled={busy || option.unavailable !== null}
            aria-describedby={hintId}
            onClick={() => {
              if (
                !window.confirm(
                  option.kind === "no_candidate"
                    ? "이 별에 더 이상 후보가 없다고 제출할까요? 되돌릴 수 없습니다."
                    : "이 별을 건너뛸까요? 되돌릴 수 없습니다.",
                )
              )
                return;
              submission.submit(
                option.kind === "no_candidate"
                  ? noCandidateInput(context.curveContext)
                  : skippedInput(context.curveContext),
              );
            }}
          >
            {option.label}
          </button>
          {option.unavailable && (
            <span className="submission-note"> {option.unavailable}</span>
          )}
        </p>
      ))}
    </div>
  );
}
