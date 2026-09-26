// Pure presentation logic of the new analysis panel. Business rules stay in
// src/features/analysis; this file only turns their state into words, numbers
// and small geometry the panel draws. Everything here is unit tested
// (tests/unit/cinema-analysis-*.test.ts) and must stay free of React and DOM.
import { ApiError } from "../../api/client.ts";
import {
  judgments,
  type Judgment,
} from "../../features/analysis/analysis-judgment.ts";
import type { PeriodogramLoad } from "../../features/analysis/load-periodogram.ts";
import {
  stepPeriod,
  type PeriodSelection,
} from "../../features/analysis/period-selection.ts";
import {
  PeriodogramBundleChanged,
  PeriodogramContextChanged,
} from "../../features/analysis/periodogram-data.ts";
import type {
  PhaseRange,
  PhaseSelectionResult,
  SelectionLimits,
} from "../../features/analysis/phase-selection.ts";
import type { MatchStatus } from "../../features/analysis/submission-data.ts";
import type {
  AchievementResult,
  Evaluation,
} from "../../features/analysis/submission-result.ts";
import type { SubmissionState } from "../../features/analysis/use-submission.ts";
import type {
  AnalysisOutcome,
  AnalysisOutcomeKind,
  WindowSelection,
} from "../analysis/bridge.ts";

/* ------------------------------------------------------------------ fold */

/** A bin needs this many observations before the mean line is drawn. */
export const MIN_BIN_COUNT = 2;

/**
 * Mean flux per phase bin over the visible range. Observations repeat on the
 * two-cycle display exactly like the classic chart (phase - 1, phase, phase + 1);
 * the scientific input is never changed.
 */
export function foldBins(
  phases: ArrayLike<number>,
  flux: ArrayLike<number>,
  low: number,
  high: number,
  bins: number,
): (number | null)[] {
  const span = high - low;
  if (!(span > 0) || !(bins >= 1)) return [];
  const count = Math.floor(bins);
  const sums = new Float64Array(count);
  const counts = new Uint32Array(count);
  for (let i = 0; i < phases.length; i++) {
    const value = flux[i];
    if (!Number.isFinite(value)) continue;
    for (let repeat = -1; repeat <= 1; repeat++) {
      const phase = phases[i] + repeat;
      if (phase < low || phase >= high) continue;
      const bin = Math.min(
        count - 1,
        Math.floor(((phase - low) / span) * count),
      );
      sums[bin] += value;
      counts[bin] += 1;
    }
  }
  return Array.from(sums, (sum, bin) =>
    counts[bin] >= MIN_BIN_COUNT ? sum / counts[bin] : null,
  );
}

/** Bin count for a plot width: about one bin per 6 px, 24..160. */
export const binsForWidth = (width: number) =>
  Math.max(24, Math.min(160, Math.round(width / 6)));

export type WindowStats = {
  /** Observations whose phase falls inside the window. */
  inside: number;
  outside: number;
  /**
   * (mean outside − mean inside) / mean outside. A display estimate only:
   * it is never submitted and the server derives its own values.
   * null when either side is empty or the outside mean is not positive.
   */
  depth: number | null;
};

/** Counts and depth estimate of a display window over folded phases in [0, 1). */
export function windowStats(
  phases: ArrayLike<number>,
  flux: ArrayLike<number>,
  range: PhaseRange,
): WindowStats {
  const low = Math.min(range.phaseStart, range.phaseEnd);
  const high = Math.max(range.phaseStart, range.phaseEnd);
  let inside = 0,
    outside = 0,
    sumIn = 0,
    sumOut = 0;
  for (let i = 0; i < phases.length; i++) {
    const value = flux[i];
    if (!Number.isFinite(value)) continue;
    const phase = phases[i];
    const hit =
      (phase >= low && phase <= high) ||
      (phase - 1 >= low && phase - 1 <= high) ||
      (phase + 1 >= low && phase + 1 <= high);
    if (hit) {
      inside += 1;
      sumIn += value;
    } else {
      outside += 1;
      sumOut += value;
    }
  }
  const meanOut = outside ? sumOut / outside : NaN;
  const depth =
    inside && outside && meanOut > 0
      ? (meanOut - sumIn / inside) / meanOut
      : null;
  return { inside, outside, depth };
}

