// 제출 결과 조합, version submission-outcome-188-v1. See docs/analysis-result.md.
//
// **매칭을 계산하지 않는다.** 고른 봉우리를 합성 신호에 대응시킨 표이며 어떤
// 주기가 어느 후보와 맞는지 판정한 결과가 아니다. 그 판정은 실제 서버(C10)의
// 몫이고 이 티켓의 제외 범위다.
//
// 표 위에서 **명세의 규칙은 실제로 적용한다.** `judgment.evaluation`(6.4절),
// 성과 판정(6.3절 7번), 통계 형식(6.4절), 공개 자격이 그렇다. 규칙을 옮긴
// 것이므로 화면이 잘못 읽으면 여기서 드러난다.
//
// 결과가 봉우리와 판단으로 갈리므로 화면에서 클릭만으로 모든 조합을 만든다.

/** 후보의 판정. API 표시 어휘이며 DB의 소문자 어휘와 다르다. */
type Disposition = "CONFIRMED" | "UNCONFIRMED" | "FP";
type Judgment = "LIKELY_PLANET" | "UNLIKELY_PLANET" | "UNSURE";

/**
 * 봉우리 grid index → 합성 신호. 주기도 fixture의 추천 3개에 대응한다.
 * 확정·미확정·FP를 하나씩 두어 채점·성과·통계가 모두 다른 길로 가게 했다.
 */
const SIGNALS: Record<
  number,
  {
    candidateId: string;
    disposition: Disposition;
    /** `matched`인지 `matched_harmonic`인지. 배수로 고른 것을 흉내 낸다. */
    harmonicMultiplier: number | null;
    ai:
      | { status: "completed"; score: number; verdict: string }
      | { status: "input_insufficient" | "error" | "not_evaluated" };
    external: { source: string; externalId: string; disposition: string }[];
  }
> = {
  // 1위: 확정 행성. 채점이 되고 외부 출처가 있다.
  3600: {
    candidateId: "9007199254741101",
    disposition: "CONFIRMED",
    harmonicMultiplier: null,
    ai: { status: "completed", score: 0.93, verdict: "approved" },
    external: [{ source: "TOI", externalId: "TOI-9001.01", disposition: "CP" }],
  },
  // 2위: 미확정. 공개 분포 통계가 붙고 게시할 수 있다. 배수로 맞춘 경우다.
  2500: {
    candidateId: "9007199254741102",
    disposition: "UNCONFIRMED",
    harmonicMultiplier: 2,
    ai: { status: "completed", score: 0.71, verdict: "hold" },
    external: [{ source: "TOI", externalId: "TOI-9001.02", disposition: "PC" }],
  },
  // 3위: FP. AI를 실행하지 못한 경우를 함께 둔다.
  1600: {
    candidateId: "9007199254741103",
    disposition: "FP",
    harmonicMultiplier: null,
    ai: { status: "input_insufficient" },
    external: [{ source: "TOI", externalId: "TOI-9001.03", disposition: "FP" }],
  },
};

/**
 * 6.4절 `judgment.evaluation`. 확정·FP만 채점하고 미확정은 매기지 않는다.
 *
 * **명세 표에 FP + 모르겠음 칸이 없다.** 확정 쪽이 `UNSURE=UNSURE`이고 성과
 * 판정도 「확정·FP 오판·UNSURE」로 둘을 같이 묶으므로 대칭으로 `UNSURE`를
 * 쓴다. 추측이므로 개발 안내의 미결에 남긴다.
 */
function evaluate(disposition: Disposition, judgment: Judgment) {
  if (disposition === "UNCONFIRMED") return "UNSCORED";
  if (judgment === "UNSURE") return "UNSURE";
  const agrees =
    disposition === "CONFIRMED"
      ? judgment === "LIKELY_PLANET"
      : judgment === "UNLIKELY_PLANET";
  return agrees ? "AGREES" : "DISAGREES";
}

/**
 * 6.3절 7번 성과 판정.
 * 확정+LIKELY / FP+UNLIKELY만 인정하고, 미확정은 공개해야 판정하며,
 * 그 밖은 판단 불일치다. 이미 찾은 신호는 중복이다.
 */
function recognise(
  disposition: Disposition,
  judgment: Judgment,
  duplicate: boolean,
) {
  if (duplicate) return "already_recognized";
  if (disposition === "UNCONFIRMED") return "pending_publish";
  const agrees =
    disposition === "CONFIRMED"
      ? judgment === "LIKELY_PLANET"
      : judgment === "UNLIKELY_PLANET";
  return agrees ? "recognized" : "judgment_mismatch";
}

