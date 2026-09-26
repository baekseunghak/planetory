import { useId } from "react";
import {
  DetailView,
  NextActions,
  ResultExplanationView,
} from "../../features/analysis/AnalysisResult";
import { skippedInput } from "../../features/analysis/submission-input";
import type { SubmissionResult } from "../../features/analysis/submit-analysis";
import type { useSubmission } from "../../features/analysis/use-submission";
import { useModalDialog } from "../../features/analysis/use-modal-dialog";
import { acceptedNotice } from "./model";

type Accepted = Extract<SubmissionResult, { state: "accepted" }>;

/**
 * "결과 자세히 보기": the classic result explanation, detail view and next
 * actions, unchanged, in a dialog over the scene. Opening it never calls the
 * detail endpoint; the member still has to press the detail button (6.7).
 */
export function ResultDialog({
  open,
  onClose,
  accepted,
  submission,
  celebrate,
  stale,
  nextCurve,
  returnTo,
  currentPath,
  recoverBundle,
}: {
  open: boolean;
  onClose: () => void;
  accepted: Accepted;
  submission: ReturnType<typeof useSubmission>;
  celebrate: boolean;
  stale: boolean;
  nextCurve?: () => void;
  returnTo: string;
  currentPath: string;
  recoverBundle: (() => boolean) | null;
}) {
  const headingId = useId();
  const dialogRef = useModalDialog({ open, onClose });
  const { receipt } = accepted;
  return (
    <dialog
      ref={dialogRef}
      className="cx-dialog cx-result-dialog"
      data-testid="cx-result-detail"
      aria-labelledby={headingId}
    >
      {open && (
        <>
          <header className="cx-dialog-head">
            <h2 id={headingId}>접수되었습니다</h2>
            <button type="button" className="cx-link" onClick={onClose}>
              닫기
            </button>
          </header>
          <p role="status">
            {acceptedNotice(accepted.recovered, receipt.outcome)}
          </p>
          {stale && (
            <p className="cx-note" data-tone="warn">
              이 결과는 접수 당시 판 기준입니다. 그 뒤 별의 자료 판이 바뀌었으니
              분석을 이어가려면 최신 자료를 다시 불러와 주세요.{" "}
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
          <dl className="cx-receipt">
            <div>
              <dt>접수 번호</dt>
              <dd>{receipt.submissionId}</dd>
            </div>
            <div>
              <dt>기록 번호</dt>
              <dd>{receipt.historyId}</dd>
            </div>
            <div>
              <dt>접수 시각</dt>
              <dd>
                <time dateTime={receipt.submittedAt}>
                  {new Date(receipt.submittedAt).toLocaleString("ko-KR")}
                </time>
              </dd>
            </div>
          </dl>
          <div className="cx-explain">
            <ResultExplanationView
              receipt={receipt}
              detail={submission.detail}
              staleBundle={stale}
              celebrate={celebrate}
            />
            <DetailView
              receipt={receipt}
              detail={submission.detail}
              onView={submission.viewDetail}
              onSkip={() =>
                submission.submit(skippedInput(receipt.curveContext))
              }
            />
          </div>
          <footer className="cx-dialog-foot">
            <NextActions
              receipt={receipt}
              onNextCurve={nextCurve}
              returnTo={returnTo}
              from={currentPath}
              labels={{ GO_HOME: "나의 은하로", VIEW_RESULT: "분석 결과 보기" }}
            />
          </footer>
        </>
      )}
    </dialog>
  );
}