/**
 * Keyboard move of one window edge, as the classic handles do: 1/1000 of
 * the visible width, Shift ×10, clamped to the display range [-0.5, 1.5].
 */
export function handleStep(
  value: number,
  direction: -1 | 1,
  coarse: boolean,
  low: number,
  high: number,
): number {
  const next = value + ((direction * (high - low)) / 1000) * (coarse ? 10 : 1);
  return Math.max(-0.5, Math.min(1.5, next));
}

/**
 * The keyboard starting window of the classic "구간 선택 시작": the middle of
 * the allowed width, centred on the current view and kept inside the display.
 */
export function keyboardWindow(
  limits: Pick<SelectionLimits, "minPhaseWidth" | "maxPhaseWidth">,
  viewCenter: number,
): PhaseRange {
  const width = (limits.minPhaseWidth + limits.maxPhaseWidth) / 2;
  const center = Math.max(
    -0.5 + width / 2,
    Math.min(1.5 - width / 2, viewCenter),
  );
  return { phaseStart: center - width / 2, phaseEnd: center + width / 2 };
}

/** Pointer x inside a plot of `width` px mapped onto [low, high]. */
export function phaseAt(
  x: number,
  width: number,
  low: number,
  high: number,
): number {
  const ratio = width > 0 ? Math.max(0, Math.min(1, x / width)) : 0;
  return low + ratio * (high - low);
}

/* ---------------------------------------------------------------- period */

/**
 * Arrow keys on the focused periodogram fine-tune a peak's period inside the
 * server's range (the slider's own steps). Returns null when the key does not
 * tune, or the period cannot be tuned (direct picks have no server step).
 */
export function periodKeyStep(
  selection: PeriodSelection | null,
  key: string,
  coarse: boolean,
): number | null {
  if (!selection || selection.step === null || selection.fineStep === null)
    return null;
  switch (key) {
    case "Home":
      return selection.minimum;
    case "End":
      return selection.maximum;
    case "PageUp":
      return stepPeriod(selection, 1, true);
    case "PageDown":
      return stepPeriod(selection, -1, true);
    case "ArrowRight":
    case "ArrowUp":
      return stepPeriod(selection, 1, coarse);
    case "ArrowLeft":
    case "ArrowDown":
      return stepPeriod(selection, -1, coarse);
    default:
      return null;
  }
}

/** Grid cursor for direct picks with the keyboard, clamped to the grid. */
export function moveCursor(
  cursor: number | null,
  fallback: number,
  delta: number,
  size: number,
): number {
  const from = cursor ?? fallback;
  return Math.max(0, Math.min(size - 1, Math.round(from + delta)));
}

export type PeriodogramLoadState =
  | { kind: "loading" }
  | { kind: "error"; error: Error }
  | { kind: "loaded"; data: PeriodogramLoad };

/**
 * The classic PeriodogramPanel's words for every load state, unchanged.
 * `reload-analysis` reloads context and curve together; `retry` the periodogram.
 */
