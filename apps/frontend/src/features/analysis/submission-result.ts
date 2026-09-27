import type { MatchStatus } from "./submission-data.ts";

// 탐사 API 6.4절 결과 부분. 여섯 축을 각각 읽고 **서로 추측하지 않는다.**
// 한 축이 비었다고 다른 축을 0이나 없음으로 바꾸지 않는다.
// 자세한 이유는 docs/analysis-result.md.

/** 후보 판정. API의 표시 어휘이며 DB의 소문자 어휘와 다르다. */
export const dispositions = ["CONFIRMED", "UNCONFIRMED", "FP"] as const;
export type Disposition = (typeof dispositions)[number];
const answerClasses = ["graded", "analysis"] as const;
const planetTruths = ["planet", "not_planet"] as const;
const aiStatuses = [
  "completed",
  "input_insufficient",
  "error",
  "not_evaluated",
] as const;
export type AiStatus = (typeof aiStatuses)[number];
const evaluations = [
  "AGREES",
  "DISAGREES",
  "UNSURE",
  "UNSCORED",
  "NOT_APPLICABLE",
] as const;
export type Evaluation = (typeof evaluations)[number];
// ERD achievement_result CHECK 그대로.
const achievementResults = [
  "recognized",
  "judgment_mismatch",
  "pending_publish",
  "already_recognized",
  "none",
] as const;
export type AchievementResult = (typeof achievementResults)[number];
/**
 * 6.4절의 공개 상태는 **둘뿐이다.** 「미확정 매칭만 `UNPUBLISHED`, 확정·FP는
 * `NOT_ELIGIBLE`」이라 제출 직후에는 이미 공개된 상태가 올 수 없다.
 *
 * 6.6절 조회·8.2절 기록 상세는 같은 본문을 쓰지만 시간이 지난 뒤라 `PUBLISHED`·`HIDDEN`이
 * 더 온다. **여기서 넓히지 않는다** — 넓히면 제출 응답이 공개됐다고 말해도
 * 통과한다. 읽는 쪽이 자기 계약의 집합을 준다.
 */
const publicationStates = ["UNPUBLISHED", "NOT_ELIGIBLE"] as const;
export const storedPublicationStates = [
  "UNPUBLISHED",
  "NOT_ELIGIBLE",
  "PUBLISHED",
  "HIDDEN",
] as const;
export type PublicationState = (typeof storedPublicationStates)[number];
const detailTargets = ["CURRENT_MATCH", "CURRENT_CURVE_HINT"] as const;
export type DetailTarget = (typeof detailTargets)[number];

/** 매칭 성공에만 붙는다. `not_matched`·`ambiguous_match`는 없다(AT-14·75). */
export type SubmissionSignal = {
  candidateId: string;
  disposition: Disposition;
  /** `graded`는 채점되는 신호, `analysis`는 아직 확정되지 않은 신호다. */
  answerClass: (typeof answerClasses)[number];
  planetTruth: (typeof planetTruths)[number] | null;
  bls: {
    periodDays: number;
    epochBtjd: number;
    durationHours: number;
    depthPpm: number;
    /** Gold 스키마에 열이 없어 **null로 온다.** 0이 아니라 자료가 없는 것이다. */
    sde: number | null;
    snr: number | null;
  };
  /**
   * 실행하지 못했으면 `score`·`verdict`가 **없다.** 0으로 바꾸지 않는다
   * (RES-04, AT-15). 화면은 `status`로 왜 없는지 설명한다.
   */
  ai: { status: AiStatus; modelVersion: string | null } & (
    | { score: number; verdict: string }
    | { score?: undefined; verdict?: undefined }
  );
  /**
   * 외부 출처. `disposition`은 **원천 표기**이며 우리 열거형이 아니다.
   * 받은 문자열을 그대로 보여 주고 우리 판정으로 번역하지 않는다.
   */
  external: {
    source: string;
    externalId: string;
    disposition: string;
    fetchedOn: string;
  }[];
};

/** 고조파 정정. 정정 주기 = 제출 주기 × 배율(6.3절). */
export type HarmonicCorrection = {
  multiplier: number;
  correctedPeriodDays: number;
  reason: string | null;
};

