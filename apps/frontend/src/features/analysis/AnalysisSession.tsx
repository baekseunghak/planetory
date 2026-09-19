import { createContext, useContext, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { AnalysisContext, CurveData } from "./analysis-data";
import type { PhaseRange, PhaseSelectionResult } from "./phase-selection";
import type { PeriodSelectionChange } from "./period-selection";
import { useFoldSession } from "./use-fold-session";
import {
  emptyJudgment,
  type JudgmentDraft,
  type CandidateReview,
  type PhasePreview,
} from "./analysis-judgment";

export type PhaseDraft = {
  editingStep?: 1 | 2 | 3;
  range: PhaseRange | null;
  committed: PhaseRange | null;
  preview: PhaseSelectionResult | null;
  committedPreview: PhaseSelectionResult | null;
  dragging: boolean;
  message: string;
  focus: number;
  judgment: JudgmentDraft;
  confirmed: PhasePreview | null;
  review: CandidateReview | null;
};
export const emptyPhaseDraft: PhaseDraft = {
  range: null,
  committed: null,
  preview: null,
  committedPreview: null,
  dragging: false,
  message: "",
  focus: 0,
  judgment: emptyJudgment,
  confirmed: null,
  review: null,
};
const FoldContext = createContext<ReturnType<typeof useFoldSession> | null>(
  null,
);
/**
 * 최신 판을 다시 불러오는 손잡이. 제출이 `BUNDLE_CHANGED`로 거절되면 화면이
 * 이걸 불러 실제 재조회로 잇는다. 안내만 띄우고 끝내면 사용자는 같은 낡은
 * 스냅샷을 그대로 다시 보내게 된다.
 */
const BundleRecoveryContext = createContext<(() => boolean) | null>(null);
export const useBundleRecovery = () => useContext(BundleRecoveryContext);

const DraftContext = createContext<{
  state: PhaseDraft;
  setState: Dispatch<SetStateAction<PhaseDraft>>;
  ready: boolean;
} | null>(null);

function PhaseDraftProvider({
  ready,
  change,
  children,
}: {
  ready: boolean;
  change: PeriodSelectionChange | null;
  children: ReactNode;
}) {
  const [identity, setIdentity] = useState(change);
  const [state, setState] = useState(emptyPhaseDraft);
  // A new successful fold invalidates the draft before children paint. Pending
  // requests keep the last committed draft for atomic failure/cancel recovery.
  if (identity !== change) {
    setIdentity(change);
    setState(emptyPhaseDraft);
  } else if (!ready && state.dragging) {
    setState({
      ...state,
      range: state.committed,
      preview: state.committedPreview,
      dragging: false,
    });
  }
  return (
    <DraftContext.Provider value={{ state, setState, ready }}>
      {children}
    </DraftContext.Provider>
  );
}

export function AnalysisSession({
  context,
  curve,
  recoverBundle,
  children,
}: {
  context: AnalysisContext;
  curve: CurveData;
  recoverBundle: () => boolean;
  children: ReactNode;
}) {
  const session = useFoldSession(context, curve);
  return (
    <BundleRecoveryContext.Provider value={recoverBundle}>
      <FoldContext.Provider value={session}>
        <PhaseDraftProvider
          ready={session.ready}
          change={session.state.success?.change ?? null}
        >
          {children}
        </PhaseDraftProvider>
      </FoldContext.Provider>
    </BundleRecoveryContext.Provider>
  );
}
export function useAnalysisFold() {
  const session = useContext(FoldContext);
  if (!session) throw new Error("Analysis fold requires its session.");
  return session;
}
export function usePhaseDraft() {
  const draft = useContext(DraftContext);
  if (!draft) throw new Error("Phase draft requires its session.");
  return draft;
}
export function useCurrentPhasePreview() {
  const draft = useContext(DraftContext);
  return draft?.ready && draft.state.preview?.kind === "preview"
    ? draft.state.preview
    : null;
}
