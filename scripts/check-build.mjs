#!/usr/bin/env node
// Gate 1 production build scan (Master Plan section 8 items 1, 14 and 36), Day 7d. Run after `next build`:
//   node scripts/check-build.mjs [.next]
// Fails when the browser bundle (.next/static) holds:
//   - a source map (*.map) or a sourceMappingURL comment (item 36: no original code in production);
//   - the word service_role, an sb_secret_ key (the prefix followed by key characters; supabase-js itself carries the
//     bare prefix as a string to tell key kinds apart), or a postgres:// / postgresql:// connection string (item 1);
//   - a JWT whose payload names any role other than anon (item 14: only the public anon key may ship); a JWT that
//     cannot be read also fails.
// It prints counts and file names only, never a matched value.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] ?? ".next";
const staticDir = join(root, "static");
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
};
try {
  walk(staticDir);
} catch {
  console.error(`check-build: ${staticDir} not found (run next build first)`);
  process.exit(2);
}

const problems = [];
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;
let scanned = 0;
let anonKeys = 0;
for (const file of files) {
  const name = relative(root, file);
  if (file.endsWith(".map")) {
    problems.push(`${name}: source map`);
    continue;
  }
  if (!/\.(js|mjs|cjs|css|html|json|txt)$/.test(file)) continue;
  scanned++;
  const text = readFileSync(file, "utf8");
  if (/sourceMappingURL=/.test(text)) problems.push(`${name}: sourceMappingURL comment`);
  if (/service_role/.test(text)) problems.push(`${name}: the word service_role`);
  if (/sb_secret_[A-Za-z0-9_-]{16,}/.test(text)) problems.push(`${name}: an sb_secret_ key`);
  if (/postgres(?:ql)?:\/\//.test(text)) problems.push(`${name}: a postgres connection string`);
  for (const m of text.matchAll(JWT)) {
    let role = null;
    try {
      role = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")).role ?? null;
    } catch {
      role = "(unreadable)";
    }
    if (role === "anon") anonKeys++;
    else problems.push(`${name}: a JWT with role ${role}`);
  }
}

console.log(`check-build: ${files.length} files under ${relative(".", staticDir) || staticDir}, ${scanned} text files scanned, ${anonKeys} anon-key occurrence(s)`);
if (problems.length) {
  for (const p of problems) console.error(`check-build: ${p}`);
  process.exit(1);
}
console.log("check-build: no source maps, no server keys, no connection strings");
