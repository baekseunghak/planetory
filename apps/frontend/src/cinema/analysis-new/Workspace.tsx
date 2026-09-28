import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSession } from "../../auth/SessionProvider";
import type {
  AnalysisContext,
  CurveData,
} from "../../features/analysis/analysis-data";
import { AnalysisDraftPersistence } from "../../features/analysis/AnalysisDraftPersistence";
import type {
  Judgment,
  PeriodogramViewport,
} from "../../features/analysis/analysis-judgment";
import {
  useAnalysisFold,
  useCurveStepSession,
  usePhaseDraft,
  useRetryDraft,
} from "../../features/analysis/AnalysisSession";
import { useAnalysisStage } from "../../features/analysis/analysis-stage";
import { stepName } from "../../features/analysis/curve-step";
import {
  hasCelebrated,
  markCelebrated,
} from "../../features/analysis/celebration";
import { useSustained } from "../../features/analysis/fold-progress";
import {
  choosePeriod,
  fineTunePeriod,
  periodChange,
  type PeriodChoice,
  type PeriodSelection,
  type PeriodSelectionChange,
  type ReadyPeriodogram,
} from "../../features/analysis/period-selection";
import { getSelectionLimits } from "../../features/analysis/phase-selection";
import {
  readPendingSubmission,
  submissionStorageKey,
} from "../../features/analysis/submission-request";
import { useSubmission } from "../../features/analysis/use-submission";
import { OnboardingTip } from "../../features/onboarding/Onboarding";
import {
  emitAnalysis,
  outcomeFromReceipt,
  periodStrength,
  type AnalysisOutcome,
  type WindowSelection,
} from "../analysis/bridge";
import { FoldArea, type SelectionContract } from "./FoldArea";
import {
  CurveSteps,
  CurveStepStatus,
  DataButton,
  HelpButton,
  Meta,
  PanelFrame,
  SkeletonFrame,
} from "./Frame";
import { usePeriodogram } from "./hooks";
import { JudgeArea } from "./JudgeArea";
import {
  bridgeSelection,
  guidance,
  judgmentFromBody,
  periodogramNotice,
  windowHint,
  type PeriodogramLoadState,
} from "./model";
import { PeriodArea, type AreaState } from "./PeriodArea";
import { TimeStrip } from "./TimeStrip";

type ReadyCurve = Extract<CurveData, { kind: "ready" }>;

// Bridge payloads already emitted for a submission state object. Module level
// so StrictMode's second effect pass never repeats an event.
const emittedStates = new WeakSet<object>();

type WorkspaceProps = {
  /** The viewed curve step's context (reads and submissions use this). */
  context: AnalysisContext;
  /** The entry context (bundle version, matched signals, next step). */
  entry: AnalysisContext;
  curve: ReadyCurve;
  notices: ReactNode;
  reload: () => void;
  recoverBundle: () => boolean;
};

/** Everything inside one AnalysisSession: loads the periodogram first. */
export function Workspace(props: WorkspaceProps) {
  const { context, curve, recoverBundle, reload } = props;
  const { state, retry } = usePeriodogram(context, curve, recoverBundle);
  const data =
    state.kind === "loaded" && state.data.kind === "ready" ? state.data : null;
  if (data) return <ReadyWorkspace {...props} data={data} />;
  return <WaitingWorkspace {...props} load={state} retryPeriodogram={retry} />;
}

/** The name of the curve step being prepared, for the guidance line. */
function usePreparing(): string | null {
  const step = useCurveStepSession();
  return step?.transition.phase === "running"
    ? stepName(step.transition.target)
    : null;
}

