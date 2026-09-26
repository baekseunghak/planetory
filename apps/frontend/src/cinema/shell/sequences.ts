// Analysis bridge -> scene. The shell's only source of truth for a discovery
// is what the analysis variant reports through ../analysis/bridge; nothing
// here decides whether something was found.
//
//   periodChanged / selectionChanged -> scene.setAnalysisHint (ghost orbit)
//   outcome matched | judgmentMismatch | pendingPublish (first view)
//        -> panel away, scene.playTransit with a live light curve,
//           scene.revealPlanet (HOME-05 revealsPlanet only), discovery card
//   outcome numericMismatch (first view) -> scene.playMismatch, no transit
//   every accepted outcome -> publishSkyChange so the one sky store refreshes
//   unlocked stars -> queued, ignited when the galaxy is on screen again
import {
  lastAnalysis,
  lastAnalysisOrder,
  onAnalysis,
  type AnalysisBridgeEvents,
  type AnalysisOutcome,
  type PeriodChange,
} from "../analysis/bridge";
import {
  SCENE_TIMING,
  scenePlanet,
  type AnalysisHint,
  type SceneController,
  type Unsubscribe,
} from "../scene/contract";
import { publishSkyChange } from "../../features/sky-data/events";

export type ChipTone = "good" | "warn" | "neutral" | "new";
export type Chip = { label: string; tone: ChipTone };
export type DiscoveryCard = {
  kind: AnalysisOutcome["kind"];
  eyebrow: string;
  title: string;
  /** Period, duration and depth of the matched signal, as reported. */
  facts: string | null;
  note: string | null;
  chips: Chip[];
  /** The planet joined the member's system (HOME-05). */
  revealed: boolean;
  unlockedTicIds: string[];
};
export type SequencePhase = "idle" | "transit" | "card";
export type SequenceState = {
  phase: SequencePhase;
  ticId: string | null;
  outcome: AnalysisOutcome | null;
  card: DiscoveryCard | null;
};
export type FluxSample = { t: number; flux: number };
/**
 * Top-bar counts held back while a discovery plays: the planet count moves
 * when the planet appears, the star count when the new star ignites.
 */
export type TallyHold = { planets: boolean; stars: boolean };
export const NO_TALLY_HOLD: TallyHold = { planets: false, stars: false };

export const IDLE_SEQUENCE: SequenceState = {
  phase: "idle",
  ticId: null,
  outcome: null,
  card: null,
};

/** Outcomes that play the transit (when a planet is revealed) and a card. */
const CINEMATIC: ReadonlySet<AnalysisOutcome["kind"]> = new Set([
  "matched",
  "judgmentMismatch",
  "pendingPublish",
]);

// ---------------------------------------------------------------- copy

/** 을/를 after a Korean word or a number read in Sino-Korean. */
export function objectParticle(word: string): "을" | "를" {
  const last = word.trim().at(-1) ?? "";
  if (/\d/.test(last)) return "2459".includes(last) ? "를" : "을";
  const code = last.charCodeAt(0) - 0xac00;
  if (code >= 0 && code <= 11171) return code % 28 ? "을" : "를";
  return "을";
}

/**
 * "행성 N" in the order the star detail lists the member's planets
 * (ascending candidateId, as the detail contract requires).
 */
