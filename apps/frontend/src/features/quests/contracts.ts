import {
  readTutorialMarkers,
  type TutorialMarkers,
} from "../sky-renderer/interaction";

export const intentLabels = {
  deep_confirmed: "뚜렷한 신호 · 봉우리와 구간 고르기",
  shallow_confirmed: "얕은 신호 · 곡선 확대하고 남은 곡선에서 이어 찾기",
  fp: "행성 아님 신호 · 확인 도구 사용하기",
  deep_fp: "서로 가리는 쌍성 · 깊은 신호 구별하기",
  multi_fp: "여러 신호 · 남은 곡선에서 반복 탐색하기",
} as const;
export type TutorialItem = {
  seq: number;
  intent: keyof typeof intentLabels;
  status: "locked" | "unlocked" | "in_progress" | "completed";
  ticId: string | null;
  completionReason: "all_found" | "undiscoverable_only" | "skipped" | null;
};
export type Round = {
  roundId: string;
  roundNo: number;
  startsOn: string;
  endsOn: string;
  description: string;
};
export type Quests = {
  asOf: string;
  tutorial: { completedCount: number; items: TutorialItem[] };
  challenge: {
    round: Round | null;
    eligible: boolean;
    ticId: string | null;
    unlocked: boolean;
    progressStage: "unexplored" | "in_progress" | "completed" | null;
    participantCount: number | null;
  };
  reopened: {
    ticId: string;
    reopenedAt: string;
    newDiscoverableCount: number | null;
  }[];
};
export type CurrentChallenge = {
  round:
    | (Round & {
        status: "planned" | "active" | "closed";
        ticId: string | null;
      })
    | null;
  eligible: boolean;
  participantCount: number | null;
};
const fail = (): never => {
  throw new Error(
    "탐사 안내 자료의 형식을 확인할 수 없습니다. 다시 불러와 주세요.",
  );
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown): string =>
  typeof v === "string" && v.trim() ? v : fail();
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
const count = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail();
const tic = (v: unknown): string =>
  /^\d+$/.test(text(v)) ? (v as string) : fail();
const stamp = (v: unknown): string =>
  Number.isFinite(Date.parse(text(v))) &&
  /(?:Z|[+-]\d{2}:\d{2})$/.test(v as string)
    ? (v as string)
    : fail();
const day = (v: unknown): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(text(v)) &&
  Number.isFinite(Date.parse(v as string)) &&
  new Date(v as string).toISOString().slice(0, 10) === v
    ? (v as string)
    : fail();
function readRound(value: unknown): Round {
  const v = obj(value),
    roundNo = count(v.roundNo),
    startsOn = day(v.startsOn),
    endsOn = day(v.endsOn);
  if (roundNo < 1 || endsOn < startsOn) return fail();
  return {
    roundId: text(v.roundId),
    roundNo,
    startsOn,
    endsOn,
    description: text(v.description),
  };
}
export function readQuests(value: unknown): Quests {
  readTutorialMarkers(value);
  const v = obj(value),
    t = obj(v.tutorial),
    c = obj(v.challenge);
  const items = (t.items as unknown[])
    .map((raw) => {
      const s = obj(raw);
      if (
        typeof s.intent !== "string" ||
        !Object.hasOwn(intentLabels, s.intent)
      )
        return fail();
      if (
        s.status === "completed"
          ? !["all_found", "undiscoverable_only", "skipped"].includes(
              s.completionReason as string,
            )
          : s.completionReason !== null
      )
        return fail();
      return {
        seq: count(s.seq),
        intent: s.intent,
        status: s.status,
        ticId: s.ticId,
        completionReason: s.completionReason,
      } as TutorialItem;
    })
    .sort((a, b) => a.seq - b.seq);
  const completedCount = count(t.completedCount);
  if (completedCount !== items.filter((i) => i.status === "completed").length)
    return fail();
  const round = c.round === null ? null : readRound(c.round),
    eligible = bool(c.eligible),
    unlocked = bool(c.unlocked);
  const ticId = c.ticId === null ? null : tic(c.ticId);
  const participantCount =
    c.participantCount === null ? null : count(c.participantCount);
  if (
    unlocked !== (ticId !== null) ||
    (unlocked
      ? !["unexplored", "in_progress", "completed"].includes(
          c.progressStage as string,
        )
      : c.progressStage !== null)
  )
    return fail();
  if (!round && (eligible || unlocked || participantCount !== null))
    return fail();
  if (round && participantCount === null) return fail();
  if (!Array.isArray(v.reopened)) return fail();
  const reopened = v.reopened.map((raw) => {
    const r = obj(raw);
    return {
      ticId: tic(r.ticId),
      reopenedAt: stamp(r.reopenedAt),
      newDiscoverableCount:
        r.newDiscoverableCount === null ? null : count(r.newDiscoverableCount),
    };
  });
  if (new Set(reopened.map((r) => r.ticId)).size !== reopened.length)
    return fail();
  return {
    asOf: stamp(v.asOf),
    tutorial: { completedCount, items },
    challenge: {
      round,
      eligible,
      unlocked,
      ticId,
      participantCount,
      progressStage: c.progressStage as Quests["challenge"]["progressStage"],
    },
    reopened,
  };
}
export function readCurrentChallenge(value: unknown): CurrentChallenge {
  const v = obj(value),
    eligible = bool(v.eligible);
  if (v.round === null) {
    if (eligible) return fail();
    return { round: null, eligible: false, participantCount: null };
  }
  const r = obj(v.round),
    status = r.status;
  if (!["planned", "active", "closed"].includes(status as string))
    return fail();
  const ticId = r.ticId === null ? null : tic(r.ticId);
  if (
    (!eligible && ticId !== null) ||
    (eligible && (status !== "active" || ticId === null))
  )
    return fail();
  return {
    round: { ...readRound(r), status: status as "active", ticId },
    eligible,
    participantCount: count(v.participantCount),
  };
}
export function tutorialMarkers(
  quests: Quests,
  retired: Set<string>,
): TutorialMarkers {
  const markers = readTutorialMarkers(quests);
  for (const [id, item] of markers) {
    if (item.completed) retired.add(id);
    if (retired.has(id)) item.visible = false;
  }
  return markers;
}
export const challengeSeenKey = (memberId: string) =>
  `planetory.challenge.last-shown:${encodeURIComponent(memberId)}`;
export function needsChallengeNotice(
  storage: Pick<Storage, "getItem">,
  memberId: string,
  current: CurrentChallenge,
): boolean {
  if (!current.eligible || current.round?.status !== "active") return false;
  try {
    return (
      storage.getItem(challengeSeenKey(memberId)) !== current.round.roundId
    );
  } catch {
    return true;
  }
}
export function recordChallengeShown(
  storage: Pick<Storage, "setItem">,
  memberId: string,
  roundId: string,
) {
  try {
    storage.setItem(challengeSeenKey(memberId), roundId);
  } catch {
    /* Browser storage never controls discovery or access. */
  }
}

// The panel and map markers must agree, including the normal no-round state.
export function currentChallengeMismatch(
  current: CurrentChallenge | undefined,
  challenge: Quests["challenge"] | undefined,
): boolean {
  return !!(
    current &&
    challenge &&
    ((current.round?.roundId ?? null) !== (challenge.round?.roundId ?? null) ||
      (!!current.round && current.round.status !== "active") ||
      current.eligible !== challenge.eligible)
  );
}