/** The periodogram is loading or cannot be shown: same layout, one message. */
function WaitingWorkspace({
  context,
  entry,
  curve,
  notices,
  reload,
  load,
  retryPeriodogram,
}: WorkspaceProps & {
  load: PeriodogramLoadState;
  retryPeriodogram: () => void;
}) {
  const notice = periodogramNotice(load);
  const loading = load.kind === "loading";
  const preparing = usePreparing();
  return (
    <SkeletonFrame
      busy={loading}
      meta={<Meta context={entry} viewing={context.curveContext} />}
      guide={guidance({
        periodogram: loading ? "loading" : "unavailable",
        stage: 1,
        period: "none",
        folding: false,
        foldProblem: false,
        zoom: 1,
        range: false,
        dragging: false,
        preview: "none",
        hint: null,
        judgment: false,
        submission: "idle",
        preparing,
      })}
      tools={
        <>
          <CurveSteps context={entry} />
          <DataButton
            context={context}
            viewedBundleId={context.curveContext.bundleId}
            curve={curve}
            reload={reload}
          />
          <HelpButton />
        </>
      }
      notices={
        <>
          {notices}
          <CurveStepStatus />
        </>
      }
      strip={<TimeStrip segments={curve.segments} fluxUnit={curve.fluxUnit} />}
      period={
        <>
          <p
            className={loading ? "cx-empty" : "cx-empty cx-empty-alert"}
            role={loading ? "status" : "alert"}
            data-testid="cx-periodogram-state"
          >
            {notice.message}
          </p>
        </>
      }
      periodAction={
        notice.action && (
          <p>
            <button
              type="button"
              className="cx-secondary"
              onClick={
                notice.action === "reload-analysis" ? reload : retryPeriodogram
              }
            >
              {notice.action === "reload-analysis"
                ? "분석 자료 다시 불러오기"
                : "주기도 다시 불러오기"}
            </button>
          </p>
        )
      }
    />
  );
}

