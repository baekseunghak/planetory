// Only this app's analysis drafts; never clear unrelated sessionStorage entries.
const PREFIX = "planetory:analysis-draft:";
let generation = 0;
export const draftStorageGeneration = () => generation;
export const sessionDraftKey = (memberId: string, ticId: string) =>
  `${PREFIX}${JSON.stringify([memberId, ticId])}`;
export function clearSessionDrafts() {
  generation++;
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch {
    /* Disabled storage must not block logout or session expiry. */
  }
}
export function activateDraftOwner(memberId: string) {
  try {
    const key = `${PREFIX}owner`;
    if (sessionStorage.getItem(key) !== memberId) clearSessionDrafts();
    sessionStorage.setItem(key, memberId);
  } catch {
    /* The editor reports unavailable storage when saving. */
  }
}
