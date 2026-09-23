import { readMetric, type Metric } from "./contracts";

export const globalMetricLabels = {
  discoveredStars: "발견한 별 (회원×별)",
  uniqueDiscoveredStars: "발견한 고유 별",
  startedStars: "탐사를 시작한 별 (회원×별)",
  currentCompletedStars: "현재 완료한 별 (회원×별)",
  uniqueCurrentCompletedStars: "현재 완료한 고유 별",
  recognizedSignals: "인정된 성과 (회원×신호)",
  confirmedAchievements: "확정 행성 성과",
  unconfirmedAchievements: "미확정 성과",
  fpAchievements: "거짓 양성 성과",
  uniqueRecognizedSignals: "성과가 있는 고유 신호",
  uniqueConfirmedSignals: "현재 확정 행성 신호",
  uniqueFpSignals: "현재 거짓 양성 신호",
  uniqueUnconfirmedSignals: "현재 미확정 신호",
  firstMatchAccuracy: "첫 매칭 일치율",
  publicLikelyPlanet: "행성 같음",
  publicUnlikelyPlanet: "아닌 것 같음",
  publicUnsure: "모르겠음",
  publicLikelyPlanetRate: "행성 같음 비율",
  publicUnlikelyPlanetRate: "아닌 것 같음 비율",
  publicUnsureRate: "모르겠음 비율",
  publicParticipations: "전체 공개 참여 (회원×신호)",
  aiAttemptUnknown: "최신 AI 시도 불명인 참여",
} as const;
export type GlobalMetricKey = keyof typeof globalMetricLabels;
type GlobalData = {
  metrics: Record<GlobalMetricKey, Metric>;
  weeklySubmissions: {
    weekStart: string;
    submissions: number;
    partial: boolean;
  }[];
  mostPostsStars: { ticId: string; postCount: number }[];
  sectorCompletion: { sector: number; metric: Metric }[];
  challenges: {
    roundId: string;
    roundNo: number;
    participantCount: number;
    participationCount: number;
    likelyPlanet: number;
    unlikelyPlanet: number;
    unsure: number;
  }[];
};
export type GlobalStatistics = { policyVersion: string } & (
  | { status: "UNAVAILABLE"; asOf: null; generatedAt: null; data: null }
  | {
      status: "READY" | "STALE";
      asOf: string;
      generatedAt: string;
      data: GlobalData;
    }
);
function invalid(): never {
  throw new Error("전체 통계 응답 형식을 확인할 수 없습니다.");
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return invalid();
  return v as Record<string, unknown>;
}
function string(v: unknown): string {
  return typeof v === "string" && v.trim() ? v : invalid();
}
function count(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : invalid();
}
function array(v: unknown): unknown[] {
  return Array.isArray(v) ? v : invalid();
}
function instant(v: unknown): string {
  const s = string(v);
  return s.endsWith("Z") && Number.isFinite(Date.parse(s)) ? s : invalid();
}
function identifier(v: unknown): string {
  const s = string(v);
  return /^[1-9]\d*$/.test(s) ? s : invalid();
}
function metric(v: unknown, aiUnknown = false): Metric {
  const source = object(v);
  // The global contract explicitly permits AVAILABLE + AI_ATTEMPT_UNKNOWN.
  // Keep the personal parser strict, and retain the global reason after validation.
  if (
    aiUnknown &&
    (source.reason !== "AI_ATTEMPT_UNKNOWN" || source.status !== "AVAILABLE")
  )
    return invalid();
  const m = readMetric(aiUnknown ? { ...source, reason: null } : source);
  if (m.numerator === null) return invalid();
  if (m.unit === "PERCENT") {
    if (m.denominator === null || m.numerator > m.denominator) return invalid();
    if (
      m.denominator === 0
        ? m.status !== "NO_SAMPLE" || m.reason !== "ZERO_DENOMINATOR"
        : m.status !== "AVAILABLE"
    )
      return invalid();
  } else if (
    m.status !== "AVAILABLE" ||
    m.denominator !== null ||
    m.value !== m.numerator
  )
    return invalid();
  return aiUnknown ? { ...m, reason: "AI_ATTEMPT_UNKNOWN" } : m;
}
export function readGlobalStatistics(v: unknown): GlobalStatistics {
  const root = object(v),
    g = object(root.global),
    policyVersion = string(root.policyVersion);
  if (root.timeZone !== "Asia/Seoul") return invalid();
  if (g.status === "UNAVAILABLE") {
    if (
      g.reason !== "AGGREGATE_NOT_READY" ||
      g.asOf !== null ||
      g.generatedAt !== null ||
      g.data !== null
    )
      return invalid();
    return {
      policyVersion,
      status: "UNAVAILABLE",
      asOf: null,
      generatedAt: null,
      data: null,
    };
  }
  if (g.status !== "READY" && g.status !== "STALE") return invalid();
  if (g.reason !== (g.status === "STALE" ? "REFRESH_DELAYED" : null))
    return invalid();
  const data = object(g.data),
    source = object(data.metrics);
  const metrics = Object.fromEntries(
    Object.keys(globalMetricLabels).map((key) => {
      const m = metric(source[key], key === "aiAttemptUnknown");
      const unit =
        key === "firstMatchAccuracy" || key.endsWith("Rate")
          ? "PERCENT"
          : key.endsWith("Stars")
            ? "STAR"
            : key.startsWith("unique")
              ? "SIGNAL"
              : key.endsWith("Achievements") || key === "recognizedSignals"
                ? "ACHIEVEMENT"
                : "PARTICIPATION";
      if (m.unit !== unit) return invalid();
      return [key, m];
    }),
  ) as GlobalData["metrics"];
  const bands = object(data.aiJudgmentBands);
  if (
    bands.status !== "NO_SAMPLE" ||
    bands.reason !== "AI_ATTEMPT_UNKNOWN" ||
    array(bands.items).length ||
    metrics.aiAttemptUnknown.value !== metrics.publicParticipations.value
  )
    return invalid();
  const weeklySubmissions = array(data.weeklySubmissions).map((v, i) => {
    const w = object(v),
      start = string(w.weekStart),
      time = Date.parse(start + "T00:00:00Z");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== start ||
      new Date(time).getUTCDay() !== 1 ||
      w.partial !== (i === 7)
    )
      return invalid();
    return {
      weekStart: start,
      submissions: count(w.submissions),
      partial: w.partial as boolean,
    };
  });
  if (
    weeklySubmissions.length !== 8 ||
    weeklySubmissions.some(
      (w, i) =>
        i > 0 &&
        Date.parse(w.weekStart) -
          Date.parse(weeklySubmissions[i - 1].weekStart) !==
          604800000,
    )
  )
    return invalid();
  const mostPostsStars = array(data.mostPostsStars).map((v) => {
    const s = object(v);
    return { ticId: identifier(s.ticId), postCount: count(s.postCount) };
  });
  if (
    mostPostsStars.length > 5 ||
    new Set(mostPostsStars.map((s) => s.ticId)).size !== mostPostsStars.length
  )
    return invalid();
  const sectorCompletion = array(data.sectorCompletion).map((v) => {
    const s = object(v);
    if (s.unit !== "PERCENT") return invalid();
    return {
      sector: count(s.sector),
      metric: metric({
        ...s,
        reason: s.status === "NO_SAMPLE" ? "ZERO_DENOMINATOR" : null,
      }),
    };
  });
  const challenges = array(data.challenges).map((v) => {
    const c = object(v);
    const row = {
      roundId: identifier(c.roundId),
      roundNo: count(c.roundNo),
      participantCount: count(c.participantCount),
      participationCount: count(c.participationCount),
      likelyPlanet: count(c.likelyPlanet),
      unlikelyPlanet: count(c.unlikelyPlanet),
      unsure: count(c.unsure),
    };
    if (
      row.participantCount > row.participationCount ||
      row.likelyPlanet + row.unlikelyPlanet + row.unsure !==
        row.participationCount
    )
      return invalid();
    return row;
  });
  if (
    new Set(sectorCompletion.map((s) => s.sector)).size !==
      sectorCompletion.length ||
    new Set(challenges.map((c) => c.roundId)).size !== challenges.length
  )
    return invalid();
  return {
    policyVersion,
    status: g.status,
    asOf: instant(g.asOf),
    generatedAt: instant(g.generatedAt),
    data: {
      metrics,
      weeklySubmissions,
      mostPostsStars,
      sectorCompletion,
      challenges,
    },
  };
}
