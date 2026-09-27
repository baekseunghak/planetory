// Classic analysis -> ../analysis/bridge.
//
// The existing analysis screens call into this file from a handful of lines in
// src/features/analysis (PeriodSelection.tsx and use-submission.ts). Every
// emitter here is a no-op unless the tree is wrapped in <ClassicBridgeScope>,
// which only ClassicAnalysis does. So:
//   - the old /analysis page and its Playwright specs behave exactly as before;
//   - the new variant, which may reuse the same hooks, never gets these events
//     twice (it emits its own).
// Emitting only reads state. The bridge swallows listener errors, so nothing
// here can change or break the analysis flow.
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  emitAnalysis,
  outcomeFromReceipt,
  periodStrength,
  type SubmitFailure,
  type WindowSelection,
} from "../analysis/bridge";
import { useAnalysisStage } from "../../features/analysis/analysis-stage";
import {
  useAnalysisFold,
  usePhaseDraft,
} from "../../features/analysis/AnalysisSession";
import {
  judgments,
  type Judgment,
} from "../../features/analysis/analysis-judgment";
import { hasCelebrated } from "../../features/analysis/celebration";
import type { ReadyPeriodogram } from "../../features/analysis/period-selection";
import type { SubmissionKind } from "../../features/analysis/submission-data";
import { readPendingSubmission } from "../../features/analysis/submission-request";
import type { SubmissionResult } from "../../features/analysis/submit-analysis";

const Scope = createContext(false);

/** Turns the classic emitters on for this subtree. */
export function ClassicBridgeScope({ children }: { children?: ReactNode }) {
  return createElement(Scope.Provider, { value: true }, children);
}

function judgmentOf(body: Record<string, unknown> | null | undefined) {
  const value = body?.userJudgment;
  return judgments.some((option) => option.value === value)
    ? (value as Judgment)
    : null;
}

const failed = (
  ticId: string,
  state: SubmitFailure["state"],
  message: string | null,
) => emitAnalysis("submitFailed", { ticId, state, message });

/**
 * For use-submission.ts: emitters bound to this star, member and request
 * slot inside ClassicAnalysis; null anywhere else. Stable while those stay
 * the same, like the hook's own callbacks.
 */
export function useClassicSubmissionBridge(
  ticId: string,
  memberId: string | null,
  key: string | null,
) {
  const active = useContext(Scope);
  return useMemo(
    () =>
      active
        ? {
            /** A send started: the first send, or a resend of the kept body. */
            submitted(kind: SubmissionKind | null) {
              emitAnalysis("submitted", { ticId, kind });
            },
            /**
             * A send or a check settled. Accepted -> `outcome` from the real
             * receipt; anything else -> `submitFailed` (unresolved is not an
             * outcome).
             *
             * `firstView` reads the celebration history before
             * SubmissionStatus writes it (in an effect after this render),
             * the same decision as its `celebrate`. `userJudgment` is what
             * this screen sent; after a reload, the kept request body.
             */
            settled(
              result: SubmissionResult,
              input: Record<string, unknown> | null,
            ) {
              if (result.state !== "accepted")
                return failed(
                  ticId,
                  result.state,
                  "message" in result ? result.message : null,
                );
              const { receipt } = result;
              emitAnalysis(
                "outcome",
                outcomeFromReceipt(receipt, {
                  firstView:
                    !memberId || !hasCelebrated(memberId, receipt.submissionId),
                  userJudgment:
                    judgmentOf(input) ??
                    judgmentOf(key ? readPendingSubmission(key)?.body : null),
                }),
              );
            },
            /** The response could not be read: acceptance is unknown. */
            lost(message: string) {
              failed(ticId, "unresolved", message);
            },
          }
        : null,
    [active, ticId, memberId, key],
  );
}

/**
 * For PeriodSelectionWorkspace (inside AnalysisSession). Emits from the
 * screen's real state, so rollbacks and restores are reported too:
 * - periodChanged: the fold session's current change (begin, fine-tune,
 *   draft restore, rollback after a failed or cancelled fold). `strength` is
 *   `periodStrength(periodogram, period)`: the periodogram power at that
 *   period over the strongest power, 0..1.
 * - stageChanged: useAnalysisStage (1 period, 2 window, 3 judgment, 4 review).
 * - selectionChanged: the current phase preview (the same one the judgment
 *   uses), `confirmed` once the window is fixed. null while there is no valid
 *   window, and once more when this workspace unmounts with a window shown.
 */
export function useClassicAnalysisEmits(
  ticId: string,
  data: ReadyPeriodogram,
): void {
  const active = useContext(Scope);
  const change = useAnalysisFold().state.change;
  const { state: draft, ready } = usePhaseDraft();
  const { stage } = useAnalysisStage();

  useEffect(() => {
    if (!active || !change) return;
    const { periodDays, sourcePeakGridIndex } = change.selection;
    emitAnalysis("periodChanged", {
      ticId,
      periodDays,
      strength: periodStrength(data, periodDays),
      sourcePeakGridIndex,
      operation: change.kind,
    });
  }, [active, ticId, data, change]);

  useEffect(() => {
    if (active && (stage === 1 || stage === 2 || stage === 3 || stage === 4))
      emitAnalysis("stageChanged", { ticId, stage });
  }, [active, ticId, stage]);

  const preview =
    ready && draft.preview?.kind === "preview" ? draft.preview : null;
  const confirmed = !!preview && draft.confirmed === preview && !draft.dragging;
  const periodDays = preview?.selection.periodDays ?? null;
  const startPhase = preview?.selection.phaseStart ?? null;
  const endPhase = preview?.selection.phaseEnd ?? null;
  const durationHours = preview?.durationPreviewHours ?? null;
  const shown = useRef(false);
  useEffect(() => {
    if (!active) return;
    const selection: WindowSelection | null =
      periodDays !== null &&
      startPhase !== null &&
      endPhase !== null &&
      durationHours !== null
        ? { periodDays, startPhase, endPhase, durationHours, confirmed }
        : null;
    shown.current = selection !== null;
    emitAnalysis("selectionChanged", { ticId, selection });
  }, [
    active,
    ticId,
    periodDays,
    startPhase,
    endPhase,
    durationHours,
    confirmed,
  ]);
  useEffect(
    () => () => {
      if (!active || !shown.current) return;
      shown.current = false;
      emitAnalysis("selectionChanged", { ticId, selection: null });
    },
    [active, ticId],
  );
}