export function planetLabel(
  items: readonly { candidateId: string }[] | null | undefined,
  candidateId: string,
): string {
  const ids = [
    ...new Set([...(items ?? []).map((item) => item.candidateId), candidateId]),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `행성 ${ids.indexOf(candidateId) + 1}`;
}

const trim = (value: number, digits: number) =>
  Number.isFinite(value) ? value.toFixed(digits) : "–";

export function signalFacts(planet: AnalysisOutcome["planet"]): string | null {
  if (!planet) return null;
  return [
    `주기 ${trim(planet.periodDays, 3)}일`,
    `지속 ${trim(planet.durationHours, 1)}시간`,
    `깊이 ${trim(planet.depthPpm / 10000, 2)}%`,
  ].join(" · ");
}

/**
 * Chips from the receipt's own axes. None is inferred from another. The
 * judgment and achievement lead; the star's progress comes last.
 */
export function outcomeChips(outcome: AnalysisOutcome): Chip[] {
  const chips: Chip[] = [];
  switch (outcome.evaluation) {
    case "AGREES":
      chips.push({ label: "판단 일치", tone: "good" });
      break;
    case "DISAGREES":
      chips.push({ label: "판단 불일치", tone: "warn" });
      break;
    case "UNSURE":
      chips.push({ label: "모르겠음으로 제출", tone: "neutral" });
      break;
    case "UNSCORED":
      chips.push({ label: "채점하지 않음", tone: "neutral" });
      break;
  }
  switch (outcome.achievement.result) {
    case "recognized":
      chips.push({ label: "성과 인정", tone: "good" });
      break;
    case "judgment_mismatch":
      chips.push({ label: "성과 미인정", tone: "warn" });
      break;
    case "pending_publish":
      chips.push({ label: "공개하면 판정", tone: "neutral" });
      break;
    case "already_recognized":
      chips.push({ label: "이미 인정됨", tone: "neutral" });
      break;
  }
  const opened = outcome.achievement.unlockedTicIds.length;
  if (opened) chips.push({ label: `새 별 ${opened}개`, tone: "new" });
  if (outcome.matchStatus === "matched_harmonic")
    chips.push({ label: "배수 주기로 일치", tone: "neutral" });
  if (outcome.progress.stage === "completed")
    chips.push({ label: "탐색 완료", tone: "good" });
  else if (outcome.progress.stage === "in_progress")
    chips.push({ label: "탐색 중", tone: "neutral" });
  return chips;
}

export function discoveryCard(
  outcome: AnalysisOutcome,
  label: string | null,
): DiscoveryCard {
  const revealed = outcome.revealsPlanet && outcome.planet !== null;
  const found =
    revealed && label ? `${label}${objectParticle(label)} 찾았습니다` : null;
  // The "새 별 N개" chip says what opened; the note is kept for what the
  // chips cannot say.
  let eyebrow = "발견",
    title = found ?? "신호를 찾았습니다",
    note: string | null = null;
  if (outcome.kind === "judgmentMismatch") {
    eyebrow = "탐색 결과";
    title = "구간은 맞았고, 판단은 달랐습니다";
    note = "판단이 달라 성과로 인정되지 않았습니다.";
  } else if (outcome.kind === "pendingPublish") {
    note = "이 분석을 공개하면 성과 판정을 받습니다.";
  } else if (!revealed && outcome.planet?.isPlanet === false) {
    eyebrow = "판별";
    title = "행성이 아닌 신호를 가려냈습니다";
  }
  return {
    kind: outcome.kind,
    eyebrow,
    title,
    facts: signalFacts(outcome.planet),
    note,
    chips: outcomeChips(outcome),
    revealed,
    unlockedTicIds: [...outcome.achievement.unlockedTicIds],
  };
}

// ---------------------------------------------------------------- director

export type SequenceHost = {
  scene(): SceneController;
  memberId: string;
  /** TIC of the analysis stage on screen, or null elsewhere. */
  analysisTic(): string | null;
  /** "행성 N" for the matched planet in the focused system. */
  planetLabel(outcome: AnalysisOutcome): string | null;
};

type Hint = AnalysisHint & { ticId: string };
const samePeriod = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9);
const clamp01 = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
/** Longest a sequence may keep the panel away if a scene promise hangs. */
const SEQUENCE_LIMIT_MS =
  SCENE_TIMING.transitFlightMs +
  SCENE_TIMING.transitMs +
  SCENE_TIMING.revealMs +
  6000;

async function settle(
  run: () => Promise<void>,
  limitMs: number,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(run),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, limitMs);
      }),
    ]);
  } catch (error) {
    // The contract says scene promises never reject. If one does, the card
    // still shows: a scene bug must not hide the member's result.
    console.error(`scene ${label} failed`, error);
  } finally {
    clearTimeout(timer);
  }
}

export class SequenceDirector {
  private state: SequenceState = IDLE_SEQUENCE;
  private listeners = new Set<() => void>();
  private fluxListeners = new Set<() => void>();
  private samples: FluxSample[] = [];
  private hint: Hint | null = null;
  private run: AbortController | null = null;
  private ignitions: string[] = [];
  private hold: TallyHold = NO_TALLY_HOLD;
  private holdListeners = new Set<() => void>();

  constructor(private readonly host: SequenceHost) {}

  getState = (): SequenceState => this.state;
  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Counts the top bar should keep as they were (see TallyHold). */
  getHold = (): TallyHold => this.hold;
  subscribeHold = (listener: () => void): Unsubscribe => {
    this.holdListeners.add(listener);
    return () => {
      this.holdListeners.delete(listener);
    };
  };
  getFlux = (): readonly FluxSample[] => this.samples;
  subscribeFlux = (listener: () => void): Unsubscribe => {
    this.fluxListeners.add(listener);
    return () => {
      this.fluxListeners.delete(listener);
    };
  };

