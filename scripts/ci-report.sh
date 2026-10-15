#!/bin/bash
# CI only: runs a test command, shows its output as usual, and on failure also posts the last lines as an error
# annotation (annotations are readable through the GitHub API; job logs need a download). Usage: ci-report.sh TITLE CMD...
set -uo pipefail
title="$1"; shift
out="$(mktemp)"
"$@" 2>&1 | tee "$out"
code=${PIPESTATUS[0]}
if [ "$code" -ne 0 ]; then
  echo "::error title=${title//[:,]/ }::$(tail -c 900 "$out" | tr '\n' ' ' | sed 's/%/%25/g')"
fi
rm -f "$out"
exit "$code"