/**
 * 폭만 벗어난 불일치의 힌트(6.4절 `match.missHint`). 주기·위치가 맞고 구간
 * 폭만 신호와 달랐을 때 `not_matched`에만 온다.
 */
export const missHints = ["WINDOW_TOO_WIDE", "WINDOW_TOO_NARROW"] as const;
export type MissHint = (typeof missHints)[number];

/** 서버가 산정한 값. 제출값 확인의 미리보기와 다를 수 있다. */
export type ServerDerived = {
  /** 고른 것이 없으면 계산할 것도 없다. 특수 제출에서는 null이다. */
  epochBtjd: number | null;
  durationHours: number | null;
  phaseCenter: number | null;
  foldReferenceTimeBtjd: number;
  /** 봉우리에서 시작하지 않았으면 없다. */
  sourcePeakSuggestedDurationHours: number | null;
  durationLimitHours: number | null;
  centroidDataStatus: string;
};

export type Achievement = {
  result: AchievementResult;
  /**
   * 이번에 인정됐는지. **재현 응답에도 접수 당시 값이 그대로 실린다.**
   * 한 번만 보여 줄 연출은 `outcome`이 아니라 **회원·`submissionId`별 표시
   * 이력**으로 가른다(2.2절). 201만 연출하면 최초 201을 잃고 200으로 처음
   * 복구한 사용자는 성과를 한 번도 보지 못한다.
   */
  newlyRecognized: boolean;
  /** 이번에 열린 별의 TIC(AT-58). 좌표는 지도가 쓰므로 읽지 않는다. */
  unlockedTicIds: string[];
  star: { count: number; grade: string | null };
};

/**
 * 판단 통계. 두 형식은 **세는 대상이 다르다.**
 * `graded`는 첫 매칭 회원의 일치율, `public_analyses`는 공개된 분석의 분포다.
 */
export type JudgmentStatistics =
  | { kind: "graded"; matchedMemberCount: number; agreementPercent: number }
  | {
      kind: "public_analyses";
      participantCount: number;
      likelyPlanet: number;
      unlikelyPlanet: number;
      unsure: number;
      /** 공개한 사람이 없으면 null이다. **0%가 아니다.** */
      percentages: {
        likelyPlanet: number;
        unlikelyPlanet: number;
        unsure: number;
      } | null;
      asOf: string;
    };

/** 내가 낸 값. 복구·재현으로 받은 결과에는 화면의 초안이 없을 수 있다. */
export type SubmittedSelection = {
  /**
   * 특수 제출(`no_candidate`·`skipped`)은 고른 것이 없어 **null**이다.
   * 서버는 객체를 두고 안쪽만 비운다.
   */
  periodDays: number | null;
  phaseStart: number | null;
  phaseEnd: number | null;
  sourcePeakGridIndex: number | null;
};

export type ResultExplanation = {
  /** 특수 제출은 선택이 없으므로 null이다. */
  submitted: SubmittedSelection | null;
  signal: SubmissionSignal | null;
  correction: HarmonicCorrection | null;
  missHint: MissHint | null;
  serverDerived: ServerDerived | null;
  evaluation: Evaluation | null;
  achievement: Achievement;
  publication: {
    state: PublicationState;
    publicAnalysisId: string | null;
  };
  statistics: JudgmentStatistics | null;
  detail: {
    available: boolean;
    targetKind: DetailTarget | null;
    answerViewed: boolean;
  };
};

function invalid(field: string): never {
  throw new Error(`제출 결과의 ${field} 항목을 확인해 주세요.`);
}
const record = (value: unknown, field: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) invalid(field);
  return value;
};
const number = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
};
const flag = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") invalid(field);
  return value;
};
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!allowed.some((item) => item === value)) invalid(field);
  return value as T;
}
const nullable = <T>(value: unknown, read: (value: unknown) => T): T | null =>
  value === null || value === undefined ? null : read(value);

/** 매칭 성공에만 신호가 온다. 있고 없음을 상태와 대조한다. */
const MATCHED: readonly MatchStatus[] = [
  "matched",
  "matched_harmonic",
  "duplicate",
];

/** 정정값을 들고 올 수 있는 상태. 평범한 `matched`에는 오지 않는다. */
const CORRECTABLE: readonly MatchStatus[] = ["matched_harmonic", "duplicate"];

