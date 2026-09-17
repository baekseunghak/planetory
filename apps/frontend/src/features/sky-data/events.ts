type Change = { skyVersion: string; asOf?: string };
const listeners = new Map<string, Set<(event: Change) => void>>();
// Feed an actual successful submission/publication/reopen response here (D-7).
// No retained private data. A freshly mounted sky always obtains fresh metadata.
export function publishSkyChange(memberId: string, change: Change) {
  listeners.get(memberId)?.forEach((listener) => listener(change));
}
export function subscribeSkyChange(
  memberId: string,
  listener: (event: Change) => void,
) {
  const group = listeners.get(memberId) || new Set();
  group.add(listener);
  listeners.set(memberId, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(memberId);
  };
}
