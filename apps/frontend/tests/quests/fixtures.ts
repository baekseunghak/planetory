import type {
  Quests,
  CurrentChallenge,
} from "../../src/features/quests/contracts";
export const round = {
  roundId: "cr-208",
  roundNo: 2,
  startsOn: "2026-09-14",
  endsOn: "2026-09-21",
  description: "얕은 밝기 변화 속 신호를 찾아보세요",
};
export function quests(completed = 0, skipped = false): Quests {
  return {
    asOf: "2026-09-17T07:00:00Z",
    tutorial: {
      completedCount: completed,
      items: Array.from({ length: 5 }, (_, i) => ({
        seq: i + 1,
        intent: (
          [
            "deep_confirmed",
            "shallow_confirmed",
            "fp",
            "deep_fp",
            "multi_fp",
          ] as const
        )[i],
        ticId: i <= completed ? String(900000001 + i) : null,
        status:
          i < completed ? "completed" : i === completed ? "unlocked" : "locked",
        completionReason:
          i < completed
            ? skipped && i === completed - 1
              ? "skipped"
              : "all_found"
            : null,
      })),
    },
    challenge: {
      round,
      eligible: completed === 5,
      ticId: completed === 5 ? "900000006" : null,
      unlocked: completed === 5,
      progressStage: completed === 5 ? "unexplored" : null,
      participantCount: 12,
    },
    reopened: [],
  };
}
export function current(eligible = true): CurrentChallenge {
  return {
    round: { ...round, status: "active", ticId: eligible ? "900000006" : null },
    eligible,
    participantCount: 12,
  };
}