export type OutcomeInput = {
  sourcePeakGridIndex: number | null;
  periodDays: number;
  userJudgment: Judgment;
  /** 이미 매칭한 후보를 다시 고른 경우. 개발 전용 헤더로 만든다. */
  duplicate?: boolean;
  /** 서버가 어느 후보도 고르지 않은 경우. 개발 전용 헤더로 만든다. */
  ambiguous?: boolean;
  /** 공개한 사람이 아직 없는 경우. 0명을 0%로 그리지 않는지 본다. */
  emptyStatistics?: boolean;
};

/** 후보 제출의 결과 묶음. 여섯 축을 각각 채운다. */
export function candidateOutcome(input: OutcomeInput) {
  const signal =
    input.sourcePeakGridIndex === null
      ? null
      : (SIGNALS[input.sourcePeakGridIndex] ?? null);

  // 서버가 후보를 고르지 못했다. 신호·성과·통계가 모두 비고 다시 풀기만 남는다.
  if (input.ambiguous)
    return {
      match: { status: "ambiguous_match", candidateId: null },
      signal: null,
      judgment: { value: input.userJudgment, evaluation: "NOT_APPLICABLE" },
      achievement: none(),
      publication: { state: "NOT_ELIGIBLE", publicAnalysisId: null },
      judgmentStatistics: null,
      detail: { available: false, targetKind: null, answerViewed: false },
      // 6.4절: 어느 후보도 고르지 않았으므로 힌트는 RETRY뿐이다(AT-13).
      nextActions: ["RETRY"],
    };

  // 직접 고른 주기이거나 대응하는 합성 신호가 없다. 미매칭이다.
  if (!signal)
    return {
      match: { status: "not_matched", candidateId: null },
      signal: null,
      judgment: { value: input.userJudgment, evaluation: "NOT_APPLICABLE" },
      achievement: none(),
      publication: { state: "NOT_ELIGIBLE", publicAnalysisId: null },
      judgmentStatistics: null,
      detail: {
        available: true,
        targetKind: "CURRENT_CURVE_HINT",
        answerViewed: false,
      },
      nextActions: ["NEXT_CURVE", "DISCUSS", "LATER"],
    };

  const { disposition, harmonicMultiplier } = signal;
  const duplicate = input.duplicate === true;
  const evaluation = evaluate(disposition, input.userJudgment);
  const result = recognise(disposition, input.userJudgment, duplicate);
  const recognized = result === "recognized";
  return {
    match: {
      status: duplicate
        ? "duplicate"
        : harmonicMultiplier
          ? "matched_harmonic"
          : "matched",
      candidateId: signal.candidateId,
      harmonicMultiplier,
      // 6.3절: 정정 주기 = 제출 주기 × 배율.
      correctedPeriodDays: harmonicMultiplier
        ? input.periodDays * harmonicMultiplier
        : null,
      correctionReason: harmonicMultiplier ? "P/2 alias" : null,
    },
    signal: {
      candidateId: signal.candidateId,
      disposition,
      answerClass: disposition === "UNCONFIRMED" ? "analysis" : "graded",
      planetTruth:
        disposition === "CONFIRMED"
          ? "planet"
          : disposition === "FP"
            ? "not_planet"
            : null,
      bls: {
        periodDays: input.periodDays * (harmonicMultiplier ?? 1),
        epochBtjd: 1743.35,
        durationHours: 2.4,
        depthPpm: 8000,
        sde: null,
        snr: null,
      },
      // 실행 불가를 0점으로 바꾸지 않는다. status만 두고 score를 넣지 않는다.
      ai: { ...signal.ai, modelVersion: "astronet-triage-fixture-188" },
      external: signal.external.map((item) => ({
        ...item,
        fetchedOn: "2026-09-01",
      })),
      relabel: null,
    },
    judgment: { value: input.userJudgment, evaluation },
    achievement: {
      result,
      newlyRecognized: recognized,
      unlockedStars: recognized
        ? [{ ticId: "259377031", position: { x: 120, y: -40, z: 0.2 } }]
        : [],
      star: recognized
        ? {
            count: 1,
            grade: "A",
            byType: { confirmed: 1, unconfirmed: 0, fp: 0 },
          }
        : {
            count: 0,
            grade: null,
            byType: { confirmed: 0, unconfirmed: 0, fp: 0 },
          },
    },
    // 미확정 매칭만 게시할 수 있다. 확정·FP는 자격 자체가 없다.
    publication:
      disposition === "UNCONFIRMED"
        ? { state: "UNPUBLISHED", publicAnalysisId: null }
        : { state: "NOT_ELIGIBLE", publicAnalysisId: null },
    judgmentStatistics: statistics(disposition, input.emptyStatistics === true),
    detail: {
      available: true,
      targetKind: "CURRENT_MATCH",
      answerViewed: false,
    },
    nextActions: [
      "NEXT_CURVE",
      "VIEW_DETAIL",
      ...(disposition === "UNCONFIRMED" ? ["PUBLISH_ANALYSIS"] : []),
      "VIEW_RESULT",
      // 6.4절: matched·matched_harmonic·duplicate에만 준다(RES-08).
      "GO_HOME",
      "LATER",
    ],
  };
}

