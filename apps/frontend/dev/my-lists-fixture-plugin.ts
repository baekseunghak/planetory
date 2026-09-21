import type { Plugin } from "vite";

// #196 마이페이지 두 목록의 개발용 응답.
//
// **남의 fixture를 넓히지 않는다.** `profiles` 모드는 profile·community
// 플러그인을 함께 쓰는데, community 쪽 `/v1/me/histories`는 첨부 선택이 쓰는
// 최소 항목(서비스 API 7.1)이라 목록 화면이 요구하는 8.1 전체 항목이 없다.
// 그쪽을 넓히면 첨부 검사의 전제를 바꾸게 되므로 이 플러그인을 **먼저** 태워
// 목록 경로만 가로챈다.

const AT = "2026-09-20T02:30:00Z";

/** 백엔드 StarService와 같은 허용값. 계약 밖은 400이다. */
const STAGES = ["unexplored", "in_progress", "completed"];
const GRADES = ["A", "S", "SS", "SSS"];

type Row = Record<string, unknown>;

const star = (index: number, own: boolean): Row => ({
  ticId: String(259377000 + index),
  progressStage: index % 3 === 0 ? "completed" : "in_progress",
  planetCount: index % 3,
  completedWithoutPlanets: index % 3 === 0 && index % 2 === 1,
  achievementCount: index % 2,
  grade: index % 2 ? "S" : null,
  currentCurveStep: index % 2 ? 1 : null,
  reopenPending: index === 2,
  reopened: false,
  // 본인에게만 싣는다. 타인 응답에서는 키 자체가 없어야 한다(NFR-14).
  ...(own ? { unpublishedSignalCount: index % 4 } : {}),
  // 같은 활동 시각을 일부러 겹쳐 둔다. 커서가 시각만 담으면 경계에서 밀린다.
  lastActivityAt: index < 2 ? AT : `2026-09-1${9 - (index % 9)}T02:30:00Z`,
  unlockReason: index % 2 ? "achievement" : null,
  marker: null,
});

const history = (index: number): Row => {
  const results = [
    "matched",
    "matched_harmonic",
    "duplicate",
    "not_matched",
    "ambiguous_match",
    "none_wrong",
    "skipped",
  ];
  const matchResult = results[index % results.length];
  return {
    historyId: "h-" + (601 + index),
    submissionId: "sub-" + (7601 + index),
    ticId: "259377017",
    candidateId: matchResult === "not_matched" ? null : "c-" + (401 + index),
    submissionKind:
      matchResult === "none_wrong"
        ? "no_candidate"
        : matchResult === "skipped"
          ? "skipped"
          : "candidate",
    matchResult,
    userJudgment: index % 2 ? "LIKELY_PLANET" : "UNSURE",
    achievementResult: index % 2 ? "recognized" : "none",
    submittedAt: AT,
    bundleId: "b-3",
    isPreviousBundle: index === 1,
    curveStep: index % 2,
    publication: {
      publicAnalysisId: index === 0 ? "pa-1" : null,
      isPublic: index === 0,
      isModerationHidden: index === 3,
    },
    achievementGranted: index % 2 === 1,
    snapshotAvailable: index !== 4,
    // 최초 응답이 없는 기록. 목록에는 남지만 상세로 보내면 안 된다(8.1).
    detailAvailable: index !== 2,
    answerViewed: false,
    relabel: null,
    retryOfSubmissionId: null,
  };
};

/** `result=matched`는 셋을 묶는다. 화면 이름표와 일대일이 아니다. */
const MATCHED = new Set(["matched", "matched_harmonic", "duplicate"]);

function page(rows: Row[], cursor: string | null, size = 3) {
  const start = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(start) || start < 0) return null;
  const slice = rows.slice(start, start + size);
  const next = start + size < rows.length ? String(start + size) : null;
  return { items: slice, nextCursor: next, hasNext: next !== null };
}

export function myListsFixturePlugin(): Plugin {
  const own = Array.from({ length: 7 }, (_, i) => star(i, true));
  const other = Array.from({ length: 4 }, (_, i) => star(i, false));
  const histories = Array.from({ length: 9 }, (_, i) => history(i));
  return {
    name: "my-lists-fixture",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api")) return next();
        const path = url.pathname.replace(/^\/api/, "");
        const cursor = url.searchParams.get("cursor");
        const send = (body: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        const reject = (field: string) =>
          send(
            {
              code: "VALIDATION_FAILED",
              message: `${field} 값을 확인해 주세요.`,
            },
            400,
          );

        if (req.method !== "GET") return next();

        if (
          path === "/v1/me/stars" ||
          /^\/v1\/members\/[^/]+\/stars$/.test(path)
        ) {
          // S15P21C206-152가 단계·등급·TIC 필터를 붙였다. 서버처럼 허용값만
          // 받고 계약 밖 값은 400이다. 화면(#196)은 필터 UI가 제외 범위라
          // 보내지 않지만, 보내면 어떻게 되는지를 여기서 사실대로 둔다.
          const stage = url.searchParams.get("stage");
          if (stage && !STAGES.includes(stage)) return reject("stage");
          const grade = url.searchParams.get("grade");
          if (grade && !GRADES.includes(grade)) return reject("grade");
          const tic = url.searchParams.get("ticId");
          if (tic && !/^[1-9][0-9]*$/.test(tic)) return reject("ticId");
          const mine = path === "/v1/me/stars";
          if (!mine && url.searchParams.get("scope") === "discovered")
            return reject("scope");
          const rows = (mine ? own : other).filter(
            (row) =>
              (!stage || row.progressStage === stage) &&
              (!grade || row.grade === grade) &&
              (!tic || row.ticId === tic),
          );
          const body = page(rows, cursor);
          return body ? send(body) : reject("cursor");
        }

        if (path === "/v1/me/histories") {
          const result = url.searchParams.get("result") ?? "";
          if (
            result &&
            ![
              "matched",
              "not_matched",
              "none_wrong",
              "ambiguous_match",
              "skipped",
            ].includes(result)
          )
            return reject("result");
          const rows = histories.filter((row) => {
            if (!result) return true;
            const value = String(row.matchResult);
            return result === "matched" ? MATCHED.has(value) : value === result;
          });
          const body = page(rows, cursor);
          return body ? send(body) : reject("cursor");
        }

        return next();
      });
    },
  };
}