export function periodogramNotice(state: PeriodogramLoadState): {
  message: string;
  action: "reload-analysis" | "retry" | null;
} {
  if (state.kind === "loading")
    return { message: "주기도와 봉우리를 불러오고 있습니다…", action: null };
  if (state.kind === "error") {
    const error = state.error;
    const needsContext = error instanceof PeriodogramContextChanged;
    const message = needsContext
      ? error instanceof PeriodogramBundleChanged
        ? "데이터 판이 계속 바뀌어 주기도 조회를 중단했습니다. 잠시 후 분석 자료를 다시 불러와 주세요."
        : "시간 곡선과 주기도의 문맥이 달라 표시를 중단했습니다. 분석 자료를 다시 불러와 주세요."
      : error instanceof ApiError && error.status === 403
        ? "이 주기도를 볼 권한이 없습니다. 접근 상태를 확인한 뒤 다시 불러와 주세요."
        : error instanceof ApiError && error.status === 404
          ? "주기도 자료를 찾을 수 없거나 볼 수 없습니다. 잠시 후 다시 불러와 주세요."
          : `주기도를 불러오지 못했습니다. ${error.message}`;
    return { message, action: needsContext ? "reload-analysis" : "retry" };
  }
  if (state.data.kind === "ready")
    return {
      message:
        "주기도를 불러왔습니다. 그래프 탐색은 주기 선택값을 변경하지 않습니다.",
      action: null,
    };
  const { reason, pending } = state.data;
  const needsContext =
    reason === "rules-unavailable" || reason === "curve-not-ready";
  const message =
    reason === "rules-unavailable"
      ? "이 곡선의 주기도와 선택 규칙은 아직 연결되지 않았습니다. 자료가 준비되면 분석 자료를 다시 불러와 주세요."
      : reason === "curve-not-ready"
        ? "유효한 시간 곡선이 준비되어야 주기도를 표시할 수 있습니다. 분석 자료를 다시 불러와 주세요."
        : reason === "empty-peaks"
          ? "표시할 추천 봉우리 자료가 없습니다. 신호가 없다는 뜻은 아닙니다. 자료를 다시 불러와 주세요."
          : pending?.status === "FAILED"
            ? "주기도 계산에 실패했습니다. 잠시 후 주기도를 다시 불러와 주세요."
            : pending?.status
              ? "주기도를 준비하고 있습니다. 잠시 후 다시 불러와 주세요."
              : "이 단계의 주기도 계산 결과가 없습니다. 자료가 준비되면 다시 불러와 주세요.";
  return { message, action: needsContext ? "reload-analysis" : "retry" };
}

/* ---------------------------------------------------------------- window */

/** The bridge payload for the scene's ghost planet. */
export function bridgeSelection(
  preview: PhaseSelectionResult | null,
  confirmed: boolean,
): WindowSelection | null {
  if (preview?.kind !== "preview") return null;
  return {
    periodDays: preview.selection.periodDays,
    startPhase: preview.selection.phaseStart,
    endPhase: preview.selection.phaseEnd,
    durationHours: preview.durationPreviewHours,
    confirmed,
  };
}

/**
 * A shorter hint for an invalid window. The width rule is the server's
 * (getSelectionLimits); this only says which way to move. Other issues keep
 * the rule's own message.
 */
export function windowHint(
  preview: PhaseSelectionResult | null,
  range: PhaseRange | null,
  limits: SelectionLimits | null,
  periodDays: number | null,
): string | null {
  if (!range || preview?.kind !== "invalid") return null;
  const issue = preview.issues[0];
  if (issue.code === "DURATION_OUT_OF_RANGE" && limits && periodDays) {
    const width = Math.abs(range.phaseEnd - range.phaseStart);
    const days = width * periodDays;
    if (days > limits.maxWindowDays || width > limits.maxPhaseWidth)
      return "구간이 허용 폭보다 넓습니다. 확대한 뒤 더 좁게 고르세요.";
    if (days < limits.minWindowDays)
      return "구간이 허용 폭보다 좁습니다. 조금 더 넓게 고르세요.";
  }
  return issue.message;
}

/** The classic fold panel's status words. */
export function foldMessage(options: {
  inputError: string | null;
  points: number;
  status: "idle" | "pending" | "success" | "error" | "cancelled";
  message?: string;
  hasSuccess: boolean;
  hasChange: boolean;
}): string {
  const restored = options.hasSuccess
    ? " 마지막으로 성공한 주기와 그래프·확대 위치로 복구했습니다."
    : " 아직 성공한 접기 결과가 없습니다.";
  if (options.inputError) return options.inputError;
  if (!options.points)
    return "접을 유효 관측 데이터가 없습니다. 신호가 없다는 뜻은 아닙니다.";
  if (options.status === "error")
    return `접기에 실패했습니다. ${options.message ?? ""}${restored} 다시 계산하면 실패한 주기를 재시도합니다.`;
  if (options.status === "cancelled")
    return `접기를 취소했습니다.${restored} 다시 계산하면 취소한 주기를 재시도합니다.`;
  if (!options.hasChange) return "주기를 선택하면 현재 곡선을 접어 표시합니다.";
  return "주기를 조정하면 그래프를 갱신합니다. 그래프에는 마지막 계산 완료 결과를 표시합니다.";
}

/* ------------------------------------------------------------- guidance */

