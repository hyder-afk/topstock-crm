// A remembered column matching per header row: a per-person convenience in this browser, never lead data. It is
// stored under a hash of the header row (LoadedFile.headerKey, worked out when the file is read), so no header text
// reaches storage (a file with no header row has a lead as its first line). Every access is in try/catch: storage
// can be blocked or full.
import { TARGETS, type Target } from "@/lib/import";

const prefix = "topstock.import.mapping.";
const hashed = /^[0-9a-f]{64}$/;

export function readMapping(headerKey: string, length: number): Target[] | null {
  try {
    const raw = window.localStorage.getItem(prefix + headerKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length === length && parsed.every((x) => (TARGETS as readonly string[]).includes(x))) {
      return parsed as Target[];
    }
  } catch {
    // Storage blocked: start from the suggestions.
  }
  return null;
}

export function saveMapping(headerKey: string, mapping: readonly Target[]) {
  try {
    // Matchings saved by an earlier version under the header text itself are removed.
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(prefix) && !hashed.test(key.slice(prefix.length))) window.localStorage.removeItem(key);
    }
    window.localStorage.setItem(prefix + headerKey, JSON.stringify(mapping));
  } catch {
    // Storage blocked: nothing to remember.
  }
}