  /** Listen to the bridge. Returns the stop function. */
  start(): Unsubscribe {
    const offs = [
      onAnalysis("sessionChanged", (event) => this.onSession(event)),
      onAnalysis("periodChanged", (event) => this.onPeriod(event)),
      onAnalysis("selectionChanged", (event) => this.onSelection(event)),
      onAnalysis("outcome", (event) => this.onOutcome(event)),
    ];
    this.catchUp();
    return () => {
      offs.forEach((off) => off());
      this.cancel();
    };
  }

  /**
   * An analysis screen came on stage. Its variant may have emitted before the
   * shell's effect ran (child effects run first), so replay the latest hints
   * of an active session for this star. Outcomes are never replayed.
   */
  enterAnalysis(): void {
    this.hint = null;
    this.catchUp();
    this.apply();
  }

  /** The analysis left the stage: no ghost orbit, no running sequence. */
  leaveAnalysis(): void {
    this.cancel();
    this.hint = null;
    this.apply();
  }

  /** A new scene controller registered: give it the current hint. */
  reapply(): void {
    this.apply();
  }

  /** Card closed ("결과 자세히 보기"): the panel comes back. */
  dismiss(): void {
    this.run?.abort();
    this.run = null;
    this.set(IDLE_SEQUENCE);
  }

  /** The unlocked stars have ignited (or there were none): count them now. */
  releaseStars(): void {
    this.setHold({ ...this.hold, stars: false });
  }

  /** Unlocked stars waiting for the galaxy to be on screen. */
  takeIgnitions(): string[] {
    const list = this.ignitions;
    this.ignitions = [];
    return list;
  }
  hasIgnitions(): boolean {
    return this.ignitions.length > 0;
  }

  private cancel(): void {
    this.run?.abort();
    this.run = null;
    this.setHold({ ...this.hold, planets: false });
    if (this.state !== IDLE_SEQUENCE) this.set(IDLE_SEQUENCE);
  }

  private setHold(next: TallyHold): void {
    if (next.planets === this.hold.planets && next.stars === this.hold.stars)
      return;
    this.hold = !next.planets && !next.stars ? NO_TALLY_HOLD : { ...next };
    this.holdListeners.forEach((listener) => listener());
  }

  private accepts(ticId: string): boolean {
    return this.host.analysisTic() === ticId;
  }

  /**
   * Only what the current session reported: the bridge keeps the last
   * payload of every type forever, and a period or window from an earlier
   * visit to this star must not come back as a ghost.
   */
  private catchUp(): void {
    const tic = this.host.analysisTic();
    const session = lastAnalysis("sessionChanged");
    if (!tic || !session || session.ticId !== tic || !session.active) return;
    const since = lastAnalysisOrder("sessionChanged");
    const period = lastAnalysis("periodChanged");
    if (period?.ticId === tic && lastAnalysisOrder("periodChanged") > since)
      this.takePeriod(period);
    const selection = lastAnalysis("selectionChanged");
    if (
      selection?.ticId === tic &&
      lastAnalysisOrder("selectionChanged") > since
    )
      this.takeSelection(selection);
  }

  private onSession(event: AnalysisBridgeEvents["sessionChanged"]): void {
    if (!this.accepts(event.ticId)) return;
    // A fresh or closing session starts without a ghost orbit.
    this.hint = null;
    this.apply();
  }

  private onPeriod(event: PeriodChange): void {
    if (!this.accepts(event.ticId)) return;
    this.takePeriod(event);
    this.apply();
  }

  private onSelection(event: AnalysisBridgeEvents["selectionChanged"]): void {
    if (!this.accepts(event.ticId)) return;
    this.takeSelection(event);
    this.apply();
  }

  private takePeriod(event: PeriodChange): void {
    const previous = this.hint;
    this.hint = {
      ticId: event.ticId,
      periodDays: event.periodDays,
      strength: clamp01(event.strength),
      selection:
        previous?.ticId === event.ticId &&
        samePeriod(previous.periodDays, event.periodDays)
          ? previous.selection
          : null,
    };
  }