const none = () => ({
  result: "none",
  newlyRecognized: false,
  unlockedStars: [],
  star: {
    count: 0,
    grade: null,
    byType: { confirmed: 0, unconfirmed: 0, fp: 0 },
  },
});

/**
 * 6.4절 통계. 미확정과 확정·FP는 **세는 대상이 달라** 형식도 다르다.
 * 공개한 사람이 없으면 참여자 0과 `percentages: null`이며 0%가 아니다.
 */
function statistics(disposition: Disposition, empty: boolean) {
  if (disposition !== "UNCONFIRMED")
    return { kind: "graded", matchedMemberCount: 10, agreementPercent: 70 };
  if (empty)
    return {
      kind: "public_analyses",
      candidateId: null,
      participantCount: 0,
      likelyPlanet: 0,
      unlikelyPlanet: 0,
      unsure: 0,
      percentages: null,
      asOf: "2026-09-19T02:30:00Z",
    };
  return {
    kind: "public_analyses",
    candidateId: SIGNALS[2500].candidateId,
    participantCount: 15,
    likelyPlanet: 8,
    unlikelyPlanet: 4,
    unsure: 3,
    percentages: { likelyPlanet: 53.3, unlikelyPlanet: 26.7, unsure: 20 },
    asOf: "2026-09-19T02:30:00Z",
  };
}

/** 미매칭·더 없음에 주는 힌트. 그 단계에서 가장 power가 높은 후보 하나다. */
const HINT_PEAK = 3600;

/**
 * 6.7절 상세 보기. 오답 분기에서 대상 신호를 드러낸다.
 *
 * 해설 문장은 두지 않는다. 서버에 그 문장을 만들 곳이 없어 늘 null이며, 개발용
 * 응답이 지어내면 화면이 서버에 없는 모양으로 자란다.
 */
export function detailOutcome(stored: {
  matchStatus: string;
  candidateId: string | null;
  evaluation: string | null;
  /** 개발 전용 헤더. `explained`일 때만 해설이 채워진 응답을 흉내 낸다. */
  outcome?: string | null;
}) {
  // 대상이 없으면 409다. 열람 기록도 바뀌지 않는다.
  if (
    stored.matchStatus === "ambiguous_match" ||
    stored.matchStatus === "skipped"
  )
    return null;

  const matched = ["matched", "matched_harmonic", "duplicate"].includes(
    stored.matchStatus,
  );
  const gridIndex = matched
    ? Number(
        Object.keys(SIGNALS).find(
          (key) => SIGNALS[Number(key)].candidateId === stored.candidateId,
        ),
      )
    : HINT_PEAK;
  const signal = SIGNALS[gridIndex];
  if (!signal) return null;
  return {
    targetKind: matched ? "CURRENT_MATCH" : "CURRENT_CURVE_HINT",
    signal: {
      candidateId: signal.candidateId,
      disposition: signal.disposition,
      answerClass: signal.disposition === "UNCONFIRMED" ? "analysis" : "graded",
      planetTruth:
        signal.disposition === "CONFIRMED"
          ? "planet"
          : signal.disposition === "FP"
            ? "not_planet"
            : null,
      bls: {
        periodDays: 11.7346,
        epochBtjd: 1743.35,
        durationHours: 2.4,
        depthPpm: 8000,
        sde: null,
        snr: null,
      },
      ai: { ...signal.ai, modelVersion: "astronet-triage-fixture-188" },
      external: signal.external.map((item) => ({
        ...item,
        fetchedOn: "2026-09-01",
      })),
      // 서버는 이 문장을 만들 곳이 없어 늘 null을 보낸다(6.7절). 개발용 응답이 지어내면
      // 화면이 서버에 없는 모양으로 자란다. 기본값은 그래서 null이다.
      //
      // 서버가 채우기 시작하는 날 가장 먼저 필요한 검사가 「오면 그대로 보여준다」라
      // 개발 전용 `explained` 사례 하나만 문장을 들고 있게 둔다. 이 사례는 클릭으로
      // 만들 수 없고 헤더로만 켜지므로 기본 응답은 그대로 서버와 같다.
      explanation:
        stored.outcome === "explained"
          ? "가려진 시간이 길고 깊이가 커 식쌍성으로 보입니다."
          : null,
    },
    // 매칭한 제출에만 일치 여부를 준다(RES-02). 채점하지 않았으면 null이다.
    userJudgmentAgrees: !matched
      ? null
      : stored.evaluation === "AGREES"
        ? true
        : stored.evaluation === "DISAGREES"
          ? false
          : null,
  };
}
