// The loops behind Check, Import and Undo: retries for a dropped connection, a smaller chunk after a timeout, and a
// fresh-code request when the database answers "step_up". Pure orchestration over the server actions (no React here).
import type { ImportResult } from "@/app/(app)/leads/import/actions";
import type { ImportErrorCode } from "@/lib/import-server";

export class ImportStopped extends Error {
  constructor(public readonly code: ImportErrorCode | "cancelled") {
    super(code);
  }
}

export type Runner = {
  // Ask for a fresh code (the "Confirm it's you" dialog); false when the person cancels.
  requireFresh: () => Promise<boolean>;
  signal?: AbortSignal;
};

const retryDelays = [500, 1000, 2000];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs one server action: up to 3 retries after a failed network call or "unavailable", one fresh-code request on
// "step_up", then gives up with the code. Server actions throw when the network drops.
export async function attempt<T>(runner: Runner, call: () => Promise<ImportResult<T>>): Promise<T> {
  let retries = 0;
  let askedForCode = false;
  for (;;) {
    if (runner.signal?.aborted) throw new ImportStopped("cancelled");
    let result: ImportResult<T>;
    try {
      result = await call();
    } catch {
      result = { ok: false, error: "unavailable" };
    }
    if (result.ok) return result.data;
    if (result.error === "step_up" && !askedForCode) {
      askedForCode = true;
      if (!(await runner.requireFresh())) throw new ImportStopped("cancelled");
      continue;
    }
    if (result.error === "unavailable" && retries < retryDelays.length) {
      await wait(retryDelays[retries++]);
      continue;
    }
    throw new ImportStopped(result.error);
  }
}
