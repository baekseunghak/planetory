// One short line on how to solve tutorial stars 1–5, in the star panel and
// over both analysis variants. Keyed by the tutorial sequence the backend
// gives the star (sky star `marker.seq`, else the quests' tutorial markers),
// never by TIC. Each place can be closed per tutorial (localStorage; a
// blocked store keeps it closed for this page). Stars already 탐사 완료 show
// none. Only one guide is on screen at a time: while a tutorial line shows,
// the first-visit caption and the onboarding line step back (see
// GalaxyView, AnalysisStage).
import { useCallback, useSyncExternalStore } from "react";
import { useOptionalQuests } from "../../features/quests/QuestProvider";
import { useCinemaSky } from "./sky";
import {
  browserStorage,
  closeGuide,
  guideLineFor,
  guidesVersion,
  subscribeGuides,
  type GuidePlace,
} from "./tutorial-guide";

export type TutorialGuideLine = {
  seq: number;
  line: string;
  close(): void;
};

/** The tutorial line for a star in a place, or null (see guideLineFor). */
export function useTutorialGuide(
  ticId: string | null,
  place: GuidePlace,
): TutorialGuideLine | null {
  const { data } = useCinemaSky();
  const quests = useOptionalQuests();
  useSyncExternalStore(subscribeGuides, guidesVersion, guidesVersion);
  const found = ticId
    ? guideLineFor(ticId, place, data.stars, quests?.markers, browserStorage())
    : null;
  const seq = found?.seq ?? null;
  const close = useCallback(() => {
    if (seq !== null) closeGuide(browserStorage(), place, seq);
  }, [place, seq]);
  return found ? { ...found, close } : null;
}

export function TutorialGuideView({
  guide,
  place,
}: {
  guide: TutorialGuideLine;
  place: GuidePlace;
}) {
  return (
    <aside
      className="cinema-tutorial-guide"
      data-place={place}
      aria-label={`튜토리얼 ${guide.seq} 풀이`}
    >
      <p className="cinema-guide-text">
        <b>튜토리얼 {guide.seq}</b> {guide.line}
      </p>
      <button
        type="button"
        className="cinema-mini cinema-guide-close"
        aria-label={`튜토리얼 ${guide.seq} 풀이 닫기`}
        onClick={guide.close}
      >
        풀이 닫기
      </button>
    </aside>
  );
}

export function TutorialGuide({
  ticId,
  place,
}: {
  ticId: string;
  place: GuidePlace;
}) {
  const guide = useTutorialGuide(ticId, place);
  return guide ? <TutorialGuideView guide={guide} place={place} /> : null;
}
