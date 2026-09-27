// What a cinema member reads about an analysis and its results: numbers,
// names and words, in one place. Pure functions (tests/unit/cinema-analysis-
// format.test.ts); the legacy screens never call them.
//
// Rules (the cinema glossary):
// - period 2 decimals (3 where two values are compared) + 일, durations
//   1 decimal + 시간, phase 3 decimals, depth % with 2 decimals (no ppm),
//   periodogram power normalized to 0..1 and called 세기.
// - BTJD stays out of the primary view; where it must show, "기준 시각" with
//   2 decimals and no thousands separator.
// - A signal on a star is "행성 N" when it is one of the member's planets
//   there (ascending candidateId, as the star panel lists them), otherwise
//   "신호 N"; a confirmed planet adds its published name ("행성 1 · WASP-62 b").
// - Internal ids, versions and catalog codes never reach the primary view.
// - Polite register (~습니다).

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Fixed digits without "-0.00" and without thousands separators. */
export function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text;
}

const grouped = new Intl.NumberFormat("ko-KR");
/** Counts: "1,234". */
export function count(value: number): string {
  return grouped.format(value);
}

/** "11.73일" (3 decimals where values are compared side by side). */
export function periodDays(
  value: number | null | undefined,
  digits: 2 | 3 = 2,
): string | null {
  return finite(value) ? `${fixed(value, digits)}일` : null;
}

/** "3.0시간". */
export function hours(value: number | null | undefined): string | null {
  return finite(value) ? `${fixed(value, 1)}시간` : null;
}

/** "3.2일" for spans of time that are not orbital periods. */
export function days(value: number | null | undefined): string | null {
  return finite(value) ? `${fixed(value, 1)}일` : null;
}

/** Phase, 3 decimals: "0.690". */
export function phase(value: number | null | undefined): string | null {
  return finite(value) ? fixed(value, 3) : null;
}

/** "0.690–0.740". */
export function phaseRange(
  start: number | null | undefined,
  end: number | null | undefined,
): string | null {
  return finite(start) && finite(end)
    ? `${fixed(start, 3)}–${fixed(end, 3)}`
    : null;
}

/** Transit depth from ppm: "0.80%". */
export function depthPercent(ppm: number | null | undefined): string | null {
  return finite(ppm) ? `${fixed(ppm / 10000, 2)}%` : null;
}

/** A scientific time (BTJD) where one must show: "3264.52" (기준 시각). */
export function referenceTime(btjd: number | null | undefined): string | null {
  return finite(btjd) ? fixed(btjd, 2) : null;
}

/** Relative brightness, 4 decimals: "0.9991". */
export function flux(value: number | null | undefined): string | null {
  return finite(value) ? fixed(value, 4) : null;
}

/**
 * The brightness unit as a member reads it. Normalized or relative flux has
 * no unit worth naming ("밝기 0.9991"); anything else is kept as sent.
 */
export function fluxUnit(unit: string | null | undefined): string {
  const value = (unit ?? "").trim();
  return /^(normali[sz]ed|relative|rel|ratio|unitless|1)$/i.test(value)
    ? ""
    : value;
}

/** Axis tick for phase: up to 3 decimals, trailing zeros dropped ("0.5"). */
export function phaseTick(value: number): string {
  return String(Number(fixed(value, 3)));
}

/** Axis tick for a period in days: 3 significant digits ("0.5", "11.7", "20"). */
export function periodTick(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(Number(value.toPrecision(3)));
}

/** "섹터 5". */
export function sector(value: number): string {
  return `섹터 ${value}`;
}

/** "섹터 2·3". */
export function sectors(values: readonly number[]): string {
  return values.length ? `섹터 ${values.join("·")}` : "섹터 정보 없음";
}

// Same shape as the shell's dates (src/shared/cinema-wording.ts): no seconds.
const dateTime = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Seoul",
});
/** An activity time (UTC instant): "2026년 9월 27일 오후 3:12". */
export function when(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? dateTime.format(time) : null;
}

// ---------------------------------------------------------------- 세기

/**
 * Periodogram power as 세기, 0..1: the value over the strongest power of the
 * same periodogram. Negative power (below the baseline) reads as 0.
 */
export function strength(power: number, maxPower: number): number {
  if (!Number.isFinite(power) || !(maxPower > 0)) return 0;
  return Math.max(0, Math.min(1, power / maxPower));
}