export type GuidanceInput = {
  periodogram: "loading" | "unavailable" | "ready";
  stage: 1 | 2 | 3 | 4;
  period: "none" | "peak" | "direct";
  /** A fold has been pending long enough to mention (useSustained). */
  folding: boolean;
  /** Fold failed, was cancelled, or there is nothing to fold. */
  foldProblem: boolean;
  zoom: number;
  range: boolean;
  dragging: boolean;
  preview: "none" | "valid" | "invalid";
  hint: string | null;
  judgment: boolean;
  submission: "idle" | "busy" | "problem" | "accepted";
  /** A curve step being prepared (its name), or null. */
  preparing: string | null;
};

/** The one short guidance line at the top of the panel. */
export function guidance(g: GuidanceInput): string {
  if (g.submission === "busy")
    return "제출하고 있습니다. 결과를 기다려 주세요.";
  if (g.submission === "accepted")
    return "결과가 나왔습니다. 자세히 보거나 다음 할 일을 고르세요.";
  if (g.submission === "problem")
    return "제출을 마치지 못했습니다. 판단 칸의 안내를 확인해 주세요.";
  if (g.preparing)
    return `${g.preparing}을 준비하고 있습니다. 준비되면 곡선이 바뀝니다.`;
  if (g.periodogram === "loading") return "주기도를 불러오고 있습니다.";
  if (g.periodogram === "unavailable")
    return "주기도를 표시할 수 없습니다. 주기 칸의 안내를 확인해 주세요.";
  if (g.folding) return "선택한 주기로 곡선을 접고 있습니다.";
  if (g.foldProblem)
    return "접힌 곡선을 만들지 못했습니다. 구간 칸의 안내를 확인해 주세요.";
  if (g.stage === 1) {
    if (g.period === "none")
      return "추천 봉우리를 고르거나, 그래프를 눌러 주기를 직접 고르세요.";
    if (g.period === "direct")
      return "접힌 곡선에서 밝기가 떨어지는 구간을 드래그하세요.";
    return "주기를 다듬고, 접힌 곡선에서 밝기가 떨어지는 구간을 드래그하세요.";
  }
  if (g.stage === 2) {
    if (g.dragging) return "구간을 고르는 중입니다.";
    if (g.preview === "invalid") return g.hint ?? "구간을 다시 골라 주세요.";
    if (!g.range)
      return g.zoom < 4
        ? "휠이나 + 키로 확대한 뒤, 밝기가 떨어지는 구간을 드래그하세요."
        : "밝기가 떨어지는 구간을 드래그하세요.";
    return "양 끝 핸들로 다듬고, 행성 같은지 판단을 고르세요.";
  }
  if (!g.judgment) return "이 구간이 행성의 통과 같은지 판단을 고르세요.";
  return "근거와 메모는 선택입니다. 준비되면 제출하세요.";
}

/* --------------------------------------------------------------- result */

export type Tone = "good" | "warn" | "bad" | "info" | "new";
export type InlineResult = {
  kind: AnalysisOutcomeKind;
  tone: Tone;
  eyebrow: string;
  title: string;
  chips: { label: string; tone: Tone }[];
};

const MATCH_CHIP: Partial<Record<MatchStatus, [string, Tone]>> = {
  matched: ["신호 일치", "good"],
  matched_harmonic: ["배수 주기로 일치", "good"],
  duplicate: ["이미 찾은 신호", "info"],
  not_matched: ["신호 불일치", "bad"],
  ambiguous_match: ["판정 보류", "warn"],
};
const EVALUATION_CHIP: Partial<Record<Evaluation, [string, Tone]>> = {
  AGREES: ["판단 일치", "good"],
  DISAGREES: ["판단 불일치", "warn"],
  UNSURE: ["모르겠음 · 채점 안 함", "info"],
  UNSCORED: ["미확정 · 채점 안 함", "info"],
};
const ACHIEVEMENT_CHIP: Partial<Record<AchievementResult, [string, Tone]>> = {
  recognized: ["성과 인정", "good"],
  judgment_mismatch: ["성과 미인정", "warn"],
  pending_publish: ["공개 후 판정", "info"],
  already_recognized: ["이미 인정됨", "info"],
};

/**
 * The compact result shown in the panel. Every chip comes from a real field
 * of the accepted receipt (match status, evaluation, achievement, unlocked
 * stars); nothing is inferred from another axis.
 */
