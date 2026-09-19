import { useEffect, useId, useRef, useState } from "react";
import { useModalDialog } from "./use-modal-dialog";
import { useBundleRecovery } from "./AnalysisSession";
import { acceptedOnOlderBundle } from "./submission-data";
import { ResultExplanationView } from "./AnalysisResult";
import type { AnalysisContext } from "./analysis-data";
import {
  noCandidateInput,
  skippedInput,
  specialSubmissions,
} from "./submission-input";
import type { useSubmission } from "./use-submission";

type Submission = ReturnType<typeof useSubmission>;

/**
 * 제출 상태를 한 곳에서 알린다. 색만으로 구분하지 않으며 문구와 포커스 이동이
 * 1차 신호다. 결과 해설(A06-2)이 아니라 **접수 사실**만 다룬다.
 */
/**
 * 제출 결과를 가운데 대화상자로 보여 준다. 되돌릴 수 없는 동작의 결과이므로
 * 화면 구석이 아니라 한가운데에서 읽게 한다. 좁은 오른쪽 패널에 접수 번호와
 * 안내를 욱여넣지 않아도 되고, 결과 해설(A06-2)이 붙을 자리도 여기가 된다.
 *
 * 네이티브 `<dialog>`의 `showModal()`을 쓴다. 포커스 가둠·Escape·배경 비활성을
 * 브라우저가 처리하며 저장소의 다른 대화상자와 같은 방식이다.
 */
/**
 * 잔차 준비 상태를 사람 말로. **모르는 값은 그대로 보여 준다.** 계약이 아직
 * `S15P21C206-143` 브랜치에만 있어 값이 늘어날 수 있고, 모른다고 숨기면
 * 사용자가 왜 못 보내는지 알 길이 없다.
 */
function residualNote(status: string | null): string {
  if (status === null) return "계산을 아직 시작하지 않았습니다.";
  if (status === "QUEUED") return "계산을 기다리는 중입니다.";
  if (status === "FAILED") return "계산이 실패했습니다.";
  return `계산 상태 ${status}`;
}

