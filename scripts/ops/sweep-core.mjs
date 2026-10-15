// The orphan sweeper's rules and its run (Day 7c), without the command-line entry point, so the unit tests
// (tests/unit/sweep-plan.spec.ts) load it with a fake fetch. The entry point, the settings and the safety rules are
// described in scripts/ops/sweep-lead-files.mjs. Node 22 built-ins only; no npm packages.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The path the files guard builds: org/lead/file.ext (same rule as the migration 20261022090000_orphan_sweeper.sql). */
export const PATH_SHAPE = new RegExp(`^${UUID}/${UUID}/${UUID}\\.(pdf|png|jpg|docx|xlsx)$`);
export const BUCKET = "lead-files";
export const BATCH = 100;
const MIB = 1024 * 1024;
const TIMEOUT_MS = 30_000;

export class ConfigError extends Error {}

function intSetting(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,6}$/.test(raw)) throw new ConfigError(`${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be ${min} to ${max}`);
  return n;
}

/** Reads and checks the settings. Never returns or prints the key's value in an error. */
export function readConfig(env) {
  const url = (env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const local = env.SWEEP_ALLOW_LOCAL === "1" && /^http:\/\/(127\.0\.0\.1|localhost):[0-9]{2,5}$/.test(url);
  if (!local && !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) {
    throw new ConfigError("SUPABASE_URL must be https://<project-ref>.supabase.co");
  }
  const key = env.SWEEPER_KEY ?? "";
  if (key.length < 20 || /\s/.test(key)) throw new ConfigError("SWEEPER_KEY is missing or malformed");
  if (key.startsWith("sb_publishable_")) throw new ConfigError("SWEEPER_KEY is a publishable key; it needs the secret key");
  const mode = env.SWEEP_MODE ?? "dry";
  if (mode !== "dry" && mode !== "apply") throw new ConfigError("SWEEP_MODE must be dry or apply");
  return {
    url,
    key,
    apply: mode === "apply",
    maxObjects: intSetting(env, "SWEEP_MAX_OBJECTS", 50, 1, 1000),
    maxBytes: intSetting(env, "SWEEP_MAX_MIB", 200, 1, 1024) * MIB,
    minAgeHours: intSetting(env, "SWEEP_MIN_AGE_HOURS", 24, 24, 8760),
  };
}

/**
 * New secret keys (sb_secret_...) go in apikey only; a legacy service_role JWT also as the bearer token.
 * @param {string} key
 * @returns {Record<string, string>}
 */
export function authHeaders(key) {
  /** @type {Record<string, string>} */
  const h = { apikey: key, "Content-Type": "application/json", Accept: "application/json" };
  if (!key.startsWith("sb_")) h.Authorization = `Bearer ${key}`;
  return h;
}

/**
 * Checks one listing against the rules and the caps. rows: [{name, org_id, size, created_at}] from lead_file_orphans.
 * Returns {ok, reason?, found, bytes, byOrg: {[org]: {count, bytes}}, names: Map(name -> size)}.
 */
export function planSweep(rows, caps) {
  const byOrg = {};
  const names = new Map();
  let bytes = 0;
  if (!Array.isArray(rows)) return { ok: false, reason: "bad_answer", found: 0, bytes: 0, byOrg, names };
  for (const r of rows) {
    const name = r && typeof r.name === "string" ? r.name : "";
    const org = r && typeof r.org_id === "string" ? r.org_id : "";
    const size = r ? r.size : undefined;
    if (!PATH_SHAPE.test(name) || name.split("/")[0] !== org || !Number.isSafeInteger(size) || size < 0 || names.has(name)) {
      return { ok: false, reason: "bad_row", found: rows.length, bytes: 0, byOrg: {}, names: new Map() };
    }
    names.set(name, size);
    bytes += size;
    byOrg[org] ??= { count: 0, bytes: 0 };
    byOrg[org].count += 1;
    byOrg[org].bytes += size;
  }
  const found = names.size;
  if (found > caps.maxObjects) return { ok: false, reason: "too_many", found, bytes, byOrg, names };
  if (bytes > caps.maxBytes) return { ok: false, reason: "too_big", found, bytes, byOrg, names };
  return { ok: true, found, bytes, byOrg, names };
}

/** Names found in both listings (the second taken just before deleting), in the first listing's order. */
export function bothLists(first, second) {
  return [...first.keys()].filter((n) => second.has(n));
}

export function batches(list, size = BATCH) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < MIB) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / MIB).toFixed(1)} MiB`;
}

const REASONS = {
  bad_answer: "the database answer was not a list",
  bad_row: "a listed object is not in the org/lead/file.ext shape or its org id does not match its name",
  too_many: "more objects than the cap",
  too_big: "more bytes than the cap",
};

class StopError extends Error {}

async function call(fetchFn, config, method, path, body) {
  let res;
  try {
    res = await fetchFn(`${config.url}${path}`, {
      method,
      headers: authHeaders(config.key),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StopError(`${method} ${path.split("?")[0]}: no answer`);
  }
  if (!res.ok) {
    // The status and PostgREST's error code only: never the body's text.
    let code = "";
    try {
      const j = await res.json();
      code = j && typeof j.code === "string" ? ` (${j.code.slice(0, 16)})` : "";
    } catch {}
    throw new StopError(`${method} ${path.split("?")[0]}: HTTP ${res.status}${code}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const rpc = (fetchFn, config, fn, args) => call(fetchFn, config, "POST", `/rest/v1/rpc/${fn}`, args);
const listOrphans = (fetchFn, config) =>
  rpc(fetchFn, config, "lead_file_orphans", { p_min_age: `${config.minAgeHours} hours`, p_limit: config.maxObjects + 1 });

