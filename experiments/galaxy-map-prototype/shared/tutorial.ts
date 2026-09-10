export type TutorialEvent =
  | "star_selected"
  | "peak_selected"
  | "interval_selected"
  | "judgment_selected"
  | "submission_succeeded";
export const TUTORIAL_EVENTS: TutorialEvent[] = [
  "star_selected",
  "peak_selected",
  "interval_selected",
  "judgment_selected",
  "submission_succeeded",
];
export function nextTutorialStep(
  step: number | null,
  event: TutorialEvent,
): number | null {
  if (step === null || TUTORIAL_EVENTS[step] !== event) return step;
  return step === 4 ? null : step + 1;
}