function readSignal(value: unknown): SubmissionSignal {
  const data = record(value, "signal");
  const bls = record(data.bls, "signal.bls");
  const ai = record(data.ai, "signal.ai");
  const status = oneOf(ai.status, aiStatuses, "signal.ai.status");
  // 실행하지 못했으면 점수를 읽지 않는다. 있어도 쓰지 않는다.
  const scored =
    status === "completed"
      ? {
          score: number(ai.score, "signal.ai.score"),
          verdict: text(ai.verdict, "signal.ai.verdict"),
        }
      : {};
  return {
    candidateId: text(data.candidateId, "signal.candidateId"),
    disposition: oneOf(data.disposition, dispositions, "signal.disposition"),
    answerClass: oneOf(data.answerClass, answerClasses, "signal.answerClass"),
    planetTruth: nullable(data.planetTruth, (item) =>
      oneOf(item, planetTruths, "signal.planetTruth"),
    ),
    bls: {
      periodDays: number(bls.periodDays, "signal.bls.periodDays"),
      epochBtjd: number(bls.epochBtjd, "signal.bls.epochBtjd"),
      durationHours: number(bls.durationHours, "signal.bls.durationHours"),
      depthPpm: number(bls.depthPpm, "signal.bls.depthPpm"),
      // Gold 스키마에 아직 열이 없어 서버가 null을 보낸다. **0으로 바꾸지
      // 않는다.** 자료가 없는 것과 0은 다르다(RES-04와 같은 이유).
      sde: nullable(bls.sde, (item) => number(item, "signal.bls.sde")),
      snr: nullable(bls.snr, (item) => number(item, "signal.bls.snr")),
    },
    ai: {
      status,
      modelVersion: nullable(ai.modelVersion, (item) =>
        text(item, "signal.ai.modelVersion"),
      ),
      ...scored,
    },
    external: (Array.isArray(data.external) ? data.external : []).map(
      (item) => {
        const row = record(item, "signal.external");
        return {
          source: text(row.source, "signal.external.source"),
          externalId: text(row.externalId, "signal.external.externalId"),
          // 원천 표기다. 우리 열거형과 대조하지 않는다.
          disposition: text(row.disposition, "signal.external.disposition"),
          fetchedOn: text(row.fetchedOn, "signal.external.fetchedOn"),
        };
      },
    ),
  };
}

export function readStatistics(value: unknown): JudgmentStatistics {
  const data = record(value, "judgmentStatistics");
  if (data.kind === "graded")
    return {
      kind: "graded",
      matchedMemberCount: number(
        data.matchedMemberCount,
        "judgmentStatistics.matchedMemberCount",
      ),
      agreementPercent: number(
        data.agreementPercent,
        "judgmentStatistics.agreementPercent",
      ),
    };
  if (data.kind !== "public_analyses") invalid("judgmentStatistics.kind");
  const participantCount = number(
    data.participantCount,
    "judgmentStatistics.participantCount",
  );
  const percentages = nullable(data.percentages, (item) => {
    const row = record(item, "judgmentStatistics.percentages");
    return {
      likelyPlanet: number(row.likelyPlanet, "percentages.likelyPlanet"),
      unlikelyPlanet: number(row.unlikelyPlanet, "percentages.unlikelyPlanet"),
      unsure: number(row.unsure, "percentages.unsure"),
    };
  });
  // 공개한 사람이 없으면 비율이 없어야 한다. 0%로 바꿔 오면 거절한다.
  if (participantCount === 0 && percentages !== null)
    invalid("judgmentStatistics.percentages");
  return {
    kind: "public_analyses",
    participantCount,
    likelyPlanet: number(data.likelyPlanet, "judgmentStatistics.likelyPlanet"),
    unlikelyPlanet: number(
      data.unlikelyPlanet,
      "judgmentStatistics.unlikelyPlanet",
    ),
    unsure: number(data.unsure, "judgmentStatistics.unsure"),
    percentages,
    asOf: text(data.asOf, "judgmentStatistics.asOf"),
  };
}

