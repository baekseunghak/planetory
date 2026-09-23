import {
  readHistoryGraph,
  type GraphMode,
  type HistoryGraphDto,
} from "../history/HistoryGraph.tsx";
import { foldTimes } from "./fold-data.ts";

// 탐사 API 8.3절 `GET /api/v1/histories/{historyId}/graph`를 읽는다.
// **뼈대는 213(하서진)의 `readHistoryGraph`가 이미 본다.** 고치지 않고
// 감싸서, 그쪽이 보지 않는 값만 여기서 더 읽는다. 왜 복제하지 않는지는
// docs/analysis-history.md.

export const historyGraphPath = (historyId: string, mode: GraphMode) =>
  `/v1/histories/${encodeURIComponent(historyId)}/graph?mode=${mode}`;

/**
 * 접기에 쓰는 값. **특수 제출은 주기·절대 구간·현재 위상이 모두 null이고
 * 객체 자체는 유지된다**(8.3절).
 *
 * 접기는 `userPeriodDays`(원본 주기)로 한다. `correctedPeriodDays`는 참고
 * 표시다.
 */
export type GraphSelection = {
  userPeriodDays: number | null;
  correctedPeriodDays: number | null;
  harmonicMultiplier: number | null;
  epochBtjd: number | null;
  durationHours: number | null;
  /** 현재 T 기준 환산. **`SUBMITTED`에는 없다.** */
  currentPhaseStart: number | null;
  currentPhaseEnd: number | null;
};

export type HistoryGraphView = {
  mode: GraphMode;
  dto: HistoryGraphDto;
  selection: GraphSelection;
  reproduction: {
    submittedBundleId: string;
    currentBundleId: string;
    isPreviousSubmission: boolean;
    /** 저장된 제거 조합을 현재 판에서 되살릴 수 있는가. */
    residualReproducible: boolean;
    /** `RETIRED_CANDIDATE` · `RESIDUAL_NOT_AVAILABLE` 등. 모르는 값도 그대로 둔다. */
    fallbackReason: string | null;
    /** **현재 판** 메타데이터다. `SUBMITTED` 정렬에 쓰지 않는다. */
    currentFoldReferenceTimeBtjd: number | null;
  };
  /**
   * 배열은 있는데 저장 버전이 없다. 그리되 **선택 영역과의 정렬을 보장하지
   * 않는다.** v0·v1 어느 쪽으로도 간주하거나 배열을 옮기지 않는다.
   */
  alignmentUnknown: boolean;
  snapshotVersion: string | null;
};

function invalid(field: string): never {
  throw new Error(`그래프 응답을 읽을 수 없습니다: ${field}`);
}
const nullableNumber = (value: unknown, field: string) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
};
const nullableText = (value: unknown, field: string) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value) invalid(field);
  return value;
};
const flag = (value: unknown, field: string) => {
  if (typeof value !== "boolean") invalid(field);
  return value;
};

/**
 * 8.3절 그래프. **두 모드는 서로의 빈칸이다.**
 *
 * 213의 파서가 `curve`·`snapshot`이 모드와 맞는지, 배열이 150칸인지를
 * 이미 본다. 여기서는 `selection`·`snapshotVersion`·`reproduction`의
 * 나머지를 읽고, 명세가 「SUBMITTED에는 없다」고 적은 것이 정말 없는지
 * 대조한다.
 */
export function readHistoryGraphView(
  value: unknown,
  historyId: string,
  ticId: string,
  mode: GraphMode,
): HistoryGraphView {
  return extendHistoryGraph(
    readHistoryGraph(value, historyId, ticId, mode),
    mode,
  );
}

/**
 * 이미 읽은 DTO에서 나머지를 꺼낸다. 공용 렌더러는 213의 파서를 이미 지난
 * 값을 받으므로 **다시 태우지 않는다.**
 */
export function extendHistoryGraph(
  dto: HistoryGraphDto,
  mode: GraphMode,
): HistoryGraphView {
  const raw = dto.selection as Record<string, unknown>;
  const repro = dto.reproduction as Record<string, unknown>;

  const harmonicMultiplier = nullableNumber(
    raw.harmonicMultiplier,
    "selection.harmonicMultiplier",
  );
  const correctedPeriodDays = nullableNumber(
    raw.correctedPeriodDays,
    "selection.correctedPeriodDays",
  );
  // 배수가 있으면 정정 주기도 있어야 한다. 배수만 오면 무엇으로 고쳤는지 모른다.
  if (harmonicMultiplier !== null && correctedPeriodDays === null)
    invalid("selection.correctedPeriodDays");

  const currentPhaseStart = nullableNumber(
    raw.currentPhaseStart,
    "selection.currentPhaseStart",
  );
  const currentPhaseEnd = nullableNumber(
    raw.currentPhaseEnd,
    "selection.currentPhaseEnd",
  );
  // 현재 위상은 현재 T로 환산한 값이라 당시 모드에는 올 수 없다(8.3절).
  if (
    mode === "SUBMITTED" &&
    (currentPhaseStart !== null || currentPhaseEnd !== null)
  )
    invalid("selection.currentPhase/mode");
  // 창은 두 끝이 함께 있어야 창이다.
  if ((currentPhaseStart === null) !== (currentPhaseEnd === null))
    invalid("selection.currentPhase");

  const snapshotVersion = nullableText(dto.snapshotVersion, "snapshotVersion");

  return {
    mode,
    dto,
    selection: {
      userPeriodDays: nullableNumber(
        raw.userPeriodDays,
        "selection.userPeriodDays",
      ),
      correctedPeriodDays,
      harmonicMultiplier,
      epochBtjd: nullableNumber(raw.epochBtjd, "selection.epochBtjd"),
      durationHours: nullableNumber(
        raw.durationHours,
        "selection.durationHours",
      ),
      currentPhaseStart,
      currentPhaseEnd,
    },
    reproduction: {
      submittedBundleId: dto.reproduction.submittedBundleId,
      currentBundleId: dto.reproduction.currentBundleId,
      isPreviousSubmission: flag(
        repro.isPreviousSubmission,
        "reproduction.isPreviousSubmission",
      ),
      residualReproducible: dto.reproduction.residualReproducible,
      // 모르는 사유도 그대로 둔다. 하나 때문에 그래프를 못 그리는 쪽이 비싸다.
      fallbackReason: dto.reproduction.fallbackReason,
      currentFoldReferenceTimeBtjd: nullableNumber(
        repro.currentFoldReferenceTimeBtjd,
        "reproduction.currentFoldReferenceTimeBtjd",
      ),
    },
    alignmentUnknown: dto.snapshot !== null && snapshotVersion === null,
    snapshotVersion,
  };
}