export function SubmissionStatus({ submission }: { submission: Submission }) {
  const { state, volatileId } = submission;
  const recoverBundle = useBundleRecovery();
  const headingId = useId();
  const reminderRef = useRef<HTMLButtonElement>(null);
  const focusRef = useRef<HTMLParagraphElement>(null);
  const [closed, setClosed] = useState(false);
  const settled = state.phase === "settled" ? state : null;
  const open = state.phase !== "idle" && !closed;

  /**
   * 닫기. 거절은 입력으로 돌아가는 것과 같으므로 상태를 지우지만, 접수와 결과
   * 불명은 **지우지 않는다.** 결과 불명에서 상태를 잃으면 요청 번호로 다시
   * 확인할 길이 사라진다.
   */
  const close = () => {
    if (
      settled &&
      settled.state !== "accepted" &&
      settled.state !== "unresolved"
    )
      submission.dismiss();
    else setClosed(true);
  };
  const dialogRef = useModalDialog({
    open,
    onClose: close,
    fallbackRef: reminderRef,
  });

  // 새 시도가 시작되면 닫아 둔 것을 다시 연다.
  useEffect(() => {
    if (state.phase === "sending" || state.phase === "checking")
      setClosed(false);
  }, [state.phase]);
  // 결과가 정해진 순간에만 옮긴다. 진행 중 갱신으로는 옮기지 않는다.
  useEffect(() => {
    if (settled && open) focusRef.current?.focus();
  }, [settled, open]);

  return (
    <>
      {closed && state.phase !== "idle" && (
        <p
          className={
            settled?.state === "unresolved"
              ? "submission-reminder submission-reminder-warning"
              : "submission-reminder"
          }
          role="status"
        >
          {settled?.state === "accepted"
            ? `접수 완료 · ${settled.receipt.submissionId}`
            : settled?.state === "unresolved"
              ? "접수 여부가 아직 확인되지 않았습니다."
              : "제출을 처리하고 있습니다."}{" "}
          <button
            ref={reminderRef}
            type="button"
            onClick={() => setClosed(false)}
          >
            접수 결과 보기
          </button>
        </p>
      )}
      <dialog
        ref={dialogRef}
        className="submission-dialog"
        data-testid="submission-result"
        aria-labelledby={headingId}
      >
        {state.phase === "idle" ? null : !settled ? (
          <>
            <h4 id={headingId}>제출하고 있습니다</h4>
            <p role="status">
              {state.phase === "sending"
                ? "서버에 보내는 중입니다. 응답을 받지 못해도 같은 요청 번호로 결과를 확인하므로 두 번 접수되지 않습니다."
                : "접수 결과를 확인하고 있습니다."}
            </p>
          </>
        ) : settled.state === "accepted" ? (
          <>
            <h4 id={headingId}>접수되었습니다</h4>
            <p ref={focusRef} tabIndex={-1} role="status">
              {acceptedNotice(settled.recovered, settled.receipt.outcome)}
            </p>
            {/*
              D-5 재전송 성공 예외. 접수 뒤에 판이 바뀌었어도 성공을 취소하거나
              다시 제출하지 않는다. 당시 판정·선택·스냅샷은 그대로 두고 이
              결과가 어느 판 기준인지만 알린다.
            */}
            {acceptedOnOlderBundle(
              settled.receipt,
              settled.currentBundleId,
            ) && (
              <p className="submission-note" data-testid="stale-bundle">
                이 결과는 접수 당시 판 기준입니다. 그 뒤 별의 자료 판이
                바뀌었으니 분석을 이어가려면 최신 자료를 다시 불러와 주세요.
              </p>
            )}
            <dl>
              <dt>접수 번호</dt>
              <dd>{settled.receipt.submissionId}</dd>
              <dt>기록 번호</dt>
              <dd>{settled.receipt.historyId}</dd>
              <dt>접수 시각</dt>
              <dd>
                <time dateTime={settled.receipt.submittedAt}>
                  {new Date(settled.receipt.submittedAt).toLocaleString(
                    "ko-KR",
                  )}
                </time>
              </dd>
            </dl>
            <ResultExplanationView receipt={settled.receipt} />
            <p className="submission-note">
              다음 단계로 넘어가는 행동은 아직 연결되지 않았습니다.
            </p>
          </>
        ) : settled.state === "unresolved" ? (
          <>
            <h4 id={headingId}>접수 여부를 확인해 주세요</h4>
            {/* 404를 근거로 "제출되지 않았습니다"라고 단정하지 않는다. */}
            <p ref={focusRef} tabIndex={-1} role="alert">
              {settled.message}
            </p>
            <button type="button" onClick={() => submission.check()}>
              접수 결과 확인
            </button>
            {/*
              조회가 404를 줬을 때만 내놓는다. 보관한 ID와 본문을 그대로 다시
              보내므로, 실제로는 접수돼 있었더라도 서버가 저장된 결과를
              재현할 뿐 새 기록을 만들지 않는다.
            */}
            {submission.resendable && (
              <button type="button" onClick={() => submission.resend()}>
                같은 내용으로 다시 보내기
              </button>
            )}
          </>
        ) : (
          <>
            <h4 id={headingId}>
              {settled.state === "context-not-ready"
                ? "아직 제출할 수 없습니다"
                : "제출하지 못했습니다"}
            </h4>
            <p ref={focusRef} tabIndex={-1} role="alert">
              {settled.state === "context-not-ready"
                ? "이 단계의 계산이 아직 끝나지 않았습니다. 준비되면 같은 내용을 그대로 다시 보낼 수 있습니다."
                : settled.state === "bundle-changed"
                  ? "별의 데이터 판이 바뀌었습니다. 최신 자료를 다시 불러온 뒤 주기와 구간을 다시 골라 주세요."
                  : settled.state === "expired"
                    ? "로그인이 만료되었습니다. 다시 로그인한 뒤 제출해 주세요."
                    : settled.message}
            </p>
            {settled.state === "context-not-ready" && settled.residual && (
              <p className="submission-note">
                {residualNote(settled.residual.status)}
                {settled.residual.jobId &&
                  ` · 작업 번호 ${settled.residual.jobId}`}
              </p>
            )}
            {/*
              2.2절: 자동 재전송하지 않는다. 무엇이 접수됐는지 먼저 확인하고,
              새 ID는 사용자가 별도 제출을 고를 때만 만든다.
            */}
            {settled.state === "conflict" && (
              <>
                <button type="button" onClick={() => submission.check()}>
                  접수 결과 확인
                </button>
                <button type="button" onClick={() => submission.submitAsNew()}>
                  별도 제출로 보내기
                </button>
              </>
            )}
            {/*
              거절이어도 ID는 살아 있다. 앞선 전송이 응답만 잃고 접수됐을 수
              있으므로 확인 경로를 남긴다.
            */}
            {settled.state === "denied" && (
              <button type="button" onClick={() => submission.check()}>
                접수 결과 확인
              </button>
            )}
            {settled.state === "bundle-changed" && (
              <button
                type="button"
                onClick={() => {
                  // 새 ID는 여기서부터다. 2.2절이 말하는 「사용자 확인」이
                  // 이 클릭이며, 그 전에는 앞선 요청의 ID를 지키고 있었다.
                  submission.discardRequest();
                  recoverBundle?.();
                  submission.dismiss();
                }}
              >
                최신 자료 불러오기
              </button>
            )}
            {settled.state === "rejected" && settled.fieldErrors.length > 0 && (
              <ul>
                {settled.fieldErrors.map((error) => (
                  <li key={error.field}>
                    {fieldLabel(error.field)}: {error.reason}
                  </li>
                ))}
              </ul>
            )}
            {volatileId && (
              <p className="submission-note">
                브라우저 저장소를 쓸 수 없어 이 요청 번호는 새로고침하면
                사라집니다.
              </p>
            )}
          </>
        )}
        <div
          className="submission-dialog-actions"
          hidden={state.phase === "idle"}
        >
          <button type="button" onClick={close}>
            {settled &&
            settled.state !== "accepted" &&
            settled.state !== "unresolved"
              ? "입력으로 돌아가기"
              : "닫기"}
          </button>
        </div>
      </dialog>
    </>
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
const confirmText: Record<"no_candidate" | "skipped", string> = {
  no_candidate:
    "이 별에 더 이상 후보가 없다고 제출합니다. 선택·판단·근거는 함께 보내지 않으며 되돌릴 수 없습니다.",
  skipped:
    "이 별을 건너뜁니다. 선택·판단·근거는 함께 보내지 않으며 되돌릴 수 없습니다.",
};

/**
 * 더 없음·건너뛰기. 후보 제출과 달리 선택·판단·근거를 보내지 않으므로
 * 제출값 확인 단계를 거치지 않는다. 되돌릴 수 없으므로 한 번 더 묻되,
 * 브라우저의 `confirm`이 아니라 접수 결과와 같은 대화상자로 묻는다.
 */
export function SpecialSubmissions({
  context,
  submission,
}: {
  context: AnalysisContext;
  submission: Submission;
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
    setAsking(null);
    submission.submit(
      asking === "no_candidate"
        ? noCandidateInput(context.curveContext)
        : skippedInput(context.curveContext),
    );
  };
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
            onClick={() => setAsking(option.kind)}
          >
            {option.label}
          </button>
          {option.unavailable && (
            <span className="submission-note"> {option.unavailable}</span>
          )}
        </p>
      ))}
      <dialog
        ref={dialogRef}
        className="submission-dialog"
        data-testid="submission-confirm"
        aria-labelledby={headingId}
      >
        <h4 id={headingId}>
          {asking === "skipped"
            ? "이 별을 건너뛸까요?"
            : "더 이상 없다고 보낼까요?"}
        </h4>
        <p>{asking ? confirmText[asking] : null}</p>
        <div className="submission-dialog-actions" hidden={!asking}>
          {/* 되돌릴 수 없는 동작이므로 안전한 쪽에 먼저 포커스를 준다. */}
          <button
            type="button"
            className="submission-dialog-cancel"
            autoFocus
            onClick={() => setAsking(null)}
          >
            취소
          </button>
          <button type="button" onClick={send}>
            보내기
          </button>
        </div>
      </dialog>
    </div>
  );
}