/**
 * 6.4절의 결과 부분을 읽는다.
 *
 * @param matchStatus 이미 읽은 매칭 상태. 신호·통계의 **있고 없음을 대조**한다.
 * 매칭에 실패했는데 신호가 오면 응답을 잘못 읽은 것이다.
 */
export function readResultExplanation(
  data: Record<string, unknown>,
  matchStatus: MatchStatus,
  allowedPublication: readonly PublicationState[] = publicationStates,
): ResultExplanation {
  const matched = MATCHED.includes(matchStatus);
  const signal = nullable(data.signal, readSignal);
  if (matched !== (signal !== null)) invalid("signal/match.status");

  const match = record(data.match, "match");
  const multiplier = nullable(match.harmonicMultiplier, (item) =>
    number(item, "match.harmonicMultiplier"),
  );
  // 배수 정정은 `matched_harmonic`과, 그것을 다시 맞힌 `duplicate`에만 온다
  // (SubmissionMatching.markDuplicate가 후보와 정정값을 그대로 남긴다).
  // 그 밖의 상태에 배수가 오면 어긋난 응답이다.
  if (multiplier !== null && !CORRECTABLE.includes(matchStatus))
    invalid("match.harmonicMultiplier");
  if (matchStatus === "matched_harmonic" && multiplier === null)
    invalid("match.harmonicMultiplier");

  const achievement = record(data.achievement, "achievement");
  const star = record(achievement.star, "achievement.star");
  const publication = record(data.publication, "publication");
  const detail = record(data.detail, "detail");
  const targetKind = nullable(detail.targetKind, (item) =>
    oneOf(item, detailTargets, "detail.targetKind"),
  );
  const statistics = nullable(data.judgmentStatistics, readStatistics);
  // 미매칭·모호에는 임의 신호의 통계를 붙이지 않는다.
  if (!matched && statistics !== null)
    invalid("judgmentStatistics/match.status");

  return {
    submitted: nullable(data.original, (item) => {
      const row = record(item, "original");
      return {
        // 특수 제출(`no_candidate`·`skipped`)은 고른 것이 없다. 서버는
        // 객체를 두고 **안쪽을 null로** 보낸다. 해당 없음이지 오류가 아니다.
        periodDays: nullable(row.periodDays, (value) =>
          number(value, "original.periodDays"),
        ),
        phaseStart: nullable(row.phaseStart, (value) =>
          number(value, "original.phaseStart"),
        ),
        phaseEnd: nullable(row.phaseEnd, (value) =>
          number(value, "original.phaseEnd"),
        ),
        sourcePeakGridIndex: nullable(row.sourcePeakGridIndex, (value) =>
          number(value, "original.sourcePeakGridIndex"),
        ),
      };
    }),
    signal,
    correction:
      multiplier === null
        ? null
        : {
            multiplier,
            correctedPeriodDays: number(
              match.correctedPeriodDays,
              "match.correctedPeriodDays",
            ),
            reason: nullable(match.correctionReason, (item) =>
              text(item, "match.correctionReason"),
            ),
          },
    // 힌트일 뿐이라 모르는 값·다른 상태의 값은 버리고 결과 전체를 거절하지
    // 않는다. 힌트가 없는 옛 응답도 그대로 읽는다.
    missHint:
      matchStatus === "not_matched" &&
      missHints.some((item) => item === match.missHint)
        ? (match.missHint as MissHint)
        : null,
    serverDerived: nullable(data.serverDerived, (item) => {
      const row = record(item, "serverDerived");
      return {
        // 같은 이유로 계산값도 안쪽이 null일 수 있다. 접기 기준 시각만은
        // 판의 값이라 특수 제출에도 온다.
        epochBtjd: nullable(row.epochBtjd, (value) =>
          number(value, "serverDerived.epochBtjd"),
        ),
        durationHours: nullable(row.durationHours, (value) =>
          number(value, "serverDerived.durationHours"),
        ),
        phaseCenter: nullable(row.phaseCenter, (value) =>
          number(value, "serverDerived.phaseCenter"),
        ),
        foldReferenceTimeBtjd: number(
          row.foldReferenceTimeBtjd,
          "serverDerived.foldReferenceTimeBtjd",
        ),
        sourcePeakSuggestedDurationHours: nullable(
          row.sourcePeakSuggestedDurationHours,
          (value) => number(value, "serverDerived.sourcePeakSuggested"),
        ),
        durationLimitHours: nullable(row.durationLimitHours, (value) =>
          number(value, "serverDerived.durationLimitHours"),
        ),
        centroidDataStatus: text(
          row.centroidDataStatus,
          "serverDerived.centroidDataStatus",
        ),
      };
    }),
    evaluation: nullable(
      record(data.judgment ?? {}, "judgment").evaluation,
      (item) => oneOf(item, evaluations, "judgment.evaluation"),
    ),
    achievement: {
      result: oneOf(
        achievement.result,
        achievementResults,
        "achievement.result",
      ),
      newlyRecognized: flag(
        achievement.newlyRecognized,
        "achievement.newlyRecognized",
      ),
      unlockedTicIds: (Array.isArray(achievement.unlockedStars)
        ? achievement.unlockedStars
        : invalid("achievement.unlockedStars")
      ).map((item) =>
        text(record(item, "unlockedStars").ticId, "unlockedStars.ticId"),
      ),
      star: {
        count: number(star.count, "achievement.star.count"),
        grade: nullable(star.grade, (item) =>
          text(item, "achievement.star.grade"),
        ),
      },
    },
    publication: {
      state: oneOf(publication.state, allowedPublication, "publication.state"),
      publicAnalysisId: nullable(publication.publicAnalysisId, (item) =>
        text(item, "publication.publicAnalysisId"),
      ),
    },
    statistics,
    detail: {
      available: flag(detail.available, "detail.available"),
      targetKind,
      answerViewed: flag(detail.answerViewed, "detail.answerViewed"),
    },
  };
}

