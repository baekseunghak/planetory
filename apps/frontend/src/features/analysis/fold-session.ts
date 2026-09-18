import type { FoldResult } from "./fold-client";
import { fullFoldView, type FoldView } from "./folded-curve";
import type { PeriodSelectionChange } from "./period-selection";

export type FoldRequest = {
  change: PeriodSelectionChange;
  resetView: boolean;
};
export type FoldSession = {
  change: PeriodSelectionChange | null;
  request: FoldRequest | null;
  success: { change: PeriodSelectionChange; result: FoldResult } | null;
  view: FoldView;
  rollbackView: FoldView | null;
  status: "idle" | "pending" | "success" | "error" | "cancelled";
  message?: string;
  inputKey: number;
};
export const initialFoldSession: FoldSession = {
  change: null,
  request: null,
  success: null,
  view: fullFoldView,
  rollbackView: null,
  status: "idle",
  inputKey: 0,
};
type Action =
  | { type: "begin"; change: PeriodSelectionChange; resetView?: boolean }
  | { type: "success"; request: FoldRequest; result: FoldResult }
  | { type: "error"; request: FoldRequest; message: string }
  | { type: "cancel" }
  | { type: "view"; update: (view: FoldView) => FoldView };

// One transition owns selection, result and viewport: rollback never paints a mixed pair.
export function foldSessionReducer(
  state: FoldSession,
  action: Action,
): FoldSession {
  switch (action.type) {
    case "begin":
      return {
        ...state,
        change: action.change,
        request: {
          change: action.change,
          resetView:
            action.resetView ??
            (action.change.kind === "reselect" ||
              (state.status === "pending" &&
                Boolean(state.request?.resetView))),
        },
        rollbackView:
          state.status === "pending" ? state.rollbackView : state.view,
        status: "pending",
        message: undefined,
        inputKey:
          state.inputKey +
          (action.change.kind === "reselect" ||
          state.status === "error" ||
          state.status === "cancelled"
            ? 1
            : 0),
      };
    case "success":
      if (state.status !== "pending" || state.request !== action.request)
        return state;
      return {
        ...state,
        success: { change: action.request.change, result: action.result },
        view: action.request.resetView ? fullFoldView : state.view,
        rollbackView: null,
        status: "success",
      };
    case "error":
    case "cancel":
      if (
        state.status !== "pending" ||
        (action.type === "error" && state.request !== action.request)
      )
        return state;
      return {
        ...state,
        change: state.success?.change ?? null,
        view: state.rollbackView ?? fullFoldView,
        rollbackView: null,
        status: action.type === "error" ? "error" : "cancelled",
        message: action.type === "error" ? action.message : undefined,
        inputKey: state.inputKey + 1,
      };
    case "view":
      return { ...state, view: action.update(state.view) };
  }
}

// Downstream editors must also check their own range/context/submission constraints.
export function canUseFold(state: FoldSession): boolean {
  return (
    state.status !== "pending" &&
    state.success !== null &&
    state.change === state.success.change &&
    state.change.selection.periodDays === state.success.result.periodDays
  );
}
