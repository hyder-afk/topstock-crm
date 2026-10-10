// Checks, imports and undos still running in this tab. Leaving the import page within the app does not stop them
// (they keep going while the tab is open), so when the page is opened again its Past imports can say so instead of
// offering "Resume" on an import that is in fact still running here. Module state: one tab, one list.
import { useSyncExternalStore } from "react";

let running: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(next: Set<string>) {
  running = next;
  for (const listener of listeners) listener();
}

export function startRun(batchId: string) {
  emit(new Set(running).add(batchId));
}

export function endRun(batchId: string) {
  const next = new Set(running);
  next.delete(batchId);
  emit(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const none: ReadonlySet<string> = new Set();

/** The ids of the imports with a loop running in this tab (none while the page is rendered on the server). */
export function useActiveRuns(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => running,
    () => none,
  );
}

/**
 * Calls `announce` only when the work crosses another tenth (and at the start), so a screen reader hears about ten
 * updates for a long import instead of one per chunk.
 */
export function progressAnnouncer(announce: (text: string) => void) {
  let last = -1;
  return (done: number, total: number, text: string) => {
    const tenth = total > 0 ? Math.min(10, Math.floor((done / total) * 10)) : 0;
    if (tenth === last) return;
    last = tenth;
    announce(text);
  };
}
