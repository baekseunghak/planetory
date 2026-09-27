import { createContext, useContext } from "react";
import type { SequenceDirector, SequenceState } from "./sequences";
import type { StageTarget } from "./stage";
import type { FocusedStar } from "./star-detail";

export type PanelSide = "right" | "bottom";

export type Shell = {
  target: StageTarget;
  /** Detail of the star on stage (selection or analysis). */
  focus: FocusedStar;
  director: SequenceDirector;
  sequence: SequenceState;
  /** Width/height a panel covers, so the scene frames the star beside it. */
  reportPanel(side: PanelSide, px: number): void;
  selectStar(ticId: string): void;
  closeStar(): void;
  toast(message: string): void;
  /**
   * First visit: after the login fly-in the shell flies to tutorial star 1,
   * once per member (tutorial-guide.ts `takeFirstVisitFlight`).
   */
  firstVisit: boolean;
  /** Takes the flight: true only the first time for this member. */
  markFirstVisitFlown(): boolean;
  /**
   * The first-login story is on screen (FirstStory, newcomers once per
   * member): the galaxy waits far away, and so does the flight above.
   */
  story: boolean;
  /** Star that just ignited, marked until the member's next interaction. */
  newStar: string | null;
  clearNewStar(): void;
};

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const value = useContext(ShellContext);
  if (!value) throw new Error("CinemaLayout 안에서 사용해 주세요.");
  return value;
}
