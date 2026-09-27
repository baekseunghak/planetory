// Analysis -> shell/scene bridge (frozen). Both analysis variants emit these
// events; the shell turns them into scene calls (ghost orbit, transit, planet,
// ignition) and into `publishSkyChange`. Builders may only ADD optional fields
// and must say so in their report.
//
// Emitting never changes analysis state and never throws into it: a broken
// listener is logged and skipped so a scene bug cannot cost a submission.
import { useEffect, useRef } from "react";
import type { Judgment } from "../../features/analysis/analysis-judgment";
import type { ReadyPeriodogram } from "../../features/analysis/period-selection";
import type {
  MatchStatus,
  NextAction,
  SubmissionKind,
  SubmissionReceipt,
} from "../../features/analysis/submission-data";
import type {
  AchievementResult,
  Disposition,
  Evaluation,
} from "../../features/analysis/submission-result";
import type { SubmissionResult } from "../../features/analysis/submit-analysis";

export type Unsubscribe = () => void;

export type PeriodChange = {
  ticId: string;
  periodDays: number;
  /** 0..1, `periodStrength`: power at this period over the strongest power. */
  strength: number;
  /** Recommended peak it came from; null for a direct pick. */
  sourcePeakGridIndex: number | null;
  operation: "reselect" | "fine-tune";
};

export type WindowSelection = {
  periodDays: number;
  /** [0, 1). `endPhase` may exceed 1 when the window wraps. */
  startPhase: number;
  endPhase: number;
  durationHours: number;
  /** The user confirmed the window (moved on to the judgment). */
  confirmed: boolean;
};

/**
 * What happened, for the scene. Derived from the accepted receipt only
 * (`classifyOutcome`), never from the HTTP status.
 *
 * | kind               | match.status                     | achievement.result  |
 * | ------------------ | -------------------------------- | ------------------- |
 * | matched            | matched, matched_harmonic        | recognized          |
 * | judgmentMismatch   | matched, matched_harmonic        | judgment_mismatch   |
 * | pendingPublish     | matched, matched_harmonic        | pending_publish     |
 * | duplicate          | duplicate (or already_recognized)| already_recognized  |
 * | numericMismatch    | not_matched                      | none                |
 * | ambiguous          | ambiguous_match                  | none                |
 * | noCandidate        | none_wrong                       | none                |
 * | skipped            | skipped                          | none                |
 * | unknown            | any other combination            |                     |
 *
 * A result whose acceptance is unknown is not an outcome: it arrives as
 * `submitFailed` with `state: "unresolved"`.
 */
export type AnalysisOutcomeKind =
  | "matched"
  | "judgmentMismatch"
  | "pendingPublish"
  | "duplicate"
  | "numericMismatch"
  | "ambiguous"
  | "noCandidate"
  | "skipped"
  | "unknown";

/** The matched signal (only for matched, matched_harmonic, duplicate). */
export type OutcomePlanet = {
  candidateId: string;
  disposition: Disposition;
  /** planetTruth: true planet, false not a planet (FP), null not decided yet. */
  isPlanet: boolean | null;
  periodDays: number;
  depthPpm: number;
  durationHours: number;
  epochBtjd: number;
  harmonicMultiplier: number | null;
  /**
   * (Optional, added.) Published name of a confirmed planet from the
   * signal's external records ("WASP-62 b"), or null.
   */
  knownName?: string | null;
};

/**
 * First external record that a catalog calls a confirmed planet (CP/KP),
 * by its published name. A TOI number ("TOI-184.01") is not a planet name.
 * Same rule as format.ts `knownPlanetName`, kept here so the bridge (shared
 * with the develop screens' bundle) does not pull the cinema copy in.
 */
function knownName(
  external: readonly { externalId: string; disposition: string }[],
): string | null {
  for (const item of external) {
    const id = item.externalId.trim();
    const code = item.disposition.trim().toUpperCase();
    if (!id || !["CP", "KP", "CONFIRMED"].includes(code)) continue;
    if (/^TOI-\d+\.\d+$/i.test(id)) continue;
    return id;
  }
  return null;
}