/**
 * 당시 배열의 칸 i가 가리키는 위상. **칸의 중심이다**(8.3절).
 *
 * 시작을 쓰면 반 칸씩 밀린 자리에 선택 영역을 그리게 된다. 이 값은 제출
 * 당시 T·원본 P 기준이며 **현재 T로 옮기지 않는다.**
 */
export const snapshotPhase = (index: number, bins: number) =>
  -0.5 + (index + 0.5) / bins;

/**
 * 당시 선택 창을 `[-0.5, 0.5)` 위에 올린다. **경계를 넘는 창은 나누어
 * 돌려준다** — 한 구간으로 이으면 반대쪽 끝까지 칠해진다.
 *
 * 값이 없으면 빈 목록이다(특수 제출).
 */
export function wrapPhaseWindow(
  start: number | null,
  end: number | null,
): { from: number; to: number }[] {
  if (start === null || end === null) return [];
  // 이미 범위 안이면 건드리지 않는다. 나머지 연산을 태우면 값이 미세하게
  // 달라져 저장된 좌표와 어긋난다.
  const shift = (value: number) => {
    if (value >= -0.5 && value < 0.5) return value;
    const wrapped = ((value + 0.5) % 1) - 0.5;
    return wrapped < -0.5 ? wrapped + 1 : wrapped;
  };
  const from = shift(start);
  const to = shift(end);
  if (from <= to) return [{ from, to }];
  return [
    { from, to: 0.5 },
    { from: -0.5, to },
  ];
}

/** 화면에 찍을 한 점. 당시 배열에는 오차가 함께 온다. */
export type GraphPoint = { phase: number; flux: number; error: number | null };

/**
 * 두 모드를 **한 좌표계로 모은다.** 당시 배열은 `[-0.5, 0.5)`이고 현재 곡선을
 * 접으면 `[0, 1)`이 나오므로(`foldTimes`), 현재 쪽을 옮겨 맞춘다. 두 범위를
 * 그대로 두면 같은 화면에서 같은 위상이 다른 자리에 찍힌다.
 */
export type GraphSeries = {
  kind: "points" | "bins";
  points: GraphPoint[];
  /** 왜 그릴 것이 없는지. 빈 그래프를 「값이 0」으로 보이게 두지 않는다. */
  emptyReason: "no-period" | "no-curve" | "no-reference" | "no-snapshot" | null;
};

const toCentered = (phase: number) => (phase >= 0.5 ? phase - 1 : phase);

export function historySeries(view: HistoryGraphView): GraphSeries {
  const { dto, selection } = view;
  if (view.mode === "SUBMITTED") {
    const snapshot = dto.snapshot;
    if (!snapshot)
      return { kind: "bins", points: [], emptyReason: "no-snapshot" };
    const points: GraphPoint[] = [];
    for (let i = 0; i < snapshot.bins; i++) {
      const flux = snapshot.foldedFlux[i];
      // 값이 없는 칸은 건너뛴다. 0으로 바꾸면 밝기가 0인 관측이 된다.
      if (flux === null) continue;
      points.push({
        phase: snapshotPhase(i, snapshot.bins),
        flux,
        error: snapshot.foldedError[i],
      });
    }
    return { kind: "bins", points, emptyReason: null };
  }

  const period = selection.userPeriodDays;
  // 특수 제출에는 고른 주기가 없다. 접을 기준이 없으므로 그리지 않는다.
  if (period === null)
    return { kind: "points", points: [], emptyReason: "no-period" };
  const segments = dto.curve?.segments;
  if (!segments || !segments.length)
    return { kind: "points", points: [], emptyReason: "no-curve" };
  // 곡선이 왔는데 접기 기준만 없는 경우와 곡선 자체가 없는 경우는 다르다.
  // 한 문구로 뭉치면 「아직 계산되지 않았다」가 거짓이 된다.
  const reference = view.reproduction.currentFoldReferenceTimeBtjd;
  if (reference === null)
    return { kind: "points", points: [], emptyReason: "no-reference" };

  const times: number[] = [];
  const fluxes: number[] = [];
  for (const raw of segments) {
    const segment = raw as {
      startBtjd: number;
      binMinutes: number;
      nPoints: number;
      flux: (number | null)[];
    };
    for (let i = 0; i < segment.nPoints; i++) {
      const flux = segment.flux[i];
      if (flux === null) continue;
      times.push(segment.startBtjd + (i + 0.5) * (segment.binMinutes / 1440));
      fluxes.push(flux);
    }
  }
  if (!times.length)
    return { kind: "points", points: [], emptyReason: "no-curve" };
  const phases = foldTimes(times, reference, period);
  return {
    kind: "points",
    points: fluxes.map((flux, i) => ({
      phase: toCentered(phases[i]),
      flux,
      error: null,
    })),
    emptyReason: null,
  };
}
