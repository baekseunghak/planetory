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
  /** First visit: the shell flies to tutorial star 1 once per sign-in. */
  firstVisit: boolean;
  markFirstVisitFlown(): boolean;
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