export type AnalysisOutcome = {
  kind: AnalysisOutcomeKind;
  ticId: string;
  submissionId: string;
  historyId: string;
  submissionKind: SubmissionKind;
  matchStatus: MatchStatus;
  evaluation: Evaluation | null;
  /** What the member chose; null for special submissions or unknown. */
  userJudgment: Judgment | null;
  /**
   * First time this member sees this submission (celebration history, 2.2).
   * Gate once-only effects (transit, ignition) on this, not on `created`.
   */
  firstView: boolean;
  /** 201 vs replayed 200. Informational only. */
  created: boolean;
  planet: OutcomePlanet | null;
  /**
   * HOME-05: the planet joins the member's system (confirmed always,
   * unconfirmed only when judged LIKELY_PLANET, FP never).
   */
  revealsPlanet: boolean;
  submitted: {
    periodDays: number | null;
    phaseStart: number | null;
    phaseEnd: number | null;
    durationHours: number | null;
  };
  achievement: {
    result: AchievementResult;
    newlyRecognized: boolean;
    /** Stars opened by this submission. Positions come from the sky store. */
    unlockedTicIds: string[];
    starCount: number;
    grade: string | null;
  };
  /**
   * Sky version after this submission. The shell calls
   * `publishSkyChange(memberId, { skyVersion })` so the persistent sky store
   * and quests refresh; then it can `ignite` the unlocked stars.
   */
  skyVersion: string;
  progress: {
    stage: SubmissionReceipt["progress"]["stage"];
    remainingDiscoverableCount: number;
    matchedCandidateIds: string[];
  };
  nextActions: NextAction[];
};

export type SubmitFailure = {
  ticId: string;
  state: Exclude<SubmissionResult["state"], "accepted">;
  message: string | null;
};

export type AnalysisBridgeEvents = {
  /** An analysis screen for this star mounted (true) or left (false). */
  sessionChanged: { ticId: string; active: boolean };
  periodChanged: PeriodChange;
  /** null: no valid window (cleared, invalid, or a new period). */
  selectionChanged: { ticId: string; selection: WindowSelection | null };
  /** 1 period, 2 window, 3 judgment, 4 review (analysis-stage.ts). */
  stageChanged: { ticId: string; stage: 1 | 2 | 3 | 4 };
  submitted: { ticId: string; kind: SubmissionKind | null };
  outcome: AnalysisOutcome;
  submitFailed: SubmitFailure;
};
export type AnalysisEventType = keyof AnalysisBridgeEvents;
type Listener<K extends AnalysisEventType> = (
  payload: AnalysisBridgeEvents[K],
) => void;

const listeners = new Map<AnalysisEventType, Set<Listener<never>>>();
const latest = new Map<AnalysisEventType, unknown>();
const order = new Map<AnalysisEventType, number>();
let emitted = 0;

export function emitAnalysis<K extends AnalysisEventType>(
  type: K,
  payload: AnalysisBridgeEvents[K],
): void {
  latest.set(type, payload);
  order.set(type, ++emitted);
  for (const listener of [...(listeners.get(type) ?? [])])
    try {
      (listener as Listener<K>)(payload);
    } catch (error) {
      console.error(`analysis bridge listener for ${type} failed`, error);
    }
}

export function onAnalysis<K extends AnalysisEventType>(
  type: K,
  listener: Listener<K>,
): Unsubscribe {
  const group = listeners.get(type) ?? new Set();
  group.add(listener as Listener<never>);
  listeners.set(type, group);
  return () => {
    group.delete(listener as Listener<never>);
  };
}

/** Last payload of a type, for a listener that mounts late. */
export function lastAnalysis<K extends AnalysisEventType>(
  type: K,
): AnalysisBridgeEvents[K] | undefined {
  return latest.get(type) as AnalysisBridgeEvents[K] | undefined;
}

/**
 * When the last payload of a type was emitted, as a running count across
 * all types (0 = never). Lets a late listener keep only what came after a
 * given event, e.g. the hints of the current session, not an earlier one.
 * (Additive to the frozen bridge.)
 */
export function lastAnalysisOrder(type: AnalysisEventType): number {
  return order.get(type) ?? 0;
}

/** Tests and sign-out only. */
export function resetAnalysisBridge(): void {
  listeners.clear();
  latest.clear();
  order.clear();
}

/** Subscribe for the lifetime of a component; the latest listener is used. */
export function useAnalysisEvent<K extends AnalysisEventType>(
  type: K,
  listener: Listener<K>,
): void {
  const current = useRef(listener);
  current.current = listener;
  useEffect(
    () => onAnalysis(type, (payload) => current.current(payload)),
    [type],
  );
}

