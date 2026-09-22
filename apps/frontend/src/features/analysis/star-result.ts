import {
  readStatistics,
  storedPublicationStates,
  type SubmissionSignal,
} from "./submission-result.ts";

// Exploration API 8.4 / StarResultViews. IDs are opaque strings, never numbers.
function invalid(field: string): never {
  throw new Error(`별 결과 응답을 읽을 수 없습니다: ${field}`);
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) invalid("객체");
  return v as Record<string, unknown>;
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) invalid("문자열");
  return v;
}
function number(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) invalid("수치");
  return v;
}
function count(v: unknown): number {
  const n = number(v);
  if (!Number.isSafeInteger(n) || n < 0) invalid("개수");
  return n;
}
function flag(v: unknown): boolean {
  if (typeof v !== "boolean") invalid("상태");
  return v;
}
function list<T>(v: unknown, read: (v: unknown) => T): T[] {
  if (!Array.isArray(v)) invalid("목록");
  return v.map(read);
}
function nullable<T>(v: unknown, read: (v: unknown) => T): T | null {
  return v == null ? null : read(v);
}
function choice<T extends string>(v: unknown, choices: readonly T[]): T {
  if (!choices.includes(v as T)) invalid("열거형");
  return v as T;
}
function instant(v: unknown): string {
  const s = text(v);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s)))
    invalid("시각");
  return s;
}
function ids(v: unknown): string[] {
  const values = list(v, text);
  if (new Set(values).size !== values.length) invalid("중복 ID");
  return values;
}
function readAi(v: unknown): SubmissionSignal["ai"] {
  const a = object(v);
  const status = choice(a.status, [
    "completed",
    "not_evaluated",
    "input_insufficient",
    "error",
  ] as const);
  const modelVersion = nullable(a.modelVersion, text);
  if (status !== "completed") return { status, modelVersion };
  const score = number(a.score);
  if (score < 0 || score > 1) invalid("AI 점수");
  return { status, modelVersion, score, verdict: text(a.verdict) };
}
function readSignal(v: unknown) {
  const s = object(v),
    achievement = object(s.achievement),
    publication = object(s.publication);
  return {
    candidateId: text(s.candidateId),
    disposition: choice(s.disposition, [
      "CONFIRMED",
      "UNCONFIRMED",
      "FP",
    ] as const),
    status: choice(s.status, ["active", "retired"] as const),
    latestSubmissionId: text(s.latestSubmissionId),
    latestHistoryId: nullable(s.latestHistoryId, text),
    submissionIds: ids(s.submissionIds),
    threadId: nullable(s.threadId, text),
    matchResult: choice(s.matchResult, [
      "matched",
      "matched_harmonic",
      "duplicate",
    ] as const),
    userJudgment: nullable(s.userJudgment, (x) =>
      choice(x, ["LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE"] as const),
    ),
    judgmentEvaluation: nullable(s.judgmentEvaluation, (x) =>
      choice(x, [
        "AGREES",
        "DISAGREES",
        "UNSURE",
        "UNSCORED",
        "NOT_APPLICABLE",
      ] as const),
    ),
    achievement: {
      result: choice(achievement.result, [
        "recognized",
        "already_recognized",
        "pending_publish",
        "judgment_mismatch",
        "none",
      ] as const),
      recognizedAt: nullable(achievement.recognizedAt, instant),
    },
    publication: {
      state: choice(publication.state, storedPublicationStates),
      publicAnalysisId: nullable(publication.publicAnalysisId, text),
    },
    ai: readAi(s.ai),
    statistics: nullable(s.judgmentStatistics, readStatistics),
    relabel: nullable(s.relabel, (v) => {
      const r = object(v);
      return {
        relabeledAt: instant(r.relabeledAt),
        newDisposition: text(r.newDisposition),
      };
    }),
    curveStepAtMatch: nullable(s.curveStepAtMatch, count),
  };
}
export function readStarResult(value: unknown, ticId: string) {
  const d = object(value),
    star = object(d.star),
    progress = object(d.progress),
    achievement = object(d.achievement),
    byType = object(achievement.byType),
    links = object(d.links);
  if (text(d.ticId) !== ticId) invalid("TIC");
  const signals = list(d.signals, readSignal);
  const matchedCandidateIds = ids(progress.matchedCandidateIds);
  const seen = new Set(signals.map((s) => s.candidateId));
  if (
    seen.size !== signals.length ||
    seen.size !== matchedCandidateIds.length ||
    matchedCandidateIds.some((id) => !seen.has(id))
  )
    invalid("매칭 신호 목록");
  const submissions = new Set<string>();
  for (const s of signals) {
    if (!s.submissionIds.includes(s.latestSubmissionId)) invalid("대표 제출");
    for (const id of s.submissionIds) {
      if (submissions.has(id)) invalid("중복 제출");
      submissions.add(id);
    }
  }
  const unmatchedSubmissions = list(d.unmatchedSubmissions, (v) => {
    const u = object(v),
      submissionId = text(u.submissionId);
    if (submissions.has(submissionId)) invalid("중복 제출");
    submissions.add(submissionId);
    return {
      submissionId,
      historyId: nullable(u.historyId, text),
      matchResult: choice(u.matchResult, [
        "not_matched",
        "ambiguous_match",
        "none_wrong",
        "skipped",
      ] as const),
      submittedAt: instant(u.submittedAt),
    };
  });
  const curveSteps = list(d.curveSteps, (v) => {
    const c = object(v),
      r = object(c.residual);
    const curveStep = count(c.curveStep),
      removedCandidateIds = ids(c.removedCandidateIds);
    if (curveStep !== removedCandidateIds.length) invalid("곡선 단계");
    return {
      curveStep,
      removedCandidateIds,
      residual: {
        status: nullable(r.status, (x) =>
          choice(x, [
            "QUEUED",
            "RUNNING",
            "COMPLETED",
            "FAILED",
            "CANCELLED",
          ] as const),
        ),
        jobId: nullable(r.jobId, text),
        computedAt: nullable(r.computedAt, instant),
      },
    };
  });
  const threadIds = ids(links.threadIds);
  const signalThreads = new Set(
    signals.flatMap((s) => (s.threadId ? [s.threadId] : [])),
  );
  if (
    threadIds.length !== signalThreads.size ||
    threadIds.some((id) => !signalThreads.has(id))
  )
    invalid("스레드 목록");
  return {
    ticId,
    star: {
      sectorCount: count(star.sectorCount),
      tmag: nullable(star.tmag, number),
    },
    bundle: nullable(d.bundle, (v) => {
      const b = object(v);
      return {
        bundleId: text(b.bundleId),
        publishedAt: instant(b.publishedAt),
      };
    }),
    progress: {
      stage: choice(progress.stage, [
        "unexplored",
        "in_progress",
        "completed",
      ] as const),
      completionReason: nullable(progress.completionReason, (x) =>
        choice(x, ["all_found", "undiscoverable_only", "skipped"] as const),
      ),
      reopenPending: flag(progress.reopenPending),
      currentCurveStep: nullable(progress.currentCurveStep, count),
      matchedCandidateIds,
      remainingDiscoverableCount: count(progress.remainingDiscoverableCount),
    },
    achievement: {
      count: count(achievement.count),
      grade: nullable(achievement.grade, (x) =>
        choice(x, ["A", "S", "SS", "SSS"] as const),
      ),
      byType: {
        confirmed: count(byType.confirmed),
        unconfirmed: count(byType.unconfirmed),
        fp: count(byType.fp),
      },
    },
    signals,
    unmatchedSubmissions,
    curveSteps,
    discoveredStars: list(d.discoveredStars, (v) => {
      const s = object(v);
      return {
        ticId: text(s.ticId),
        unlockedAt: instant(s.unlockedAt),
        triggerAchievementId: text(s.triggerAchievementId),
      };
    }),
    unpublishedSignalCount: count(d.unpublishedSignalCount),
    links: { boardOpen: flag(links.boardOpen), threadIds },
    // Unknown future actions are not rendered, but do not discard the whole result.
    nextActions: list(d.nextActions, text),
    submissionCount: submissions.size,
  };
}
export type StarResult = ReturnType<typeof readStarResult>;
export const starResultPath = (ticId: string) =>
  `/v1/stars/${encodeURIComponent(ticId)}/result`;
