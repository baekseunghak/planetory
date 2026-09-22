import { readHistoryDetail } from "../analysis/history-data";
import { judgments } from "../analysis/analysis-judgment";

export const MAX_PUBLICATION_BATCH_SIZE = 20;

function invalid(): never {
  throw new Error("공개 검토 응답을 확인할 수 없습니다.");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalid();
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}
export type Candidate = {
  historyId: string;
  candidateId: string;
  ticId: string;
  submittedAt: string;
  userJudgment: string;
};
export function candidatesPath(ticId: string, cursor: string | null = null) {
  const query = new URLSearchParams({ ticId, size: "20" });
  if (cursor) query.set("cursor", cursor);
  return `/v1/public-analyses/batch-candidates?${query}`;
}
export function readCandidates(value: unknown, ticId: string) {
  const row = object(value);
  if (!Array.isArray(row.items)) return invalid();
  const seen = new Set<string>();
  const histories = new Set<string>();
  const items: Candidate[] = row.items.map((value) => {
    const item = object(value),
      candidateId = text(item.candidateId);
    const historyId = text(item.historyId);
    if (
      item.ticId !== ticId ||
      seen.has(candidateId) ||
      histories.has(historyId)
    )
      return invalid();
    seen.add(candidateId);
    histories.add(historyId);
    text(item.submissionId);
    const submittedAt = text(item.submittedAt);
    if (Number.isNaN(Date.parse(submittedAt))) return invalid();
    return {
      historyId,
      candidateId,
      ticId,
      submittedAt,
      userJudgment: text(item.userJudgment),
    };
  });
  const hasMore = flag(row.hasMore);
  const nextCursor = row.nextCursor === null ? null : text(row.nextCursor);
  if (hasMore !== (nextCursor !== null)) return invalid();
  return { items, hasMore, nextCursor };
}

export function readPreview(
  value: unknown,
  historyId: string,
  ticId?: string,
  candidateId?: string,
) {
  const detail = readHistoryDetail(value, { historyId });
  if (
    (ticId && detail.ticId !== ticId) ||
    (candidateId && detail.explanation.signal?.candidateId !== candidateId)
  )
    return invalid();
  const submission = object(object(value).submission);
  if (submission.historyId !== historyId) return invalid();
  const original = object(submission.original);
  const judgment = text(original.userJudgment);
  if (!judgments.some((option) => option.value === judgment)) return invalid();
  if (
    !Array.isArray(original.evidenceChecks) ||
    original.evidenceChecks.some((v) => typeof v !== "string")
  )
    return invalid();
  if (original.memo !== null && typeof original.memo !== "string")
    return invalid();
  return {
    detail,
    judgment,
    evidence: original.evidenceChecks as string[],
    memo: original.memo as string | null,
  };
}
export type Preview = ReturnType<typeof readPreview>;
export type Receipt = {
  historyId: string;
  analysisId: string;
  threadId: string;
  isPublic: boolean;
  achievementGranted: boolean;
  newlyGranted: boolean;
  skyVersion: string;
  unlockedTicIds: string[];
};
export function readReceipt(value: unknown, historyId: string): Receipt {
  const row = object(value);
  if (row.historyId !== historyId) return invalid();
  flag(row.created);
  const achievementGranted = flag(row.achievementGranted),
    newlyGranted = flag(row.newlyGranted);
  if (newlyGranted && !achievementGranted) return invalid();
  const achievement = object(row.achievement);
  if (
    flag(achievement.newlyRecognized) !== newlyGranted ||
    !Array.isArray(achievement.unlockedStars)
  )
    return invalid();
  return {
    historyId,
    analysisId: text(row.analysisId),
    threadId: text(row.threadId),
    isPublic: flag(row.isPublic),
    achievementGranted,
    newlyGranted,
    skyVersion: text(row.skyVersion),
    unlockedTicIds: achievement.unlockedStars.map((value) =>
      text(object(value).ticId),
    ),
  };
}
export type BatchResult =
  | { status: "PUBLISHED" | "NOT_PUBLISHED"; receipt: Receipt }
  | {
      status: "FAILED";
      historyId: string;
      message: string;
      retryable: boolean;
    };
export function readBatch(value: unknown, historyIds: string[]): BatchResult[] {
  const row = object(value);
  if (
    !Array.isArray(row.results) ||
    row.results.length !== historyIds.length ||
    new Set(historyIds).size !== historyIds.length
  )
    return invalid();
  return row.results.map((value, index) => {
    const item = object(value),
      historyId = historyIds[index];
    if (item.historyId !== historyId) return invalid();
    if (item.status === "FAILED") {
      const error = object(item.error);
      text(error.code);
      return {
        status: "FAILED",
        historyId,
        message: text(error.message),
        retryable: flag(item.retryable),
      };
    }
    if (item.status !== "PUBLISHED" && item.status !== "NOT_PUBLISHED")
      return invalid();
    const receipt = readReceipt(item, historyId);
    if (receipt.isPublic !== (item.status === "PUBLISHED")) return invalid();
    return { status: item.status, receipt };
  });
}
export function readVisibility(value: unknown, analysisId: string) {
  const row = object(value);
  if (row.analysisId !== analysisId) return invalid();
  const isPublic = flag(row.isPublic),
    isPublicByAuthor = flag(row.isPublicByAuthor),
    isModerationHidden = flag(row.isModerationHidden);
  if (
    isPublic !== flag(row.isEffectivelyPublic) ||
    (isPublic && (!isPublicByAuthor || isModerationHidden))
  )
    return invalid();
  return { isPublic, isPublicByAuthor, isModerationHidden };
}