/**
 * Power at `periodDays` over the strongest power of the periodogram, 0..1.
 * Linear between grid cells on the server's log grid. Drives the ghost orbit.
 */
export function periodStrength(
  data: ReadyPeriodogram,
  periodDays: number,
): number {
  const grid = data.periodogram;
  const n = grid.power.length;
  if (!(periodDays > 0) || n === 0) return 0;
  const span = Math.log(grid.periodMaxDays) - Math.log(grid.periodMinDays);
  if (!(span > 0)) return 0;
  const position =
    ((Math.log(periodDays) - Math.log(grid.periodMinDays)) / span) * (n - 1);
  if (!(position >= 0 && position <= n - 1)) return 0;
  const index = Math.floor(position);
  const next = Math.min(index + 1, n - 1);
  const value =
    grid.power[index] * (1 - (position - index)) +
    grid.power[next] * (position - index);
  let max = 0;
  for (const power of grid.power) if (power > max) max = power;
  return max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
}

export function classifyOutcome(
  receipt: Pick<SubmissionReceipt, "matchStatus" | "explanation">,
): AnalysisOutcomeKind {
  const result = receipt.explanation.achievement.result;
  switch (receipt.matchStatus) {
    case "matched":
    case "matched_harmonic":
      return result === "recognized"
        ? "matched"
        : result === "judgment_mismatch"
          ? "judgmentMismatch"
          : result === "pending_publish"
            ? "pendingPublish"
            : result === "already_recognized"
              ? "duplicate"
              : "unknown";
    case "duplicate":
      return "duplicate";
    case "not_matched":
      return "numericMismatch";
    case "ambiguous_match":
      return "ambiguous";
    case "none_wrong":
      return "noCandidate";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

/** One payload shape for both variants. */
export function outcomeFromReceipt(
  receipt: SubmissionReceipt,
  context: { firstView: boolean; userJudgment: Judgment | null },
): AnalysisOutcome {
  const { explanation } = receipt;
  const signal = explanation.signal;
  const planet: OutcomePlanet | null = signal
    ? {
        candidateId: signal.candidateId,
        disposition: signal.disposition,
        isPlanet:
          signal.planetTruth === "planet"
            ? true
            : signal.planetTruth === "not_planet"
              ? false
              : null,
        periodDays: signal.bls.periodDays,
        depthPpm: signal.bls.depthPpm,
        durationHours: signal.bls.durationHours,
        epochBtjd: signal.bls.epochBtjd,
        harmonicMultiplier: explanation.correction?.multiplier ?? null,
        knownName: knownName(signal.external),
      }
    : null;
  const found = ["matched", "matched_harmonic", "duplicate"].includes(
    receipt.matchStatus,
  );
  return {
    kind: classifyOutcome(receipt),
    ticId: receipt.ticId,
    submissionId: receipt.submissionId,
    historyId: receipt.historyId,
    submissionKind: receipt.submissionKind,
    matchStatus: receipt.matchStatus,
    evaluation: explanation.evaluation,
    userJudgment: context.userJudgment,
    firstView: context.firstView,
    created: receipt.outcome === "created",
    planet,
    revealsPlanet: Boolean(
      found &&
      planet &&
      (planet.disposition === "CONFIRMED" ||
        (planet.disposition === "UNCONFIRMED" &&
          context.userJudgment === "LIKELY_PLANET")),
    ),
    submitted: {
      periodDays: explanation.submitted?.periodDays ?? null,
      phaseStart: explanation.submitted?.phaseStart ?? null,
      phaseEnd: explanation.submitted?.phaseEnd ?? null,
      durationHours: explanation.serverDerived?.durationHours ?? null,
    },
    achievement: {
      result: explanation.achievement.result,
      newlyRecognized: explanation.achievement.newlyRecognized,
      unlockedTicIds: [...explanation.achievement.unlockedTicIds],
      starCount: explanation.achievement.star.count,
      grade: explanation.achievement.star.grade,
    },
    skyVersion: receipt.skyVersion,
    progress: {
      stage: receipt.progress.stage,
      remainingDiscoverableCount: receipt.progress.remainingDiscoverableCount,
      matchedCandidateIds: [...receipt.progress.matchedCandidateIds],
    },
    nextActions: [...receipt.nextActions],
  };
}