export function inlineResult(
  outcome: Pick<
    AnalysisOutcome,
    "kind" | "matchStatus" | "evaluation" | "achievement" | "planet"
  >,
): InlineResult {
  const head = ((): Omit<InlineResult, "chips" | "kind"> => {
    switch (outcome.kind) {
      case "matched":
        return outcome.planet?.isPlanet === false
          ? {
              tone: "good",
              eyebrow: "판정 일치",
              title: "행성이 아닌 신호를 가려냈습니다",
            }
          : {
              tone: "good",
              eyebrow: "발견",
              title:
                outcome.planet?.isPlanet === true
                  ? "행성 신호를 찾았습니다"
                  : "신호를 찾았습니다",
            };
      case "judgmentMismatch":
        return {
          tone: "warn",
          eyebrow: "판단 불일치",
          title: "구간은 맞았고, 판단은 달랐습니다",
        };
      case "pendingPublish":
        return {
          tone: "info",
          eyebrow: "공개 대기",
          title: "신호와 맞았습니다. 공개하면 성과 판정을 받습니다",
        };
      case "duplicate":
        return {
          tone: "info",
          eyebrow: "이미 찾은 신호",
          title: "이미 찾은 신호입니다",
        };
      case "numericMismatch":
        return {
          tone: "bad",
          eyebrow: "신호 불일치",
          title: "고른 주기와 구간에서 맞는 신호를 찾지 못했습니다",
        };
      case "ambiguous":
        return {
          tone: "warn",
          eyebrow: "판정 보류",
          title: "어느 신호인지 가리지 못했습니다",
        };
      case "noCandidate":
        return {
          tone: "info",
          eyebrow: "접수",
          title: "더 이상 없음으로 접수했습니다",
        };
      case "skipped":
        return {
          tone: "info",
          eyebrow: "접수",
          title: "이 별을 건너뛰었습니다",
        };
      default:
        return {
          tone: "info",
          eyebrow: "접수",
          title: "접수되었습니다. 자세한 결과를 확인해 주세요",
        };
    }
  })();
  const chips: InlineResult["chips"] = [];
  const push = (entry: [string, Tone] | undefined) => {
    if (entry) chips.push({ label: entry[0], tone: entry[1] });
  };
  push(MATCH_CHIP[outcome.matchStatus]);
  if (outcome.evaluation) push(EVALUATION_CHIP[outcome.evaluation]);
  push(ACHIEVEMENT_CHIP[outcome.achievement.result]);
  if (outcome.achievement.unlockedTicIds.length)
    chips.push({
      label: `새 별 ${outcome.achievement.unlockedTicIds.length}개`,
      tone: "new",
    });
  // The eyebrow already says it once ("신호 불일치", "판단 불일치").
  return {
    kind: outcome.kind,
    ...head,
    chips: chips.filter((chip) => chip.label !== head.eyebrow),
  };
}

/** The judgment a stored submission body carried, if it is a known value. */
export function judgmentFromBody(body: unknown): Judgment | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).userJudgment;
  return judgments.some((item) => item.value === value)
    ? (value as Judgment)
    : null;
}

/* ----------------------------------------------------------- submission */

export type SubmissionAction =
  "check" | "resend" | "submitAsNew" | "prepare" | "reloadBundle" | "dismiss";

export type SubmissionView = {
  busy: boolean;
  title: string;
  message: string;
  /** Announce as an alert (a problem) instead of a status. */
  alert: boolean;
  actions: SubmissionAction[];
  fieldErrors: { field: string; label: string; reason: string }[];
  note: string | null;
};

// Server field paths in the user's words. Unknown paths stay as they are.
const FIELD_LABELS: Record<string, string> = {
  "selection.periodDays": "주기",
  "selection.phaseStart": "구간 시작",
  "selection.phaseEnd": "구간 끝",
  "selection.sourcePeakGridIndex": "선택한 봉우리",
  selection: "선택 구간",
  userJudgment: "판단",
  evidenceChecks: "근거",
  memo: "메모",
  curveContext: "분석 자료 상태",
  requestId: "요청 번호",
};
export const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;

