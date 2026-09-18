import { useAnalysisFold, usePhaseDraft } from "./AnalysisSession";

/** 봉우리 선택과 미세 조정은 한 단계다. 봉우리를 골라도 단계가 넘어가지 않고
 *  '이 주기로 구간 선택'을 눌러야 다음으로 간다. Figma는 이 둘을 1·2단계로
 *  나누지만 구현은 합친다 (docs/design.md). */
export const stageLabels = ["주기 선택", "구간 선택", "판단", "제출값 확인"];

export function useAnalysisStage() {
  const fold = useAnalysisFold();
  const { state, setState, ready } = usePhaseDraft();
  const confirmed =
    state.preview?.kind === "preview" &&
    state.confirmed === state.preview &&
    !state.dragging;
  const stage = !fold.state.change
    ? 1
    : (state.editingStep ??
      (!ready || !state.range ? 1 : !confirmed ? 2 : state.review ? 4 : 3));
  const go = (next: 1 | 2 | 3) => {
    if (
      (!ready && next !== 1) ||
      !fold.state.change ||
      (next === 3 && !confirmed)
    )
      return;
    setState((previous) => ({ ...previous, editingStep: next, review: null }));
  };
  return { stage, go, ready, confirmed };
}
