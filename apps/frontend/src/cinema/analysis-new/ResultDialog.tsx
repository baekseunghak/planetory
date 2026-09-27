import { useEffect, useId, useRef } from "react";
import { skippedInput } from "../../features/analysis/submission-input";
import type { SubmissionResult } from "../../features/analysis/submit-analysis";
import type { useSubmission } from "../../features/analysis/use-submission";
import { useModalDialog } from "../../features/analysis/use-modal-dialog";
import { AcceptedResult } from "../analysis/results/AcceptedResult";

type Accepted = Extract<SubmissionResult, { state: "accepted" }>;

/**
 * "결과 자세히 보기": the cinema's full result (../analysis/results/
 * AcceptedResult, the same view as the classic result dialog) in a dialog
 * over the scene. Signal names, numbers by the glossary, internal ids only
 * under 기술 정보, and at most two primary actions ("구간 다시 잡기" /
 * "주기 다시 고르기" after a window that matched nothing). Opening it never
 * calls the detail endpoint; the member still presses the detail button (6.7).
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
  const focusRef = useRef<HTMLParagraphElement>(null);
  const dialogRef = useModalDialog({ open, onClose });
  // The lead line (what happened) is where reading starts.
  useEffect(() => {
    if (open) focusRef.current?.focus({ preventScroll: true });
  }, [open]);
  const { receipt } = accepted;
  return (
    <dialog
      ref={dialogRef}
      className="cx-dialog cx-result-dialog"
      data-testid="cx-result-detail"
      aria-labelledby={headingId}
    >
      {open && (
        <AcceptedResult
          receipt={receipt}
          recovered={accepted.recovered}
          detail={submission.detail}
          onViewDetail={submission.viewDetail}
          onSkip={() => submission.submit(skippedInput(receipt.curveContext))}
          celebrate={celebrate}
          stale={stale}
          recoverBundle={recoverBundle}
          nextCurve={nextCurve}
          // "구간 다시 잡기" / "주기 다시 고르기": the submission goes back to
          // idle (this dialog and the inline result leave with it) and the
          // draft to that step.
          dismiss={submission.dismiss}
          close={onClose}
          returnTo={returnTo}
          currentPath={currentPath}
          headingId={headingId}
          focusRef={focusRef}
        />
      )}
    </dialog>
  );
}