  private takeSelection(event: AnalysisBridgeEvents["selectionChanged"]): void {
    const { selection, ticId } = event;
    const previous = this.hint?.ticId === ticId ? this.hint : null;
    if (!selection) {
      if (previous) this.hint = { ...previous, selection: null };
      return;
    }
    this.hint = {
      ticId,
      periodDays: selection.periodDays,
      strength:
        previous && samePeriod(previous.periodDays, selection.periodDays)
          ? previous.strength
          : (previous?.strength ?? 0),
      selection: {
        startPhase: selection.startPhase,
        endPhase: selection.endPhase,
        durationHours: selection.durationHours,
      },
    };
  }

  private apply(): void {
    const hint = this.hint;
    try {
      this.host.scene().setAnalysisHint(
        hint
          ? {
              periodDays: hint.periodDays,
              strength: hint.strength,
              selection: hint.selection,
            }
          : null,
      );
    } catch (error) {
      console.error("scene setAnalysisHint failed", error);
    }
  }

  private onOutcome(outcome: AnalysisOutcome): void {
    const plays =
      outcome.firstView &&
      this.accepts(outcome.ticId) &&
      CINEMATIC.has(outcome.kind);
    // The refreshed sky lands in a moment; the top bar keeps the old counts
    // until the planet appears and the new star ignites.
    if (plays)
      this.setHold({
        planets: outcome.revealsPlanet && outcome.planet !== null,
        stars:
          this.hold.stars ||
          (outcome.kind !== "judgmentMismatch" &&
            outcome.achievement.unlockedTicIds.length > 0),
      });
    // Keep the one sky store current. A replayed receipt that was already
    // seen may carry an older version; it is left alone.
    if (outcome.skyVersion && (outcome.created || outcome.firstView))
      publishSkyChange(this.host.memberId, { skyVersion: outcome.skyVersion });
    if (!outcome.firstView || !this.accepts(outcome.ticId)) return;
    if (outcome.kind === "numericMismatch") {
      const scene = this.host.scene();
      void settle(() => scene.playMismatch(), 4000, "playMismatch");
      return;
    }
    if (CINEMATIC.has(outcome.kind)) void this.play(outcome);
  }

  private async play(outcome: AnalysisOutcome): Promise<void> {
    this.run?.abort();
    const run = new AbortController();
    this.run = run;
    const scene = this.host.scene();
    const planet = outcome.planet;
    const reveal = outcome.revealsPlanet && planet !== null;
    if (
      outcome.kind !== "judgmentMismatch" &&
      outcome.achievement.unlockedTicIds.length
    )
      this.ignitions = [
        ...new Set([...this.ignitions, ...outcome.achievement.unlockedTicIds]),
      ];
    if (reveal && planet) {
      this.samples = [];
      this.emitFlux();
      this.set({
        phase: "transit",
        ticId: outcome.ticId,
        outcome,
        card: null,
      });
      await settle(
        () =>
          scene.playTransit({
            periodDays: planet.periodDays,
            depth: Math.max(0, planet.depthPpm) / 1e6,
            durationHours: planet.durationHours,
            onFlux: (t, flux) => {
              if (!run.signal.aborted) this.pushFlux(t, flux);
            },
            signal: run.signal,
          }),
        SEQUENCE_LIMIT_MS,
        "playTransit",
      );
      if (run.signal.aborted) return;
      await settle(
        () =>
          scene.revealPlanet({
            ...scenePlanet({
              candidateId: planet.candidateId,
              kind:
                planet.disposition === "CONFIRMED"
                  ? "confirmed"
                  : "unconfirmed",
              periodDays: planet.periodDays,
              depthPpm: planet.depthPpm,
            }),
            ticId: outcome.ticId,
          }),
        SCENE_TIMING.revealMs + 4000,
        "revealPlanet",
      );
      if (run.signal.aborted) return;
      // The real planet took the ghost's place. A new period brings it back.
      this.hint = null;
      this.apply();
    }
    // The planet is on its orbit: now it counts.
    this.setHold({ ...this.hold, planets: false });
    this.set({
      phase: "card",
      ticId: outcome.ticId,
      outcome,
      card: discoveryCard(
        outcome,
        reveal ? this.host.planetLabel(outcome) : null,
      ),
    });
  }

  private pushFlux(t: number, flux: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(flux)) return;
    this.samples = [...this.samples, { t: clamp01(t), flux }];
    this.emitFlux();
  }

  private emitFlux(): void {
    this.fluxListeners.forEach((listener) => listener());
  }

  private set(next: SequenceState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}
