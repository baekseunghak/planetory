// #191 공개 분석 상세의 개발용 응답.
//
// 서버는 첨부와 **같은 함수**(`publicContent`·`publicGraph`)로 만들므로 그래프
// 모양이 같다. 다른 것은 겉을 감싸는 네 값뿐이다 — `analysisId`·`threadId`·
// `author`·`firstPublishedAt`. 그래서 여기서 그래프를 새로 정의하지 않고
// 첨부 응답과 같은 모양을 쓴다.
//
// 합성 응답이라 **실제 인수를 대신하지 않는다.** 두 계정 권한 회귀는 실제
// 경로로 해야 한다.

const author = { memberId: "u-209", nickname: "관측자" };

/** `pa-2`는 당시 배열이 없는 기록이다(매칭 실패). `pa-3`은 그래프가 503이다. */
const KNOWN = ["pa-1", "pa-2", "pa-3"];

function graphOf(analysisId: string, historyId: string, submitted: boolean) {
  return {
    historyId,
    reproduction: {
      submittedBundleId: "b-1",
      currentBundleId: "b-2",
      isPreviousSubmission: true,
      currentFoldReferenceTimeBtjd: 1683.35,
      residualReproducible: analysisId !== "pa-2",
      fallbackReason: analysisId === "pa-2" ? "RETIRED_CANDIDATE" : null,
    },
    selection: {
      userPeriodDays: 3.21,
      correctedPeriodDays: 3.21,
      harmonicMultiplier: 1,
      epochBtjd: 1684.02,
      durationHours: 2.4,
    },
    curve: submitted
      ? null
      : {
          ticId: "259377017",
          bundleId: "b-2",
          curveContext: {
            bundleId: "b-2",
            curveStep: 0,
            removedCandidateIds: [],
            residualModelVersion: "rm-1",
            periodogramConfigVersion: "pg-1",
          },
          foldReferenceTimeBtjd: 1683.35,
          segments: [
            {
              segmentId: "seg-1",
              sector: 14,
              binningRevision: 1,
              startBtjd: 1683.35,
              binMinutes: 10,
              nPoints: 4,
              flux: [1, 0.99, null, 1.01],
              fluxScatter: 0.001,
              gaps: [[2, 2]],
            },
          ],
        },
    // 매칭 실패 기록은 당시 배열이 없다. 409가 아니라 200에 snapshot: null이다.
    snapshot:
      submitted && analysisId !== "pa-2"
        ? {
            bins: 150,
            foldedFlux: Array(150).fill(1),
            foldedError: Array(150).fill(0.001),
          }
        : null,
  };
}

export type FixtureReply = { status: number; body: unknown };

export function publicAnalysisFixture(
  pathname: string,
  params: URLSearchParams,
): FixtureReply | null {
  const match = pathname.match(/^\/v1\/public-analyses\/([^/]+)$/);
  if (!match) return null;
  const analysisId = match[1];
  if (!KNOWN.includes(analysisId))
    return {
      status: 404,
      body: {
        code: "RESOURCE_NOT_FOUND",
        message: "자료를 찾을 수 없거나 볼 수 없습니다.",
      },
    };
  const includeGraph = params.get("includeGraph") !== "false";
  // 그래프만 못 읽는 경우. 화면은 같은 경로에 includeGraph=false로 다시 묻고
  // **공개 내용은 지킨다**(서비스 API 7.2).
  if (analysisId === "pa-3" && includeGraph)
    return {
      status: 503,
      body: {
        code: "GRAPH_TEMPORARILY_UNAVAILABLE",
        message:
          "판이 변경되어 그래프를 불러오지 못했습니다. 다시 조회해 주세요.",
      },
    };
  const historyId = "h-50" + analysisId.slice(-1);
  const submitted = params.get("graphMode") === "SUBMITTED";
  return {
    status: 200,
    body: {
      analysisId,
      threadId: "st-1",
      ticId: "259377017",
      candidateId: "c-401",
      author,
      submittedAt: "2026-09-18T01:00:00Z",
      firstPublishedAt: "2026-09-19T02:00:00Z",
      judgment: "UNSURE",
      evidenceChecks: ["ushape"],
      memo: "191 합성 공개 분석 메모",
      original: {
        periodDays: 3.21,
        sourcePeakGridIndex: 12,
        phaseStart: 0.1,
        phaseEnd: 0.2,
      },
      serverDerived: { epochBtjd: 1684.02, durationHours: 2.4 },
      match: {
        status: "matched",
        correctedPeriodDays: 3.21,
        harmonicMultiplier: 1,
      },
      curveContext: {
        bundleId: "b-2",
        curveStep: 0,
        removedCandidateIds: [],
        residualModelVersion: "rm-1",
        periodogramConfigVersion: "pg-1",
      },
      versions: {
        data: "b-2",
        preprocess: null,
        pipeline: null,
        rule: "rule-1",
        residualModel: "rm-1",
        periodogramConfig: "pg-1",
        snapshotVersion: "folded-mad-v1",
      },
      graph: includeGraph ? graphOf(analysisId, historyId, submitted) : null,
      relabel: null,
    },
  };
}
