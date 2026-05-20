#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

run_package_script() {
  if command -v npm >/dev/null 2>&1; then
    npm run "$1"
  else
    node scripts/run-package-script.mjs "$1"
  fi
}

run_package_script check:repo
run_package_script check:commit-message
run_package_script check:cli
run_package_script check:db
run_package_script check:backend
run_package_script check:backend:e2e
run_package_script check:quick
run_package_script check:build
run_package_script check:deploy
run_package_script check:e2e

echo "verify: ok"
