import { historyFixtureResponse } from "./history-fixtures.ts";

// Synthetic, serve/test-only records. Each browser test owns a fresh instance.
export const PUBLICATION_TIC = "259377024";
export const PUBLICATION_IDS = ["h-1951", "h-1952", "h-1953"];
export function publicationDetail(
  historyId: string,
  analysisId: string | null = null,
  state = "UNPUBLISHED",
) {
  const source = historyFixtureResponse(
    "/v1/histories/h-501",
    new URLSearchParams(),
  )!.body as Record<string, unknown>;
  const submission = source.submission as Record<string, unknown>;
  const candidateId =
    historyId === "h-1953" ? "c-1951" : `c-${historyId.slice(2)}`;
  return {
    ...source,
    historyId,
    submission: {
      ...submission,
      historyId,
      submissionId: `sub-${historyId.slice(2)}`,
      original: {
        ...(submission.original as object),
        userJudgment: "LIKELY_PLANET",
        evidenceChecks: ["ushape"],
        memo: "통과 모양을 확인했습니다.",
      },
      match: { ...(submission.match as object), candidateId },
      signal: { ...(submission.signal as object), candidateId },
      publication: { state, publicAnalysisId: analysisId },
    },
  };
}
export function publicationReceipt(
  historyId: string,
  isPublic = true,
  newlyGranted = true,
) {
  return {
    historyId,
    analysisId: `pa-${historyId.slice(2)}`,
    threadId: `st-${historyId.slice(2)}`,
    isPublic,
    created: newlyGranted,
    achievementGranted: true,
    newlyGranted,
    skyVersion: "fixture-195:2",
    achievement: {
      result: newlyGranted ? "recognized" : "already_recognized",
      newlyRecognized: newlyGranted,
      unlockedStars: [],
      star: {
        count: 3,
        grade: "S",
        byType: { confirmed: 0, unconfirmed: 3, fp: 0 },
      },
      unlockShortfall: 0,
    },
    judgmentSummary: {},
  };
}
export function createPublicationFixture() {
  const published = new Map<string, boolean>();
  return (
    method: string,
    url: URL,
    body?: unknown,
  ): { status: number; body: unknown } | null => {
    const path = url.pathname.replace(/^\/api/, "");
    const detail = /^\/v1\/histories\/(h-195[123])(\/graph)?$/.exec(path);
    if (method === "GET" && detail) {
      if (detail[2]) {
        const graph = historyFixtureResponse(
          "/v1/histories/h-501/graph",
          url.searchParams,
        )!.body as object;
        return { status: 200, body: { ...graph, historyId: detail[1] } };
      }
      return {
        status: 200,
        body: publicationDetail(
          detail[1],
          published.has(detail[1]) ? `pa-${detail[1].slice(2)}` : null,
          published.get(detail[1]) ? "PUBLISHED" : "UNPUBLISHED",
        ),
      };
    }
    if (method === "GET" && path === "/v1/public-analyses/batch-candidates")
      return {
        status: 200,
        body: {
          items: PUBLICATION_IDS.slice(0, 2)
            .filter((id) => !published.has(id))
            .map((historyId) => ({
              historyId,
              submissionId: `sub-${historyId.slice(2)}`,
              candidateId: `c-${historyId.slice(2)}`,
              ticId: PUBLICATION_TIC,
              submittedAt: "2026-09-22T01:00:00Z",
              userJudgment: "LIKELY_PLANET",
            })),
          nextCursor: null,
          hasMore: false,
        },
      };
    if (
      method === "GET" &&
      path === "/v1/me/histories" &&
      url.searchParams.get("candidateId")?.startsWith("c-195")
    ) {
      return {
        status: 200,
        body: {
          items: PUBLICATION_IDS.filter(
            (id) =>
              (id === "h-1953" ? "c-1951" : `c-${id.slice(2)}`) ===
              url.searchParams.get("candidateId"),
          ).map((historyId) => ({
            historyId,
            submissionId: `sub-${historyId.slice(2)}`,
            ticId: PUBLICATION_TIC,
            candidateId: url.searchParams.get("candidateId"),
            submittedAt: "2026-09-22T01:00:00Z",
            submissionKind: "candidate",
            matchResult: "matched",
            userJudgment: "LIKELY_PLANET",
            achievementResult: "pending_publish",
            bundleId: "b-3",
            isPreviousBundle: false,
            curveStep: 1,
            publication: {
              publicAnalysisId: published.has(historyId)
                ? `pa-${historyId.slice(2)}`
                : null,
              isPublic: published.get(historyId) ?? false,
              isModerationHidden: false,
            },
            achievementGranted: published.has(historyId),
            snapshotAvailable: true,
            detailAvailable: true,
            answerViewed: false,
            retryOfSubmissionId: null,
          })),
          nextCursor: null,
          hasNext: false,
        },
      };
    }
    const row = body as
      | {
          historyId?: string;
          items?: { historyId: string }[];
          isPublic?: boolean;
        }
      | undefined;
    const publish = (id: string) => {
      const existed = published.has(id);
      if (!existed) published.set(id, true);
      return publicationReceipt(id, published.get(id)!, !existed);
    };
    if (
      method === "POST" &&
      path === "/v1/public-analyses" &&
      PUBLICATION_IDS.includes(row?.historyId ?? "")
    )
      return { status: 200, body: publish(row!.historyId!) };
    if (
      method === "POST" &&
      path === "/v1/public-analyses/batch" &&
      row?.items?.every((item) => PUBLICATION_IDS.includes(item.historyId))
    )
      return {
        status: 200,
        body: {
          results: row.items.map((item) => {
            const receipt = publish(item.historyId);
            return {
              status: receipt.isPublic ? "PUBLISHED" : "NOT_PUBLISHED",
              ...receipt,
            };
          }),
        },
      };
    const visibility =
      /^\/v1\/public-analyses\/pa-(195[123])\/visibility$/.exec(path);
    if (method === "PUT" && visibility && typeof row?.isPublic === "boolean") {
      published.set(`h-${visibility[1]}`, row.isPublic);
      return {
        status: 200,
        body: {
          analysisId: `pa-${visibility[1]}`,
          isPublicByAuthor: row.isPublic,
          isModerationHidden: false,
          isEffectivelyPublic: row.isPublic,
          isPublic: row.isPublic,
        },
      };
    }
    return null;
  };
}