function ReadyWorkspace({
  context,
  entry,
  curve,
  notices,
  reload,
  data,
}: WorkspaceProps & { data: ReadyPeriodogram }) {
  const ticId = context.ticId;
  const memberId = useSession().member?.memberId ?? null;
  const fold = useAnalysisFold();
  // Share the display state with the submission review; preserve session resets.
  const [foldView, setFoldView] = useState(fold.state.view);
  useEffect(() => setFoldView(fold.state.view), [fold.state.view]);
  const { state: draft } = usePhaseDraft();
  const analysisStage = useAnalysisStage();
  const { go, ready, confirmed } = analysisStage;
  // analysis-stage.ts only yields 1..4.
  const stage = analysisStage.stage as 1 | 2 | 3 | 4;
  const { draft: retryDraft, resume } = useRetryDraft();
  const submission = useSubmission(context);
  const { state: foldState, dispatch } = fold;
  const change = foldState.change;

  /* ------------------------------------------------ period (bridge) */
  const revision = useRef(0);
  const begin = useCallback(
    (
      kind: PeriodSelectionChange["kind"],
      selection: PeriodSelection,
      resetView?: boolean,
    ) => {
      const next = {
        ...periodChange(data, null, kind, selection),
        revision: ++revision.current,
      };
      dispatch({ type: "begin", change: next, resetView });
      emitAnalysis("periodChanged", {
        ticId,
        periodDays: selection.periodDays,
        strength: periodStrength(data, selection.periodDays),
        sourcePeakGridIndex: selection.sourcePeakGridIndex,
        operation: kind,
      });
      return next;
    },
    [data, dispatch, ticId],
  );
  const restore = useCallback(
    (selection: PeriodSelection) => begin("reselect", selection),
    [begin],
  );
  const choose = useCallback(
    (choice: PeriodChoice) => {
      begin("reselect", choosePeriod(data, choice));
    },
    [data, begin],
  );
  const tune = (period: number) => {
    const previous = change;
    if (!previous || previous.selection.periodDays === period) return;
    begin("fine-tune", fineTunePeriod(previous.selection, period));
  };
  const retryFold = () => {
    if (!foldState.request) return;
    begin(
      foldState.request.change.kind,
      foldState.request.change.selection,
      foldState.request.resetView,
    );
  };
  const viewport = useRef<PeriodogramViewport>({
    minDays: data.periodogram.periodMinDays,
    maxDays: data.periodogram.periodMaxDays,
  });
  const trackViewport = useCallback((next: PeriodogramViewport) => {
    viewport.current = next;
  }, []);

  /* --------------------------------------------------------- window */
  const successChange = foldState.success?.change ?? null;
  const contract: SelectionContract = useMemo(() => {
    if (!successChange) return { limits: null, error: "" };
    try {
      return {
        limits: getSelectionLimits(context, data, successChange),
        error: "",
      };
    } catch (error) {
      return { limits: null, error: (error as Error).message };
    }
  }, [context, data, successChange]);
  const emptyRuleNote =
    context.selectionContract.kind === "ready" &&
    !context.selectionContract.rules.allowEmptyPhaseSpan;

  const selection = ready ? bridgeSelection(draft.preview, confirmed) : null;
  const selectionKey = JSON.stringify(selection);
  const lastSelection = useRef<string | null>(null);
  useEffect(() => {
    if (lastSelection.current === selectionKey) return;
    lastSelection.current = selectionKey;
    emitAnalysis("selectionChanged", {
      ticId,
      selection: JSON.parse(selectionKey) as WindowSelection | null,
    });
  }, [selectionKey, ticId]);
  // Leaving with a window shown: say it is gone, as the classic does.
  useEffect(
    () => () => {
      if (lastSelection.current && lastSelection.current !== "null")
        emitAnalysis("selectionChanged", { ticId, selection: null });
      lastSelection.current = null;
    },
    [ticId],
  );
  const lastStage = useRef<number | null>(null);
  useEffect(() => {
    if (lastStage.current === stage) return;
    lastStage.current = stage;
    emitAnalysis("stageChanged", { ticId, stage });
  }, [stage, ticId]);

  /* ------------------------------------------------ submission (bridge) */
  const sentJudgment = useRef<Judgment | null>(null);
  const accepted = submission.accepted;
  const receipt = accepted?.receipt ?? null;
  // Once per submission, before the result is shown and recorded (2.2).
  const decided = useRef<{ id: string; first: boolean } | null>(null);
  if (receipt && memberId && decided.current?.id !== receipt.submissionId)
    decided.current = {
      id: receipt.submissionId,
      first: !hasCelebrated(memberId, receipt.submissionId),
    };
  const firstView = Boolean(
    receipt &&
    decided.current?.id === receipt.submissionId &&
    decided.current.first,
  );
  const outcome: AnalysisOutcome | null = useMemo(() => {
    if (!receipt) return null;
    let userJudgment: Judgment | null = null;
    if (receipt.submissionKind === "candidate") {
      userJudgment = sentJudgment.current;
      // A response recovered after a reload: read what was stored with its ID.
      if (!userJudgment && memberId) {
        const pending = readPendingSubmission(
          submissionStorageKey(memberId, ticId),
        );
        if (pending?.requestId === receipt.requestId)
          userJudgment = judgmentFromBody(pending.body);
      }
    }
    return outcomeFromReceipt(receipt, { firstView, userJudgment });
  }, [receipt, firstView, memberId, ticId]);
  useEffect(() => {
    if (receipt && memberId && firstView)
      markCelebrated(memberId, receipt.submissionId);
  }, [receipt, memberId, firstView]);

  const submissionState = submission.state;
  useEffect(() => {
    const current = submissionState;
    if (emittedStates.has(current)) return;
    if (current.phase === "sending") {
      emittedStates.add(current);
      emitAnalysis("submitted", { ticId, kind: current.kind });
      return;
    }
    if (current.phase !== "settled") return;
    if (current.state === "accepted") {
      if (!outcome) return;
      emittedStates.add(current);
      emitAnalysis("outcome", outcome);
      return;
    }
    emittedStates.add(current);
    emitAnalysis("submitFailed", {
      ticId,
      state: current.state,
      message: "message" in current ? current.message : null,
    });
  }, [submissionState, outcome, ticId]);

  /* -------------------------------------------------------- display */
  const locked = submission.locked;
  const pending = foldState.status === "pending";
  const slow = useSustained(pending);
  const periodEditable = !locked;
  const lockReason = locked
    ? "제출을 처리하는 동안이나 결과가 나온 뒤에는 주기를 바꿀 수 없습니다."
    : null;
  const preview = draft.preview;
  const settled =
    submission.state.phase === "settled" ? submission.state : null;
  const submissionMode =
    submission.state.phase === "sending" ||
    submission.state.phase === "checking"
      ? "busy"
      : settled?.state === "accepted"
        ? "accepted"
        : settled
          ? "problem"
          : "idle";
  const hint = windowHint(
    preview,
    draft.range,
    contract.limits,
    successChange?.selection.periodDays ?? null,
  );
  const preparing = usePreparing();
  const foldProblem =
    Boolean(fold.input.error) ||
    !fold.input.data?.points.length ||
    foldState.status === "error" ||
    foldState.status === "cancelled";
  const guide = guidance({
    periodogram: "ready",
    stage,
    period: !change
      ? "none"
      : change.selection.sourcePeakGridIndex === null
        ? "direct"
        : "peak",
    folding: slow,
    foldProblem,
    zoom: foldState.view.zoom,
    range: draft.range !== null,
    dragging: draft.dragging,
    preview: !draft.range
      ? "none"
      : preview?.kind === "preview"
        ? "valid"
        : "invalid",
    hint,
    judgment: draft.judgment.userJudgment !== null,
    submission: submissionMode,
    preparing,
  });
  // While a submission is sent, unresolved or answered, the judgment column
  // holds the only next step; the other areas step back.
  const submitting = submissionMode !== "idle";
  const periodState: AreaState = submitting
    ? "idle"
    : stage === 1
      ? "active"
      : "idle";
  const windowState: AreaState = submitting
    ? "idle"
    : stage === 2
      ? "active"
      : stage === 1 && (ready || pending)
        ? "ready"
        : "idle";
  const judgeState: AreaState =
    submitting || stage >= 3
      ? "active"
      : stage === 2 && preview?.kind === "preview" && !draft.dragging
        ? "ready"
        : "idle";

  return (
    <PanelFrame
      busy={pending || submissionMode === "busy"}
      meta={<Meta context={entry} viewing={context.curveContext} />}
      guide={guide}
      tools={
        <>
          <CurveSteps
            context={entry}
            found={receipt?.progress.matchedCandidateIds.length}
          />
          <DataButton
            context={context}
            viewedBundleId={context.curveContext.bundleId}
            curve={curve}
            reload={reload}
          />
          <HelpButton />
        </>
      }
      notices={
        <>
          {notices}
          <OnboardingTip step={stage} />
          {createPortal(
            <div className="cx-analysis cx-draft-floating">
              <AnalysisDraftPersistence context={context} data={data} onRestore={restore} />
            </div>,
            document.body,
          )}
          <CurveStepStatus />
        </>
      }
      period={
        <PeriodArea
          data={data}
          change={change}
          editable={periodEditable}
          lockReason={lockReason}
          areaState={periodState}
          inputKey={foldState.inputKey}
          onChoose={choose}
          onTune={tune}
          onViewportChange={trackViewport}
          initialViewport={
            !resume
              ? retryDraft?.draft.viewState?.periodogramViewport
              : undefined
          }
          strip={
            <TimeStrip segments={curve.segments} fluxUnit={curve.fluxUnit} />
          }
        />
      }
      window={
        <FoldArea
          view={foldView}
          setView={setFoldView}
          context={context}
          data={data}
          curve={curve}
          stage={stage}
          go={go}
          locked={locked}
          contract={contract}
          areaState={windowState}
          onRetryFold={retryFold}
          emptyRuleNote={emptyRuleNote}
        />
      }
      judge={
        <JudgeArea
          foldedZoom={Math.min(32, Math.max(1, foldView.zoom))}
          context={context}
          submission={submission}
          outcome={outcome}
          celebrate={firstView}
          areaState={judgeState}
          getViewport={() => viewport.current}
          onSend={(judgment) => {
            sentJudgment.current = judgment;
          }}
        />
      }
    />
  );
}
