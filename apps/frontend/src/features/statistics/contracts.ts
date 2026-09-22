export const metricLabels = {
  discoveredStarCount: "발견한 별",
  startedStarCount: "탐사를 시작한 별",
  completedStarCount: "탐색 완료한 별",
  recognizedTotal: "인정된 성과",
  submissionCount: "제출 기록",
  activeDays: "탐사 활동일",
  retryRecognitionCount: "재도전 인정 신호",
  postCount: "작성한 글",
  commentCount: "작성한 댓글",
  unpublishedSignalCount: "미공개 신호",
  firstMatchAccuracy: "첫 매칭 일치율",
  submissionsPerStar: "별당 제출 수",
  harmonicRecognitionRate: "성과 중 고조파 인정 비율",
  evidencePerSubmission: "후보 제출당 선택 근거 수",
} as const;
export type Metric = {
  unit: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  status: "AVAILABLE" | "NO_SAMPLE" | "UNAVAILABLE" | "NOT_APPLICABLE";
  reason: string | null;
};
export type Week = {
  weekStart: string;
  weekEnd: string;
  partial: boolean;
  submissionCount: number;
};
export type Current = {
  asOf: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  metrics: Record<keyof typeof metricLabels, Metric>;
  achievementByType: Record<string, Metric>;
  gradeDistribution: Record<string, Metric>;
  judgmentDistribution: Record<string, Metric>;
  judgmentAccuracy: Record<string, Metric>;
  publicJudgmentDistribution: Record<string, Metric>;
  weeks: Week[];
  evidence: {
    key: string;
    useCount: number;
    accuracy: Metric;
    excludedCount: number;
  }[];
  nextGoal: string;
};
function invalid(): never {
  throw new Error("통계 응답 형식을 확인할 수 없습니다. 다시 불러와 주세요.");
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return invalid();
  return v as Record<string, unknown>;
}
function string(v: unknown): string {
  if (typeof v !== "string" || !v) return invalid();
  return v;
}
function count(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    return invalid();
  return v;
}
function instant(v: unknown): string {
  const s = string(v);
  if (!s.endsWith("Z") || !Number.isFinite(Date.parse(s))) return invalid();
  return s;
}
export function readMetric(v: unknown): Metric {
  const m = object(v);
  const status = string(m.status);
  if (
    !["AVAILABLE", "NO_SAMPLE", "UNAVAILABLE", "NOT_APPLICABLE"].includes(
      status,
    )
  )
    return invalid();
  const unit = string(m.unit);
  const numerator = m.numerator === null ? null : count(m.numerator),
    denominator = m.denominator === null ? null : count(m.denominator);
  const reason = m.reason === null ? null : string(m.reason);
  if (status === "AVAILABLE") {
    if (
      typeof m.value !== "number" ||
      !Number.isFinite(m.value) ||
      m.value < 0 ||
      denominator === 0 ||
      reason !== null
    )
      return invalid();
    if (unit === "PERCENT" && m.value > 100) return invalid();
  } else if (m.value !== null || !reason) return invalid();
  return {
    unit,
    value: m.value as number | null,
    numerator,
    denominator,
    status: status as Metric["status"],
    reason,
  };
}
function metrics(v: unknown, keys?: string[]) {
  const source = object(v);
  return Object.fromEntries(
    (keys ?? Object.keys(source)).map((k) => [k, readMetric(source[k])]),
  );
}
function date(v: unknown) {
  const s = string(v);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) !== s
  )
    return invalid();
  return s;
}
export function readPersonalStatistics(v: unknown): Current {
  const root = object(v),
    c = object(root.current);
  if (
    root.timeZone !== "Asia/Seoul" ||
    root.policyVersion !== "2026-09-22" ||
    c.status !== "READY"
  )
    return invalid();
  const all = metrics(c.metrics, Object.keys(metricLabels));
  for (const k of Object.keys(metricLabels)) if (!all[k]) return invalid();
  if (
    !Array.isArray(c.weeks) ||
    c.weeks.length !== 8 ||
    !Array.isArray(c.evidence)
  )
    return invalid();
  const weeks = c.weeks.map((v, i) => {
    const w = object(v);
    const start = date(w.weekStart),
      end = date(w.weekEnd);
    if (
      new Date(start).getUTCDay() !== 1 ||
      Date.parse(end) - Date.parse(start) !== 604800000 ||
      w.partial !== (i === 7)
    )
      return invalid();
    return {
      weekStart: start,
      weekEnd: end,
      partial: w.partial as boolean,
      submissionCount: count(w.submissionCount),
    };
  });
  weeks.forEach((w, i) => {
    if (i && weeks[i - 1].weekEnd !== w.weekStart) invalid();
  });
  const evidence = c.evidence.map((v) => {
    const e = object(v);
    return {
      key: string(e.key),
      useCount: count(e.useCount),
      accuracy: readMetric(e.accuracy),
      excludedCount: count(e.excludedCount),
    };
  });
  if (
    evidence.length !== 3 ||
    new Set(evidence.map((e) => e.key)).size !== 3 ||
    evidence.some((e) => !["oddeven", "secondary", "ushape"].includes(e.key))
  )
    return invalid();
  return {
    asOf: instant(c.asOf),
    generatedAt: instant(c.generatedAt),
    periodStart: instant(c.periodStart),
    periodEnd: instant(c.periodEnd),
    metrics: all as Current["metrics"],
    achievementByType: metrics(c.achievementByType, [
      "confirmed",
      "unconfirmed",
      "fp",
    ]),
    gradeDistribution: metrics(c.gradeDistribution, ["A", "S", "SS", "SSS"]),
    judgmentDistribution: metrics(c.judgmentDistribution, [
      "LIKELY_PLANET",
      "UNLIKELY_PLANET",
      "UNSURE",
    ]),
    judgmentAccuracy: metrics(c.judgmentAccuracy, [
      "LIKELY_PLANET",
      "UNLIKELY_PLANET",
    ]),
    publicJudgmentDistribution: metrics(c.publicJudgmentDistribution, [
      "LIKELY_PLANET",
      "UNLIKELY_PLANET",
      "UNSURE",
    ]),
    weeks,
    evidence,
    nextGoal: string(c.nextGoal),
  };
}
export const unitLabels: Record<string, string> = {
  STARS: "개",
  SIGNALS: "개",
  SUBMISSIONS: "건",
  DAYS: "일",
  POSTS: "개",
  COMMENTS: "개",
  PERCENT: "%",
  SUBMISSIONS_PER_STAR: "건/별",
  CHECKS_PER_SUBMISSION: "개/제출",
};
export function formatMetric(m: Metric) {
  if (m.status !== "AVAILABLE")
    return m.reason === "ZERO_DENOMINATOR"
      ? "표본 없음 (분모 0)"
      : m.reason === "MISSING_BASIS"
        ? "당시 기록 부족"
        : "자료 없음";
  return `${m.value!.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}${unitLabels[m.unit] ?? m.unit}`;
}
