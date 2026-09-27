import { useEffect, useId, useRef, useState } from "react";
import { useModalDialog } from "./use-modal-dialog";
import { useBundleRecovery, useCurveStepSession } from "./AnalysisSession";
import { acceptedOnOlderBundle } from "./submission-data";
import { hasCelebrated, markCelebrated } from "./celebration";
import { useSession } from "../../auth/SessionProvider";
import {
  DetailView,
  NextActions,
  ResultExplanationView,
} from "./AnalysisResult";
import { usePageContext } from "../../app/usePageContext";
import type { AnalysisContext } from "./analysis-data";
import {
  noCandidateInput,
  skippedInput,
  specialSubmissions,
} from "./submission-input";
import type { useSubmission } from "./use-submission";
import { useCinemaCopy } from "./cinema-copy";

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
  const curveStep = useCurveStepSession();
  const { returnTo, currentPath } = usePageContext();
  const headingId = useId();
  const reminderRef = useRef<HTMLButtonElement>(null);
  const focusRef = useRef<HTMLParagraphElement>(null);
  const [closed, setClosed] = useState(false);
  const settled = state.phase === "settled" ? state : null;
  // 시네마 앱은 접수된 결과를 자기 말로 보여 준다(내부 번호는 「기술 정보」
  // 안에, 주요 행동은 둘까지). develop 화면은 null이라 아래 그대로다.
  const cinema = useCinemaCopy();
  const CinemaResult =
    cinema && settled?.state === "accepted" ? cinema.AcceptedResult : null;
  /**
   * [다음 곡선 단계로]의 목표. **접수 결과의 매칭 집합**으로 만든다.
   * 진입 때 받은 `nextCurveContext`는 제출 전 값이라 방금 매칭한 후보가
   * 빠져 있다. 계산 버전과 판은 접수 결과가 들고 있는 것을 쓴다.
   */
  const nextCurve =
    curveStep &&
    settled?.state === "accepted" &&
    !acceptedOnOlderBundle(settled.receipt, settled.currentBundleId)
      ? () => {
          const { curveContext, progress } = settled.receipt;
          curveStep.goTo({
            ...curveContext,
            curveStep: progress.matchedCandidateIds.length,
            removedCandidateIds: progress.matchedCandidateIds,
          });
          // 결과를 닫고 분석 화면으로 돌아간다. 같은 화면에서 일어난다.
          setClosed(true);
        }
      : undefined;
  /**
   * 잔차가 준비되지 않아 거절된 제출(#187)에서 계산을 요청한다. 목표는
   * **지금 보고 있는 곡선 문맥**이다. 다른 단계를 준비시키는 것이 아니다.
   */
  const prepareResidual =
    curveStep && settled?.state === "context-not-ready"
      ? () => curveStep.prepare()
      : undefined;
  /**
   * 접수 뒤 판이 바뀌었는가(D-5 재전송 성공 예외). 성공을 취소하지 않고
   * 최신이 필요한 축(진행·공개·통계·다음 행동)에만 모른다고 표시한다.
   */
  /**
   * 이 회원이 이 제출의 성과를 처음 보는가(2.2절). 201인지 200인지로 가르지
   * 않는다. 최초 201을 잃고 200으로 처음 복구한 결과도 그에게는 처음이다.
   *
   * 보여 준 순간에 적는다. 다시 열거나 새로고침하면 축하는 나오지 않고
   * 사실은 그대로 남는다.
   */
  const memberId = useSession().member?.memberId ?? null;
  const shown =
    settled?.state === "accepted" ? settled.receipt.submissionId : null;
  // 제출이 바뀔 때 한 번만 판정한다. 마운트 시점에는 아직 결과가 없고,
  // 판정을 매번 다시 하면 적어 둔 직후에 축하가 사라진다.
  const decided = useRef<{ id: string; celebrate: boolean } | null>(null);
  if (shown && memberId && decided.current?.id !== shown)
    decided.current = { id: shown, celebrate: !hasCelebrated(memberId, shown) };
  const celebrate = Boolean(shown && decided.current?.celebrate);
  useEffect(() => {
    if (celebrate && memberId && shown) markCelebrated(memberId, shown);
  }, [celebrate, memberId, shown]);

  const stale = Boolean(
    settled?.state === "accepted" &&
    acceptedOnOlderBundle(settled.receipt, settled.currentBundleId),
  );
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
            ? cinema
              ? "분석 결과가 나왔습니다."
              : `접수 완료 · ${settled.receipt.submissionId}`
            : settled?.state === "unresolved"
              ? "접수 여부가 아직 확인되지 않았습니다."
              : "제출을 처리하고 있습니다."}{" "}
          <button
            ref={reminderRef}
            type="button"
            onClick={() => setClosed(false)}
          >
            {cinema && settled?.state === "accepted"
              ? "결과 다시 보기"
              : "접수 결과 보기"}
          </button>
        </p>
      )}
      <dialog
        ref={dialogRef}
        className={
          // 비교표가 좌우로 놓이려면 폭이 필요하다. 결과가 아닐 때는 한 줄
          // 안내뿐이라 넓히면 오히려 읽기 어렵다.
          CinemaResult
            ? "submission-dialog pc-result-dialog"
            : settled?.state === "accepted"
              ? "submission-dialog submission-dialog-wide"
              : "submission-dialog"
        }
        data-testid="submission-result"
        aria-labelledby={headingId}
      >
        {state.phase === "idle" ? null : !settled ? (
          <>
            <h4 id={headingId}>제출하고 있습니다</h4>
            <p role="status">
              {state.phase === "sending"
                ? cinema
                  ? "보내는 중입니다. 연결이 끊겨도 같은 제출은 한 번만 접수됩니다."
                  : "서버에 보내는 중입니다. 응답을 받지 못해도 같은 요청 번호로 결과를 확인하므로 두 번 접수되지 않습니다."
                : "접수 결과를 확인하고 있습니다."}
            </p>
          </>
        ) : settled.state === "accepted" && CinemaResult ? (
          <CinemaResult
            receipt={settled.receipt}
            recovered={settled.recovered}
            detail={submission.detail}
            onViewDetail={submission.viewDetail}
            onSkip={() =>
              submission.submit(skippedInput(settled.receipt.curveContext))
            }
            celebrate={celebrate}
            stale={stale}
            recoverBundle={recoverBundle}
            nextCurve={nextCurve}
            dismiss={submission.dismiss}
            close={close}
            returnTo={returnTo}
            currentPath={currentPath}
            headingId={headingId}
            focusRef={focusRef}
          />
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
            {stale && (
              <p className="submission-note" data-testid="stale-bundle">
                이 결과는 접수 당시 판 기준입니다. 그 뒤 별의 자료 판이
                바뀌었으니 분석을 이어가려면 최신 자료를 다시 불러와 주세요.
                {recoverBundle && (
                  <button type="button" onClick={recoverBundle}>
                    최신 자료 불러오기
                  </button>
                )}
              </p>
            )}
            {/* 접수 정보는 맨 위 한 줄이다. 결과를 읽는 데 쓰는 값이 아니라
                무엇이 접수됐는지 가리키는 값이라 자리를 적게 쓴다. */}
            <dl className="result-receipt">
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
            <ResultExplanationView
              receipt={settled.receipt}
              // 미매칭이면 상세를 열어야 신호를 안다. 표의 오른쪽 칸이
              // 그때 채워진다.
              detail={submission.detail}
              staleBundle={stale}
              celebrate={celebrate}
            />
            <DetailView
              receipt={settled.receipt}
              detail={submission.detail}
              onView={submission.viewDetail}
              // 건너뛰기는 #187이 만든 제출 경로를 그대로 쓴다.
              onSkip={() =>
                submission.submit(skippedInput(settled.receipt.curveContext))
              }
            />
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
            {/*
              잔차를 준비시키는 길을 연다(#189). 서버가 「접수를 예약하거나
              배경에서 대신 제출하지 않는다」고 못박았으므로 사용자가 눌러야
              계산이 시작된다. 준비되면 같은 본문·ID로 다시 보낼 수 있다.
            */}
            {settled.state === "context-not-ready" && prepareResidual && (
              <button type="button" onClick={prepareResidual}>
                이 단계 계산 준비하기
              </button>
            )}
            {settled.state === "context-not-ready" && settled.residual && (
              <p className="submission-note">
                {residualNote(settled.residual.status)}
                {settled.residual.jobId &&
                  !cinema &&
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
        {/* 시네마 결과는 자기 행동 줄을 둔다(주요 행동 둘까지). */}
        {!CinemaResult && (
          <div
            className="submission-dialog-actions"
            hidden={state.phase === "idle"}
          >
            {/* 다음 행동은 닫기와 같은 줄이다. 결과를 다 읽고 나서 고르는
              것이라 본문이 아니라 바닥에 둔다. */}
            {settled?.state === "accepted" && (
              <NextActions
                receipt={settled.receipt}
                onNextCurve={nextCurve}
                returnTo={returnTo}
                from={currentPath}
              />
            )}
            <button type="button" onClick={close}>
              {settled &&
              settled.state !== "accepted" &&
              settled.state !== "unresolved"
                ? "입력으로 돌아가기"
                : "닫기"}
            </button>
          </div>
        )}
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
