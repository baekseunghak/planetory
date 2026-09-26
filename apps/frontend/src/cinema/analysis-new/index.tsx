import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { usePageContext } from "../../app/usePageContext";
import {
  contextKey,
  type AnalysisContext,
  type CurveData,
} from "../../features/analysis/analysis-data";
import {
  AnalysisEntryError,
  AnalysisEntryGate,
} from "../../features/analysis/AnalysisEntry";
import { AnalysisReturnLink } from "../../features/analysis/AnalysisReturnLink";
import { AnalysisSession } from "../../features/analysis/AnalysisSession";
import { sameContext } from "../../features/analysis/curve-step";
import type { AnalysisEntry } from "../../features/analysis/load-analysis";
import type { RetryDraft } from "../../features/analysis/retry-draft";
import { useAnalysisData } from "../../features/analysis/useAnalysisData";
import { useCurveStep } from "../../features/analysis/use-curve-step";
import { emitAnalysis } from "../analysis/bridge";
import "../styles/tokens.css";
import "./cinematic-analysis.css";
import { AnnounceContext, DataDetails, SkeletonFrame } from "./Frame";
import { usePanelInset } from "./hooks";
import { Workspace } from "./Workspace";

/**
 * The new analysis (variant "cinematic"): one bottom panel over the scene.
 * Data, fold worker, drafts, submission and recovery are the classic hooks;
 * only the presentation is new. Emits ../analysis/bridge events for the shell.
 */
export function CinematicAnalysis() {
  const { ticId, returnTo } = usePageContext();
  const [params] = useSearchParams();
  const location = useLocation();
  const retryId = params.get("retryOfSubmissionId");
  const panel = useRef<HTMLElement>(null);
  const [announcement, setAnnouncement] = useState("");
  usePanelInset(panel);
  useEffect(() => {
    if (!ticId) return;
    emitAnalysis("sessionChanged", { ticId, active: true });
    return () => emitAnalysis("sessionChanged", { ticId, active: false });
  }, [ticId]);
  return (
    <AnnounceContext.Provider value={setAnnouncement}>
      <div className="cx-analysis" data-analysis-variant="cinematic">
        <p
          className="cx-sr"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {announcement}
        </p>
        <header className="cx-crumb">
          <AnalysisReturnLink ticId={ticId ?? ""} to={returnTo}>
            ← 이전 화면
          </AnalysisReturnLink>
          <h1>
            <span className="cx-sr">분석 · </span>TIC {ticId}
          </h1>
        </header>
        <section
          ref={panel}
          className="cx-panel"
          aria-label="관측 분석"
          data-testid="cx-panel"
        >
          {ticId ? (
            <AnalysisEntryGate
              key={`${ticId}:${location.key}`}
              ticId={ticId}
              retryId={retryId}
            >
              {(entry) => <AnalysisData ticId={ticId} entry={entry} />}
            </AnalysisEntryGate>
          ) : (
            <p role="alert" className="cx-state">
              분석할 별을 선택해 주세요.
            </p>
          )}
        </section>
      </div>
    </AnnounceContext.Provider>
  );
}

