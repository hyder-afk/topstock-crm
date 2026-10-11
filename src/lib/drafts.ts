// Unsent composer text per lead, kept in this browser (Day 4 design 7.2: "a draft is kept per lead, 50 most recent,
// cleared on save"). A per-viewer convenience: every access is in try/catch (storage can be blocked or full), and the
// sign-in page clears them all, so text does not stay in a shared browser after signing out or a session ending.
export type Draft = { type: string; body: string; subject: string };
const PREFIX = "topstock.draft.";
const INDEX = "topstock.drafts";
export const DRAFTS_KEPT = 50;

export function readDraftRaw(leadId: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(PREFIX + leadId) ?? "null");
  } catch {
    return null;
  }
}

export function writeDraft(leadId: string, draft: Draft | null) {
  try {
    const index = (JSON.parse(window.localStorage.getItem(INDEX) ?? "[]") as unknown[]).filter(
      (id): id is string => typeof id === "string" && id !== leadId,
    );
    if (draft && (draft.body.trim() || draft.subject.trim())) {
      window.localStorage.setItem(PREFIX + leadId, JSON.stringify(draft));
      index.unshift(leadId);
    } else {
      window.localStorage.removeItem(PREFIX + leadId);
    }
    for (const old of index.splice(DRAFTS_KEPT)) window.localStorage.removeItem(PREFIX + old);
    window.localStorage.setItem(INDEX, JSON.stringify(index));
  } catch {
    // Storage blocked or full: the draft lives only while the page is open.
  }
}

/** Removes every draft in this browser (the sign-in page calls it). */
export function clearDrafts() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && (k.startsWith(PREFIX) || k === INDEX)) keys.push(k);
    }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // Nothing to clear when storage is blocked.
  }
}
