#!/bin/bash
# Cloud sessions start from a fresh clone: install dependencies once so lint, typecheck and tests run.
set -e
cd "${CLAUDE_PROJECT_DIR:-.}"
if [ -f package-lock.json ] && [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund >/dev/null 2>&1 || echo "npm ci failed; run it manually"
fi
exit 0
