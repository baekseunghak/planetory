import { useAnalysisFold } from "./AnalysisSession";
import { fullFoldView, zoomFoldView } from "./folded-curve";

/** Pointer alternatives remain available in the help disclosure (EXP-13). */
export function FoldViewControls() {
  const { state, setView } = useAnalysisFold();
  return (
    <div role="group" aria-label="접힌 곡선 보기 조작">
      <button
        disabled={!state.success || state.view.zoom <= 1}
        onClick={() => setView((v) => zoomFoldView(v, 0.5))}
      >
        접힌 곡선 축소
      </button>{" "}
      <button
        disabled={!state.success || state.view.zoom >= 32}
        onClick={() => setView((v) => zoomFoldView(v, 2))}
      >
        접힌 곡선 확대
      </button>{" "}
      <button
        disabled={!state.success}
        onClick={() => setView(() => fullFoldView)}
      >
        접힌 곡선 보기 초기화
      </button>
    </div>
  );
}
