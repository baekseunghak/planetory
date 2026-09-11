import { useApp } from "../App";
import type { TutorialEvent } from "../../shared/tutorial";

/** Analysis-owner integration: call only after a valid user operation succeeds. */
export function useAnalysisGuide(starId: string) {
  const { guide, guideStarId, advanceGuide } = useApp();
  return {
    step: guideStarId === starId ? guide : null,
    complete: (event: TutorialEvent) => advanceGuide(starId, event),
  };
}
export function AnalysisGuide({ starId }: { starId: string }) {
  const { step } = useAnalysisGuide(starId);
  const { setGuide } = useApp();
  if (step === null) return null;
  const target = [
    "tutorial-peak",
    "tutorial-peak",
    "tutorial-interval",
    "tutorial-judgment",
    "tutorial-submit",
  ][step];
  const messages = [
    "반복되는 봉우리를 선택해 보세요",
    "반복되는 봉우리를 선택해 보세요",
    "별빛이 줄어드는 구간을 선택하세요",
    "내 판단과 근거를 남기세요",
    "분석을 제출해 첫 탐사를 기록하세요",
  ];
  return (
    <aside className="guide-banner" role="status" aria-label="첫 탐사 안내">
      <strong>
        {Math.min(5, step + 1)}/5 · {messages[step]}
      </strong>
      <button
        onClick={() => {
          const el = document.getElementById(target);
          el?.scrollIntoView({ block: "center", behavior: "smooth" });
          el?.focus();
        }}
      >
        안내 위치로 이동
      </button>
      <button onClick={() => setGuide(null)}>안내 닫기</button>
    </aside>
  );
}