/** Strongest positive power of a periodogram (0 when there is none). */
export function maxPower(powers: readonly number[]): number {
  let max = 0;
  for (const power of powers)
    if (Number.isFinite(power) && power > max) max = power;
  return max;
}

/** Every power as 세기 (for drawing). */
export function strengths(powers: readonly number[]): number[] {
  const max = maxPower(powers);
  return powers.map((power) => strength(power, max));
}

/** "0.83". */
export function strengthText(value: number): string {
  return fixed(Math.max(0, Math.min(1, value)), 2);
}

// ---------------------------------------------------------------- names

/** Exploration status of a star. */
export const EXPLORATION: Record<string, string> = {
  unexplored: "미탐사",
  not_started: "미탐사",
  in_progress: "탐사 중",
  completed: "탐사 완료",
};
export function explorationStatus(stage: string | null | undefined): string {
  return (stage && EXPLORATION[stage]) || "미탐사";
}

/**
 * A disposition as a member reads it. Our API words (CONFIRMED, UNCONFIRMED,
 * FP) and the catalog codes (CP, KP, PC, APC, FP, FA, EB). An unknown code is
 * shown as sent rather than guessed.
 */
export function dispositionLabel(code: string | null | undefined): string {
  const value = (code ?? "").trim().toUpperCase();
  switch (value) {
    case "CONFIRMED":
    case "CP":
    case "KP":
      return "확정 행성";
    case "UNCONFIRMED":
    case "PC":
    case "APC":
      return "행성 후보";
    case "FP":
    case "FA":
      return "행성 아님(오탐)";
    case "EB":
      return "식쌍성";
    default:
      return code?.trim() || "분류 정보 없음";
  }
}

type External = { source: string; externalId: string; disposition: string };
const CONFIRMED_CODES = new Set(["CP", "KP", "CONFIRMED"]);

/**
 * Published name of a confirmed planet from the signal's external records:
 * the first record whose catalog calls it confirmed (CP/KP), e.g.
 * "WASP-62 b". A TOI number ("TOI-184.01") is a candidate id, not a planet
 * name, so it is not used. null when there is none.
 */
export function knownPlanetName(
  external: readonly External[] | null | undefined,
): string | null {
  for (const item of external ?? []) {
    const id = item.externalId?.trim();
    if (!id || !CONFIRMED_CODES.has(item.disposition.trim().toUpperCase()))
      continue;
    if (/^TOI-\d+\.\d+$/i.test(id)) continue;
    return id;
  }
  return null;
}

/**
 * The number a signal gets on its star: its place among `ids` in ascending
 * candidateId order (the star panel's order). The signal is added when it is
 * not in the list yet (a planet the refreshed detail has not shown).
 */
