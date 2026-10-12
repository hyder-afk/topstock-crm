#!/usr/bin/env python3
"""Local only: proves the client-link checks in the app catch each protection being removed (Day 6 design section
11.3, rows 48 to 52). Each row edits one source file in place, runs the check that must fail (a unit spec, or one e2e
test on the shared local stack), and restores the file. Never run it in a checkout someone else is reading.
Usage: python3 scripts/app-mutations.py [--e2e] [numbers...]   (--e2e also runs the rows checked by Playwright on the
local auth stack, which must already serve this checkout with a fresh build: those rows rebuild the app.)
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
UNIT = ["npx", "playwright", "test", "-c", "playwright.unit.config.ts"]

MUTATIONS = [
    ("The proxy's share branch reads the session (it runs after the Supabase block) [design 48]",
     "src/proxy.ts", "  if (matches(path, sharePaths)) {", "  if (false && matches(path, sharePaths)) {",
     UNIT + ["tests/unit/proxy-share.spec.ts"]),
    ("The share CSP keeps the Supabase origin [design 49]",
     "src/proxy.ts", "    `connect-src 'self'${isDev ? \" ws:\" : \"\"}`,\n    \"form-action 'self'\",",
     "    `connect-src 'self' ${supabaseUrl ? new URL(supabaseUrl).origin : \"\"}${isDev ? \" ws:\" : \"\"}`,\n    \"form-action 'self'\",",
     UNIT + ["tests/unit/proxy-share.spec.ts"]),
    ("The view answer is passed on without the output schema [design 50]",
     "src/lib/share/map.ts", "  const items = mapShareItems(r.items);\n  if (!items) return { status: \"unavailable\" };\n  const parsed",
     "  return r as ShareViewAnswer;\n  const items = mapShareItems(r.items);\n  if (!items) return { status: \"unavailable\" };\n  const parsed",
     UNIT + ["tests/unit/share.spec.ts"]),
    ("The honeypot and the time trap call the database [design 51]",
     "src/app/api/share/request/route.ts", "  if (parsed.data.website !== \"\" || parsed.data.t < 2000) {",
     "  if (false) {",
     "e2e"),
    ("The proxy keeps incoming surface headers [design 52]",
     "src/proxy.ts", "  requestHeaders.delete(\"x-topstock-surface\");\n  requestHeaders.delete(\"x-topstock-locale\");\n", "",
     UNIT + ["tests/unit/proxy-share.spec.ts"]),
]

E2E = ["bash", "-c", "set -a; . /tmp/topstock-auth/env; set +a; export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium "
       "NEXT_TELEMETRY_DISABLED=1; npm run build >/dev/null 2>&1 && npx playwright test -c playwright.auth.config.ts "
       "--project=chromium tests/auth/share.spec.ts --grep 'enable_sharing|shows_once|request_creates|route_guards'"]


def main() -> int:
    args = sys.argv[1:]
    e2e = "--e2e" in args
    only = {int(a) for a in args if a.isdigit()}
    print("| # | Protection removed | Result |\n|---|---|---|")
    bad = 0
    for i, (title, rel, old, new, check) in enumerate(MUTATIONS, 48):
        if only and i not in only:
            continue
        if check == "e2e" and not e2e:
            print(f"| {i} | {title} | not run here (e2e: share_public_route_guards) |")
            continue
        path = ROOT / rel
        text = path.read_text()
        if text.count(old) != 1:
            print(f"| {i} | {title} | NOT APPLIED (pattern found {text.count(old)} times) |")
            bad += 1
            continue
        try:
            path.write_text(text.replace(old, new))
            run = subprocess.run(E2E if check == "e2e" else check, cwd=ROOT, capture_output=True, text=True)
        finally:
            path.write_text(text)
        caught = run.returncode != 0
        bad += 0 if caught else 1
        print(f"| {i} | {title} | {'caught' if caught else '**NOT CAUGHT**'} |", flush=True)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