/** Residual readiness in plain words; unknown values are shown as they are. */
export function residualNote(status: string | null): string {
  if (status === null) return "계산을 아직 시작하지 않았습니다.";
  if (status === "QUEUED") return "계산을 기다리는 중입니다.";
  if (status === "FAILED") return "계산이 실패했습니다.";
  return `계산 상태 ${status}`;
}

/** How an accepted receipt reached us, in the classic's words. */
export function acceptedNotice(
  recovered: boolean,
  outcome: "created" | "replayed",
): string {
  if (!recovered)
    return outcome === "created"
      ? "제출이 접수되었습니다."
      : "같은 내용이 이미 접수돼 있어 그 결과를 그대로 보여 줍니다.";
  return outcome === "created"
    ? "응답을 받지 못해 다시 확인했고, 이번에 접수되었습니다."
    : "이미 접수돼 있던 제출을 확인했습니다. 다시 접수되지 않았습니다.";
}

/**
 * Every non-accepted submission state with the classic dialog's words and the
 * same recovery actions. Accepted receipts are shown by the result view.
 */
export function submissionView(
  state: SubmissionState,
  options: { resendable: boolean; canPrepare: boolean },
): SubmissionView | null {
  const base = {
    busy: false,
    alert: true,
    fieldErrors: [] as SubmissionView["fieldErrors"],
    note: null as string | null,
  };
  if (state.phase === "idle") return null;
  if (state.phase === "sending" || state.phase === "checking")
    return {
      ...base,
      busy: true,
      alert: false,
      title: "제출하고 있습니다",
      message:
        state.phase === "sending"
          ? "서버에 보내는 중입니다. 응답을 받지 못해도 같은 요청 번호로 결과를 확인하므로 두 번 접수되지 않습니다."
          : "접수 결과를 확인하고 있습니다.",
      actions: [],
    };
  switch (state.state) {
    case "accepted":
      return null;
    case "unresolved":
      return {
        ...base,
        title: "접수 여부를 확인해 주세요",
        message: state.message,
        actions: options.resendable ? ["check", "resend"] : ["check"],
      };
    case "context-not-ready":
      return {
        ...base,
        title: "아직 제출할 수 없습니다",
        message:
          "이 단계의 계산이 아직 끝나지 않았습니다. 준비되면 같은 내용을 그대로 다시 보낼 수 있습니다.",
        actions: options.canPrepare ? ["prepare", "dismiss"] : ["dismiss"],
        note: state.residual
          ? `${residualNote(state.residual.status)}${state.residual.jobId ? ` · 작업 번호 ${state.residual.jobId}` : ""}`
          : null,
      };
    case "bundle-changed":
      return {
        ...base,
        title: "제출하지 못했습니다",
        message:
          "별의 데이터 판이 바뀌었습니다. 최신 자료를 다시 불러온 뒤 주기와 구간을 다시 골라 주세요.",
        actions: ["reloadBundle", "dismiss"],
      };
    case "expired":
      return {
        ...base,
        title: "제출하지 못했습니다",
        message: "로그인이 만료되었습니다. 다시 로그인한 뒤 제출해 주세요.",
        actions: ["dismiss"],
      };
    case "conflict":
      return {
        ...base,
        title: "제출하지 못했습니다",
        message: state.message,
        actions: ["check", "submitAsNew", "dismiss"],
      };
    case "denied":
      return {
        ...base,
        title: "제출하지 못했습니다",
        message: state.message,
        actions: ["check", "dismiss"],
      };
    case "rejected":
      return {
        ...base,
        title: "제출하지 못했습니다",
        message: state.message,
        actions: ["dismiss"],
        fieldErrors: state.fieldErrors.map((error) => ({
          field: error.field,
          label: fieldLabel(error.field),
          reason: error.reason,
        })),
      };
  }
}

/* ---------------------------------------------------------------- format */

export const format = {
  period: (days: number) => days.toFixed(6),
  hours: (hours: number) => hours.toFixed(2),
  btjd: (value: number) => value.toFixed(4),
  phase: (value: number) => value.toFixed(4),
  /** Relative depth as a percentage with two decimals. */
  depth: (depth: number | null) => {
    if (depth === null) return "—";
    const percent = Math.round(depth * 10000) / 100;
    // Never print "-0.00" for a flat window.
    return (percent === 0 ? 0 : percent).toFixed(2);
  },
  strength: (value: number) => value.toFixed(2),
};
