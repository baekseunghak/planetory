import { readMetric, type Metric } from "./contracts";

export const comparisonUnits = {
  firstMatchAccuracy: "PERCENT",
  submissionsPerStar: "SUBMISSIONS_PER_STAR",
  harmonicRecognitionRate: "PERCENT",
  evidencePerSubmission: "CHECKS_PER_SUBMISSION",
} as const;
export type ComparisonKey = keyof typeof comparisonUnits;
export type Comparison = {
  status: "READY" | "STALE" | "UNAVAILABLE";
  asOf: string | null;
  sourceObservedAt: string | null;
  generatedAt: string | null;
  snapshotDate: string | null;
  cohortStart: string | null;
  cohortEnd: string | null;
  cohortMemberCount: number | null;
  inCohort: boolean | null;
  metrics: {
    key: ComparisonKey;
    myValue: Metric;
    median: number | null;
    sampleCount: number | null;
    status: string;
    reason: string | null;
  }[];
};
function invalid(): never {
  throw new Error("비교 통계 응답 형식을 확인할 수 없습니다.");
}
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return invalid();
  return v as Record<string, unknown>;
}
function count(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : invalid();
}
function instant(v: unknown): string {
  return typeof v === "string" &&
    v.endsWith("Z") &&
    Number.isFinite(Date.parse(v))
    ? v
    : invalid();
}
export function readComparison(v: unknown): Comparison {
  const c = obj(v);
  if (!["READY", "STALE", "UNAVAILABLE"].includes(c.status as string))
    return invalid();
  const unavailable = c.status === "UNAVAILABLE";
  if (c.unavailableReason !== (unavailable ? "AGGREGATE_NOT_READY" : null))
    return invalid();
  const times = Object.fromEntries(
    ["asOf", "sourceObservedAt", "generatedAt", "cohortStart", "cohortEnd"].map(
      (k) => [
        k,
        unavailable ? (c[k] === null ? null : invalid()) : instant(c[k]),
      ],
    ),
  );
  const cohortMemberCount = unavailable
    ? c.cohortMemberCount === null
      ? null
      : invalid()
    : count(c.cohortMemberCount);
  if (c.inCohort !== null && typeof c.inCohort !== "boolean") return invalid();
  let snapshotDate: string | null = null;
  if (unavailable) {
    if (c.snapshotDate !== null || c.inCohort !== null) return invalid();
  } else {
    if (
      typeof c.snapshotDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(c.snapshotDate)
    )
      return invalid();
    snapshotDate = c.snapshotDate;
    const midnight = Date.parse(snapshotDate + "T00:00:00+09:00");
    if (
      !Number.isFinite(midnight) ||
      new Date(midnight + 9 * 3600000).toISOString().slice(0, 10) !==
        snapshotDate ||
      Date.parse(times.asOf!) !== midnight + 86400000 ||
      Date.parse(times.asOf!) !== Date.parse(times.cohortEnd!) ||
      Date.parse(times.cohortEnd!) - Date.parse(times.cohortStart!) !==
        90 * 86400000
    )
      return invalid();
  }
  const source = obj(c.metrics);
  const metrics = (Object.keys(comparisonUnits) as ComparisonKey[]).map(
    (key) => {
      const m = obj(source[key]),
        myValue = readMetric(m.myValue);
      if (myValue.unit !== comparisonUnits[key]) return invalid();
      if (
        myValue.status === "AVAILABLE" &&
        (myValue.numerator === null ||
          myValue.denominator === null ||
          myValue.denominator <= 0)
      )
        return invalid();
      const sampleCount = unavailable
        ? m.sampleCount === null
          ? null
          : invalid()
        : count(m.sampleCount);
      if (sampleCount !== null && sampleCount > cohortMemberCount!)
        return invalid();
      if (unavailable) {
        if (
          m.status !== "UNAVAILABLE" ||
          m.reason !== "AGGREGATE_NOT_READY" ||
          m.median !== null ||
          myValue.status !== "UNAVAILABLE" ||
          myValue.reason !== "AGGREGATE_NOT_READY"
        )
          return invalid();
      } else if (sampleCount === 0) {
        if (
          m.status !== "NO_SAMPLE" ||
          m.reason !== "ZERO_DENOMINATOR" ||
          m.median !== null
        )
          return invalid();
      } else if (
        m.status !== "AVAILABLE" ||
        m.reason !== null ||
        typeof m.median !== "number" ||
        !Number.isFinite(m.median) ||
        m.median < 0 ||
        (myValue.unit === "PERCENT" && m.median > 100)
      )
        return invalid();
      return {
        key,
        myValue,
        median: m.median as number | null,
        sampleCount,
        status: m.status as string,
        reason: m.reason as string | null,
      };
    },
  );
  return {
    status: c.status as Comparison["status"],
    asOf: times.asOf,
    sourceObservedAt: times.sourceObservedAt,
    generatedAt: times.generatedAt,
    cohortStart: times.cohortStart,
    cohortEnd: times.cohortEnd,
    snapshotDate,
    cohortMemberCount,
    inCohort: c.inCohort as boolean | null,
    metrics,
  };
}
