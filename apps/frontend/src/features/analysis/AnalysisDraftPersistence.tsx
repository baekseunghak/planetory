import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/SessionProvider";
import {
  draftStorageGeneration,
  sessionDraftKey,
} from "../../auth/session-draft-storage";
import type { AnalysisContext } from "./analysis-data";
import {
  emptyPhaseDraft,
  useAnalysisFold,
  usePhaseDraft,
} from "./AnalysisSession";
import type {
  PeriodSelection,
  PeriodSelectionChange,
  ReadyPeriodogram,
} from "./period-selection";
import { previewPhaseSelection } from "./phase-selection";
import {
  draftIdentity,
  readSavedDraft,
  restoreDraftPeriod,
  type SavedAnalysisDraft,
} from "./session-draft";

export function AnalysisDraftPersistence({
  context,
  data,
  onRestore,
}: {
  context: AnalysisContext;
  data: ReadyPeriodogram;
  onRestore: (selection: PeriodSelection) => PeriodSelectionChange;
}) {
  const auth = useSession();
  const fold = useAnalysisFold();
  const { state: phase, setState } = usePhaseDraft();
  const key = sessionDraftKey(auth.member!.memberId, context.ticId);
  const identity = useMemo(
    () => draftIdentity(context, data, fold.input.data?.dataId ?? ""),
    [context, data, fold.input.data?.dataId],
  );
  const lease = useRef(draftStorageGeneration());
  const [initial] = useState(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return { saved: null, notice: "" };
      try {
        return { saved: readSavedDraft(raw, identity), notice: "" };
      } catch {
        sessionStorage.removeItem(key);
        return {
          saved: null,
          notice:
            "자료·계산 규칙이 바뀌었거나 초안이 손상되어 복원하지 않았습니다.",
        };
      }
    } catch {
      return {
        saved: null,
        notice:
          "이 브라우저에서는 초안을 저장할 수 없습니다. 화면을 나가면 입력이 사라집니다.",
      };
    }
  });
  const [saved, setSaved] = useState(initial.saved);
  const [notice, setNotice] = useState(initial.notice);
  const [restoring, setRestoring] = useState<{
    draft: SavedAnalysisDraft;
    change: PeriodSelectionChange;
  } | null>(null);
  const change = fold.state.success?.change;
  useEffect(() => {
    if (!restoring) return;
    if (fold.ready && change === restoring.change) {
      const { range, judgment } = restoring.draft;
      const preview = range
        ? previewPhaseSelection(
            context,
            data,
            change,
            range.phaseStart,
            range.phaseEnd,
          )
        : null;
      setState({
        ...emptyPhaseDraft,
        range,
        committed: range,
        preview,
        committedPreview: preview,
        judgment,
      });
      setSaved(null);
      setRestoring(null);
      setNotice("초안을 불러왔습니다. 선택 구간과 판단을 다시 확인해 주세요.");
    } else if (
      fold.state.status !== "pending" ||
      fold.state.change !== restoring.change
    ) {
      setRestoring(null);
      setNotice(
        "초안의 주기를 복원하지 못했습니다. 초안 불러오기로 다시 시도해 주세요.",
      );
    }
  }, [
    restoring,
    fold.ready,
    fold.state.status,
    fold.state.change,
    change,
    context,
    data,
    setState,
  ]);
  // A new manual selection replaces the offered draft only after a successful fold.
  useEffect(() => {
    if (saved && !restoring && fold.ready && change) setSaved(null);
  }, [saved, restoring, fold.ready, change]);
  useEffect(() => {
    if (
      !fold.ready ||
      !change ||
      saved ||
      restoring ||
      lease.current !== draftStorageGeneration()
    )
      return;
    const draft: SavedAnalysisDraft = {
      schema: 1,
      identity,
      periodDays: change.selection.periodDays,
      sourcePeakGridIndex: change.selection.sourcePeakGridIndex,
      range: phase.committed,
      judgment: phase.judgment,
    };
    try {
      sessionStorage.setItem(key, JSON.stringify(draft));
    } catch {
      setNotice(
        "초안을 저장하지 못했습니다. 현재 입력은 유지되지만 화면을 나가면 사라질 수 있습니다.",
      );
    }
  }, [
    fold.ready,
    change,
    saved,
    restoring,
    identity,
    key,
    phase.committed,
    phase.judgment,
  ]);
  const restore = () => {
    if (!saved) return;
    try {
      const selection = restoreDraftPeriod(saved, data);
      setRestoring({ draft: saved, change: onRestore(selection) });
      setNotice("저장한 주기로 접기를 계산한 뒤 초안을 불러옵니다.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  };
  const discard = () => {
    try {
      sessionStorage.removeItem(key);
      setSaved(null);
      setNotice("저장된 초안을 지웠습니다.");
    } catch {
      setNotice(
        "저장된 초안을 지우지 못했습니다. 브라우저 저장소 설정을 확인해 주세요.",
      );
    }
  };
  return (
    <section aria-label="분석 초안" className="analysis-draft">
      <p>
        주기·구간·판단·근거·메모를 이 탭에 임시 저장합니다. 새로고침하거나 같은
        탭으로 돌아왔을 때 불러올 수 있습니다. 로그아웃·세션 만료 시 지웁니다.
      </p>
      {saved && (
        <div className="periodogram-toolbar">
          <span>이 항성의 저장된 초안이 있습니다.</span>
          <button
            type="button"
            disabled={fold.state.status === "pending"}
            onClick={restore}
          >
            초안 불러오기
          </button>
          <button
            type="button"
            disabled={fold.state.status === "pending"}
            onClick={discard}
          >
            저장된 초안 지우기
          </button>
        </div>
      )}
      <p role="status">{notice}</p>
    </section>
  );
}