export function orderOf(ids: readonly string[], candidateId: string): number {
  const sorted = [...new Set([...ids, candidateId])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return sorted.indexOf(candidateId) + 1;
}

/**
 * "행성 1 · WASP-62 b", "행성 2", "신호 1". `order` is 1-based; see
 * `orderOf` for planets and `signalOrder` for the other signals.
 */
export function signalName({
  planet,
  order,
  name,
}: {
  planet: boolean;
  order: number;
  name?: string | null;
}): string {
  const base = `${planet ? "행성" : "신호"} ${order}`;
  return planet && name ? `${base} · ${name}` : base;
}

/** "행성 1 · WASP-62 b (주기 4.41일)". The period is left out when unknown. */
export function withPeriod(
  label: string,
  period: number | null | undefined,
): string {
  const text = periodDays(period);
  return text ? `${label} (주기 ${text})` : label;
}

/**
 * Labels for every signal of a star: planets numbered among the member's
 * planets there (`planetIds`), the other signals among themselves, both in
 * ascending candidateId order.
 */
export function signalLabels(
  signalIds: readonly string[],
  planetIds: readonly string[],
  names: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const planets = new Set(planetIds);
  const others = [...new Set(signalIds.filter((id) => !planets.has(id)))].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const labels = new Map<string, string>();
  for (const id of signalIds)
    labels.set(
      id,
      planets.has(id)
        ? signalName({
            planet: true,
            order: orderOf(planetIds, id),
            name: names.get(id),
          })
        : signalName({ planet: false, order: others.indexOf(id) + 1 }),
    );
  return labels;
}

// ---------------------------------------------------------------- result words

export const JUDGMENT: Record<string, string> = {
  LIKELY_PLANET: "행성 같음",
  UNLIKELY_PLANET: "아닌 것 같음",
  UNSURE: "모르겠음",
};

/** What the member's judgment turned out to be. */
export const EVALUATION: Record<string, string> = {
  AGREES: "판단이 맞았습니다.",
  DISAGREES: "판단이 달랐습니다.",
  UNSURE: "모르겠음으로 제출해 맞고 틀림을 매기지 않았습니다.",
  UNSCORED: "아직 확정되지 않은 신호라 판단을 채점하지 않습니다.",
};

export const ACHIEVEMENT: Record<string, string> = {
  recognized: "성과로 인정되었습니다.",
  judgment_mismatch: "판단이 달라 성과로 인정되지 않았습니다.",
  pending_publish: "이 분석을 공개하면 성과 판정을 받습니다.",
  already_recognized: "이미 인정된 신호라 다시 인정되지 않습니다.",
};

export const COMPLETION: Record<string, string> = {
  all_found: "찾을 수 있는 신호를 모두 찾았습니다.",
  undiscoverable_only: "남은 신호는 이 자료로는 찾을 수 없어 마쳤습니다.",
  skipped: "건너뛰어 마쳤습니다.",
};

export const PUBLICATION: Record<string, string> = {
  UNPUBLISHED: "공개할 수 있습니다.",
  PUBLISHED: "공개되어 있습니다.",
  HIDDEN: "운영자가 숨긴 분석입니다.",
  NOT_ELIGIBLE: "공개하지 않는 결과입니다.",
};

/** Short publication state for lists. */
export const PUBLICATION_SHORT: Record<string, string> = {
  UNPUBLISHED: "공개 전",
  PUBLISHED: "공개 중",
  HIDDEN: "운영자가 숨김",
  NOT_ELIGIBLE: "공개하지 않음",
};

export const AI_BAND: Record<string, string> = {
  approved: "행성일 가능성 높음",
  hold: "판단 보류",
  rejected: "행성일 가능성 낮음",
};

/** The AI line, only when the model actually ran ("행성일 가능성 높음 · 87점"). */
export function aiLine(ai: {
  status: string;
  score?: number;
  verdict?: string;
}): string | null {
  if (ai.status !== "completed" || !finite(ai.score)) return null;
  const band = (ai.verdict && AI_BAND[ai.verdict]) || ai.verdict || "";
  return `${band ? `${band} · ` : ""}${Math.round(ai.score * 100)}점`;
}

/** One line for what the match was, after a submission. */
export function matchSentence(
  matchStatus: string,
  multiplier?: number | null,
): string {
  switch (matchStatus) {
    case "matched":
      return "고른 주기가 신호와 맞았습니다.";
    case "matched_harmonic":
      return finite(multiplier)
        ? `고른 주기의 ${String(Number(fixed(multiplier, 2)))}배가 신호와 맞았습니다.`
        : "고른 주기의 배수가 신호와 맞았습니다.";
    case "duplicate":
      return "이미 찾은 신호입니다.";
    case "not_matched":
      return "고른 주기와 구간에 맞는 신호가 없었습니다.";
    case "ambiguous_match":
      return "어느 신호인지 가리지 못했습니다.";
    case "none_wrong":
      return "더 이상 없음으로 접수했습니다.";
    case "skipped":
      return "이 별을 건너뛰었습니다.";
    default:
      return "결과를 받았습니다.";
  }
}

/** Short match state for lists ("찾지 못함"). */
export const MATCH_SHORT: Record<string, string> = {
  matched: "신호를 찾음",
  matched_harmonic: "배수 주기로 찾음",
  duplicate: "이미 찾은 신호",
  not_matched: "신호를 찾지 못함",
  ambiguous_match: "신호를 가리지 못함",
  none_wrong: "더 이상 없음으로 제출",
  skipped: "건너뜀",
};

/** "원본 곡선", "곡선 단계 2": the analysis screen's own words (stepName). */
export function curveStepName(step: number | null | undefined): string {
  if (!finite(step) || step <= 0) return "원본 곡선";
  return `곡선 단계 ${step}`;
}

// ---------------------------------------------------------------- titles

/** Josa 을/를 for a Korean word, a number or a Latin name ("WASP-62 b"). */
export function objectParticle(word: string): "을" | "를" {
  const last = word.trim().at(-1) ?? "";
  // Sino-Korean numbers: 일 이 삼 사 오 육 칠 팔 구 영.
  if (/\d/.test(last)) return "2459".includes(last) ? "를" : "을";
  // Latin letters read by name: 엘, 엠, 엔, 알 end in a consonant.
  if (/[a-z]/i.test(last))
    return "lmnr".includes(last.toLowerCase()) ? "을" : "를";
  const code = last.charCodeAt(0) - 0xac00;
  if (code >= 0 && code <= 11171) return code % 28 ? "을" : "를";
  return "을";
}

/**
 * What a result says first, from the receipt's own axes. Known planets are
 * not new discoveries: a confirmed planet is "found yourself", with its
 * published name when there is one; "발견" is kept for candidates.
 */
export function resultTitle({
  matchStatus,
  achievement,
  disposition,
  knownName,
}: {
  matchStatus: string;
  achievement: string | null | undefined;
  disposition: string | null | undefined;
  knownName?: string | null;
}): string {
  switch (matchStatus) {
    case "not_matched":
      return "이번 구간에서는 신호를 찾지 못했습니다";
    case "ambiguous_match":
      return "어느 신호인지 가리지 못했습니다";
    case "none_wrong":
      return "더 이상 없음으로 접수했습니다";
    case "skipped":
      return "이 별을 건너뛰었습니다";
    case "duplicate":
      return "이미 찾은 신호입니다";
  }
  if (achievement === "judgment_mismatch")
    return "구간은 맞았고, 판단은 달랐습니다";
  if (achievement === "already_recognized") return "이미 찾은 신호입니다";
  return foundTitle(disposition, knownName);
}

/** The found line for a matched signal (card and result share it). */
export function foundTitle(
  disposition: string | null | undefined,
  knownName?: string | null,
): string {
  if (disposition === "FP") return "행성이 아닌 신호를 가려냈습니다";
  if (disposition === "CONFIRMED")
    return knownName
      ? `알려진 행성 ${knownName}${objectParticle(knownName)} 직접 찾아냈습니다`
      : "확정된 행성을 직접 찾아냈습니다";
  return "새 행성 후보를 발견했습니다";
}

/**
 * One line of help after a window that matched nothing. It only says what the
 * receipt says (no signal matched this period and window) and where to look;
 * it does not guess whether the period or the window was off.
 */
export const NOT_MATCHED_HINT =
  "고른 주기와 구간에 맞는 신호가 없었습니다. 접힌 곡선에서 밝기가 가장 많이 줄어드는 곳을 구간이 덮는지 확인해 보세요.";

/**
 * The server's width hint (S15P21C206-282): it comes only when the period and
 * the position matched and the window width alone was off, so these lines may
 * say so. Without it the plain hint above stays.
 */
const MISS_HINT: Record<string, string> = {
  WINDOW_TOO_WIDE:
    "주기와 위치는 맞았지만 구간이 신호보다 너무 넓습니다. 주기는 그대로 두고 구간만 좁혀 보세요.",
  WINDOW_TOO_NARROW:
    "주기와 위치는 맞았지만 구간이 신호보다 너무 좁습니다. 주기는 그대로 두고 구간만 넓혀 보세요.",
};

/** The help line after a miss, from the receipt's `missHint`. */
export const notMatchedHint = (missHint: string | null | undefined): string =>
  (missHint && MISS_HINT[missHint]) || NOT_MATCHED_HINT;

/** "이번에는 새로 열린 별이 없습니다" (a recognized result that opened none). */
export const NO_NEW_STAR = "이번에는 새로 열린 별이 없습니다.";

type Statistics =
  | { kind: "graded"; matchedMemberCount: number; agreementPercent: number }
  | {
      kind: "public_analyses";
      participantCount: number;
      percentages: {
        likelyPlanet: number;
        unlikelyPlanet: number;
        unsure: number;
      } | null;
    };

/** Other members' judgments, one line; whole percents. */
export function statisticsLine(value: Statistics): string {
  if (value.kind === "graded")
    return `이 신호를 처음 찾은 ${count(value.matchedMemberCount)}명 중 ${Math.round(value.agreementPercent)}%가 같은 판단이었습니다.`;
  if (value.percentages === null) return "아직 공개된 분석이 없습니다.";
  const { likelyPlanet, unlikelyPlanet, unsure } = value.percentages;
  return `공개된 분석 ${count(value.participantCount)}건 · 행성 같음 ${Math.round(likelyPlanet)}% · 아닌 것 같음 ${Math.round(unlikelyPlanet)}% · 모르겠음 ${Math.round(unsure)}%`;
}
