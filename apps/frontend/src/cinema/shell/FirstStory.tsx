// A newcomer's first login: four lines over the far-away galaxy, one at a
// time, then "시작하기". "건너뛰기" (or Escape) is there from the start.
// Either one ends the story; the shell then flies in (useStageDirector
// `holdIntro`) and on to tutorial 1. Lines, timing and the once-per-member
// flag: ./first-story.ts. Reduced motion shows every line and the button
// at once.
import { useEffect, useRef, useState } from "react";
import { useSceneState } from "../scene";
import {
  STORY_LINES,
  STORY_SKIP,
  STORY_START,
  storyChanges,
  storyFrame,
} from "./first-story";

export function FirstStory({
  leaving,
  onStart,
}: {
  /** Started (or skipped): the layer fades out while the fly-in begins. */
  leaving: boolean;
  onStart(): void;
}) {
  const { reducedMotion } = useSceneState();
  const began = useRef(performance.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const now = performance.now() - began.current;
    const timers = storyChanges(reducedMotion)
      .filter((at) => at > now)
      .map((at) => setTimeout(() => setElapsed(at), at - now));
    return () => timers.forEach(clearTimeout);
  }, [reducedMotion]);
  const frame = storyFrame(elapsed, reducedMotion);

  // Keyboard and screen reader: the story first, then the button it leads to.
  const layer = useRef<HTMLElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    layer.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (frame.button) start.current?.focus({ preventScroll: true });
  }, [frame.button]);
  useEffect(() => {
    if (leaving) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onStart();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [leaving, onStart]);

  return (
    <section
      ref={layer}
      className="cinema-story"
      aria-label="처음 오신 탐사자께"
      data-leaving={leaving ? "true" : "false"}
      data-reduced={reducedMotion ? "true" : "false"}
      tabIndex={-1}
    >
      {/* Read as one passage; the fading copies below are for the eye. */}
      <p className="cinema-sr-only">{STORY_LINES.join(" ")}</p>
      <div className="cinema-story-lines" aria-hidden="true">
        {STORY_LINES.map((line, index) => (
          <p
            key={line}
            className="cinema-story-line"
            data-state={
              reducedMotion || (index === frame.line && frame.shown)
                ? "in"
                : index <= frame.line
                  ? "out"
                  : "next"
            }
          >
            {line}
          </p>
        ))}
      </div>
      <div className="cinema-story-actions">
        {frame.button && (
          <button
            ref={start}
            type="button"
            className="cinema-primary cinema-story-start"
            disabled={leaving}
            onClick={onStart}
          >
            {STORY_START}
          </button>
        )}
      </div>
      <button
        type="button"
        className="cinema-story-skip"
        aria-keyshortcuts="Escape"
        disabled={leaving}
        onClick={onStart}
      >
        {STORY_SKIP}
      </button>
    </section>
  );
}