/** 6.7절 상세 보기. 오답 분기에서 대상 신호를 드러낸다. */
export type DetailView = {
  submissionId: string;
  /** 이 호출로 열람 기록이 남았다. 건너뛰기 조건에 쓰인다(6.5절). */
  answerViewed: boolean;
  targetKind: DetailTarget;
  /** 해설은 **키는 있고 값이 없을 수 있다**. 서버가 아직 이 문장을 만들 곳이 없다(6.7절). */
  signal: SubmissionSignal & { explanation: string | null };
  /** 매칭한 제출에만 일치 여부가 있다(RES-02). 채점하지 않았으면 null이다. */
  userJudgmentAgrees: boolean | null;
  /** 참이면 화면 끝에 [다음 튜토리얼로]를 둔다. */
  tutorial: { seq: number | null; skipAvailable: boolean };
};

export const detailViewPath = (submissionId: string) =>
  `/v1/submissions/${encodeURIComponent(submissionId)}/detail-view`;

/**
 * 6.7절 `signal.explanation`. **키는 있고 값이 null일 수 있다.** 서버가 이 문장을 만들 곳이 아직
 * 없어 지금은 늘 null이다.
 *
 * 키가 아예 없으면 null로 읽지 않는다. 「해설 없음」과 「모르는 응답」은 다르고, 명세가 자리를
 * 남긴 이유가 그 구분이다.
 */
function explanation(signal: Record<string, unknown>): string | null {
  if (!("explanation" in signal)) invalid("signal.explanation");
  const value = signal.explanation;
  return value === null ? null : text(value, "signal.explanation");
}

export function decodeDetailView(
  value: unknown,
  expected: { submissionId: string },
): DetailView {
  const data = record(value, "detail-view");
  if (text(data.submissionId, "submissionId") !== expected.submissionId)
    invalid("submissionId");
  const signal = readSignal(data.signal);
  const tutorial = record(data.tutorial ?? {}, "tutorial");
  return {
    submissionId: expected.submissionId,
    answerViewed: flag(data.answerViewed, "answerViewed"),
    targetKind: oneOf(data.targetKind, detailTargets, "targetKind"),
    signal: {
      ...signal,
      explanation: explanation(record(data.signal, "signal")),
    },
    userJudgmentAgrees: nullable(data.userJudgmentAgrees, (item) =>
      flag(item, "userJudgmentAgrees"),
    ),
    tutorial: {
      seq: nullable(tutorial.seq, (item) => number(item, "tutorial.seq")),
      skipAvailable: tutorial.skipAvailable === true,
    },
  };
}
