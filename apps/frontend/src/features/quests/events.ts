// A06 calls this only AFTER a successful server response, never on a button click.
// A14 can notify guide closure independently; no completion state is inferred here.
export type QuestChange = {
  reason: "submission" | "tutorial-skipped" | "guide-closed";
};
const listeners = new Map<string, Set<(event: QuestChange) => void>>();
export function publishQuestChange(memberId: string, event: QuestChange) {
  listeners.get(memberId)?.forEach((listener) => listener(event));
}
export function subscribeQuestChange(
  memberId: string,
  listener: (event: QuestChange) => void,
) {
  const group = listeners.get(memberId) ?? new Set();
  group.add(listener);
  listeners.set(memberId, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(memberId);
  };
}