/** Context and curve (classic useAnalysisData), with the classic notices. */
function AnalysisData({
  ticId,
  entry,
}: {
  ticId: string;
  entry?: AnalysisEntry;
}) {
  const {
    context,
    curve,
    loading,
    error,
    retry,
    bundleChanged,
    recoverBundle,
    retryDraft,
  } = useAnalysisData(ticId, entry);
  if (error)
    return (
      <div className="cx-state" data-testid="cx-load-error">
        <AnalysisEntryError key={String(error)} error={error} retry={retry} />
      </div>
    );
  if (loading || !context || !curve)
    return (
      <div data-testid="cx-loading">
        <SkeletonFrame
          guide={
            bundleChanged
              ? "새 데이터 판이 확인되어 분석 자료를 다시 불러오고 있습니다."
              : "관측 자료를 불러오고 있습니다."
          }
        />
      </div>
    );
  const notices = (
    <>
      {retryDraft && (
        <p role="status" className="cx-notice">
          이전 제출을 바탕으로 현재 데이터에서 다시 풉니다. 새 판단은 제출할
          때만 기록됩니다.
        </p>
      )}
      {bundleChanged && (
        <p role="status" className="cx-notice">
          새 데이터 판으로 갱신했습니다. 현재 진행 단계의 자료를 다시
          불러왔습니다.
        </p>
      )}
      {context.notice === "STEP_NOT_RESTORABLE" && (
        <p role="status" className="cx-notice">
          이전 제거 조합을 복원할 수 없어 현재 진행 단계의 자료를 불러왔습니다.
        </p>
      )}
    </>
  );
  if (curve.kind === "not-ready")
    return (
      <section
        className="cx-state"
        role="status"
        data-testid="cx-curve-not-ready"
      >
        {notices}
        <h2>곡선이 아직 준비되지 않았습니다</h2>
        <p>
          {curve.status === null
            ? "이 단계의 계산 결과가 없습니다."
            : curve.status === "FAILED"
              ? "곡선 계산에 실패했습니다."
              : "곡선을 준비하고 있습니다."}
        </p>
        <button type="button" className="cx-secondary" onClick={retry}>
          다시 불러오기
        </button>
      </section>
    );
  return (
    <AnalysisReady
      context={context}
      entryCurve={curve}
      retry={retry}
      recoverBundle={recoverBundle}
      notices={notices}
      retryDraft={retryDraft}
      resume={entry?.resume ?? false}
      autoRestore={entry?.autoRestore ?? false}
      retryAttemptId={entry?.retryAttemptId}
    />
  );
}

/** The curve step being viewed (classic AnalysisReady) and one session. */
function AnalysisReady({
  context,
  entryCurve,
  retry,
  recoverBundle,
  notices,
  retryDraft,
  resume,
  autoRestore,
  retryAttemptId,
}: {
  context: AnalysisContext;
  entryCurve: Extract<CurveData, { kind: "ready" }>;
  retry: () => void;
  recoverBundle: () => boolean;
  notices: ReactNode;
  retryDraft: RetryDraft | null;
  resume: boolean;
  autoRestore: boolean;
  retryAttemptId?: string;
}) {
  const step = useCurveStep(context, entryCurve, recoverBundle);
  const curve = step.curve.kind === "ready" ? step.curve : entryCurve;
  // Periodogram reads and submissions use the step being viewed.
  const viewed = useMemo(
    () =>
      sameContext(step.viewing, context.curveContext)
        ? context
        : { ...context, curveContext: step.viewing },
    [context, step.viewing],
  );
  const total = curve.segments.reduce(
    (sum, segment) => sum + segment.nPoints,
    0,
  );
  const missing = curve.segments.reduce(
    (sum, segment) =>
      sum + segment.flux.filter((point) => point === null).length,
    0,
  );
  if (curve.segments.length === 0 || total === missing)
    return (
      <div className="cx-state" data-testid="cx-no-data">
        {notices}
        <p role="status">표시할 유효 관측 데이터가 없습니다.</p>
        <button type="button" className="cx-secondary" onClick={retry}>
          최신 자료 확인
        </button>
        <DataDetails
          context={viewed}
          viewedBundleId={viewed.curveContext.bundleId}
          curve={curve}
          total={total}
          missing={missing}
        />
      </div>
    );
  return (
    <AnalysisSession
      key={contextKey(curve.context)}
      context={viewed}
      step={step}
      curve={curve}
      recoverBundle={recoverBundle}
      retryDraft={retryDraft}
      resume={resume}
      autoRestore={autoRestore}
      retryAttemptId={retryAttemptId}
    >
      <Workspace
        key={`workspace-${contextKey(curve.context)}`}
        context={viewed}
        entry={context}
        curve={curve}
        notices={notices}
        reload={retry}
        recoverBundle={recoverBundle}
      />
    </AnalysisSession>
  );
}