/**
 * @typedef {{ exitCode: number, mode: string, found: number, removed: number, bytes: number,
 *   byOrg: Record<string, { count: number, bytes: number }>, deleteCalls: number, stopped?: string }} SweepReport
 */
/**
 * One run. fetchFn: fetch (a fake in the unit tests). log(line), summary(markdown): output sinks.
 * @param {{ config: ReturnType<typeof readConfig>, fetchFn?: typeof fetch, log?: (line: string) => void,
 *   summary?: (markdown: string) => void }} options
 * @returns {Promise<SweepReport>}
 */
export async function runSweep({ config, fetchFn = fetch, log = console.log, summary = () => {} }) {
  const mode = config.apply ? "apply" : "dry run";
  /** @type {SweepReport} */
  const report = { exitCode: 0, mode, found: 0, removed: 0, bytes: 0, byOrg: {}, deleteCalls: 0 };
  const caps = { maxObjects: config.maxObjects, maxBytes: config.maxBytes };
  const lines = [`## sweep-lead-files (${mode})`, ""];
  const stop = (why) => {
    report.exitCode = 1;
    report.stopped = why;
    log(`::error::STOPPED: ${why}`);
    lines.push("", `**Stopped:** ${why}.`);
  };
  try {
    // 1. Sanity counts.
    const stats = (await rpc(fetchFn, config, "lead_file_sweep_stats", {}))?.[0];
    if (!stats || !Number.isSafeInteger(stats.bucket_objects) || !Number.isSafeInteger(stats.file_rows)) {
      throw new StopError("the sanity counts were not readable");
    }
    lines.push(`- Bucket: ${stats.bucket_objects} objects, ${formatBytes(stats.bucket_bytes ?? 0)}; files rows: ${stats.file_rows}`);
    if (stats.odd_names > 0) {
      log(`::warning::${stats.odd_names} objects in ${BUCKET} have a name outside the org/lead/file.ext shape (never swept; tell Claude the count).`);
      lines.push(`- Names outside the shape (never swept): ${stats.odd_names}`);
    }
    if (stats.bucket_objects > 0 && stats.file_rows === 0) {
      stop("the bucket holds objects but the database reports zero files rows (sanity check); nothing was deleted");
      return report;
    }

    // 2. First listing, rules and caps.
    const first = planSweep(await listOrphans(fetchFn, config), caps);
    report.found = first.found;
    report.byOrg = first.byOrg;
    if (!first.ok) {
      stop(`${REASONS[first.reason]} (found ${first.found}${first.found > caps.maxObjects ? "+" : ""}, ${formatBytes(first.bytes)}; caps ${caps.maxObjects} objects, ${formatBytes(caps.maxBytes)}); nothing was deleted`);
      return report;
    }
    lines.push(`- Older than ${config.minAgeHours} hours with no files row: ${first.found} objects, ${formatBytes(first.bytes)}`);
    if (first.found > 0) {
      lines.push("", "| Org id | Objects | Bytes |", "|---|---|---|");
      for (const [org, v] of Object.entries(first.byOrg)) {
        lines.push(`| \`${org}\` | ${v.count} | ${formatBytes(v.bytes)} |`);
        log(`org ${org}: ${v.count} objects, ${formatBytes(v.bytes)}`);
      }
      lines.push("");
    }
    log(`found ${first.found} objects, ${formatBytes(first.bytes)} (${mode})`);

    if (!config.apply || first.found === 0) {
      report.bytes = first.bytes;
      await rpc(fetchFn, config, "record_file_sweep", { p_found: first.found, p_removed: 0, p_bytes: first.bytes, p_dry: true });
      lines.push(config.apply ? "- Nothing to remove." : "- Dry run: nothing removed. Deleting starts only when SWEEP_APPLY is yes (runbook).");
      return report;
    }

    // 3. Second listing just before deleting; only names in both.
    const second = planSweep(await listOrphans(fetchFn, config), caps);
    if (!second.ok) {
      stop(`second listing: ${REASONS[second.reason]}; nothing was deleted`);
      return report;
    }
    const doomed = bothLists(first.names, second.names);
    let removedBytes = 0;
    let removed = 0;
    let failure = "";
    for (const batch of batches(doomed)) {
      report.deleteCalls += 1;
      try {
        const answer = await call(fetchFn, config, "DELETE", `/storage/v1/object/${BUCKET}`, { prefixes: batch });
        const asked = new Set(batch);
        for (const o of Array.isArray(answer) ? answer : []) {
          if (o && asked.has(o.name)) {
            asked.delete(o.name);
            removed += 1;
            removedBytes += first.names.get(o.name) ?? 0;
          }
        }
      } catch (e) {
        failure = e instanceof StopError ? e.message : "delete failed";
        break;
      }
    }
    report.removed = removed;
    report.bytes = removedBytes;
    await rpc(fetchFn, config, "record_file_sweep", { p_found: first.found, p_removed: removed, p_bytes: removedBytes, p_dry: false });
    log(`removed ${removed} of ${doomed.length} objects, ${formatBytes(removedBytes)}`);
    lines.push(`- Removed: ${removed} of ${doomed.length} (found in both listings), ${formatBytes(removedBytes)}`);
    if (failure) {
      stop(`a delete request failed after ${removed} removals: ${failure}`);
    } else if (removed < doomed.length) {
      log(`::warning::${doomed.length - removed} objects were already gone when the delete ran.`);
    }
    return report;
  } catch (e) {
    stop(`${e instanceof StopError ? e.message : "unexpected error"}${report.deleteCalls === 0 ? "; nothing was deleted" : ""}`);
    return report;
  } finally {
    summary(lines.join("\n") + "\n");
  }
}

