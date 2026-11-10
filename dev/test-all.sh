#!/bin/sh
# The whole local test bench, one command, nothing outside the repository and throwaway containers touched:
# typecheck, builds, the API (vet, build, then the real binary against a throwaway Postgres and Redis), the site
# (build and links), the store checks on the extension, and every browser e2e: the real extension in Chromium,
# the side panel, hooks, profiles, background tabs, sources and the agent setup (dev/e2e/e2e.sh runs them all).
# Usage: dev/test-all.sh [--skip-e2e]
# Each step logs to .dev/test-all/<step>.log and the summary at the end lists what passed.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
LOGS=$ROOT/.dev/test-all
rm -rf "$LOGS"
mkdir -p "$LOGS"
FAILED=
SUMMARY=
step() {
  name=$1
  shift
  start=$(date +%s)
  if "$@" >"$LOGS/$name.log" 2>&1; then
    SUMMARY="$SUMMARY\n  ok    $name ($(($(date +%s) - start))s)"
  else
    SUMMARY="$SUMMARY\n  FAIL  $name ($(($(date +%s) - start))s)  .dev/test-all/$name.log"
    FAILED=1
  fi
  printf '%s done\n' "$name"
}
api() { (cd apps/api && test -z "$(gofmt -l .)" && go vet ./... && go build ./...); }
site() { pnpm --filter @agentic-routines/site build && node dev/check-links.mjs; }
store() {
  rm -rf .dev/test-all/store && mkdir -p .dev/test-all/store
  AR_STORE=1 AR_OUT=$ROOT/.dev/test-all/store pnpm -C packages/extension exec wxt zip &&
    AR_STORE=1 AR_OUT=$ROOT/.dev/test-all/store pnpm -C packages/extension exec wxt zip -b firefox --mv3 &&
    node releases/scripts/check-store.mjs .dev/test-all/store
}

step typecheck pnpm typecheck
step build pnpm build
step api-static api
step api-e2e node dev/e2e/e2e-api.mjs
step site site
step store-checks store
step sources node dev/e2e/e2e-sources.mjs
step project node dev/e2e/e2e-project.mjs
step agents node dev/e2e/e2e-agents.mjs
if [ "$1" != "--skip-e2e" ]; then
  step browser-e2e dev/e2e/e2e.sh
fi

printf '\nResults:%b\n' "$SUMMARY"
[ -z "$FAILED" ] || { echo "Some steps failed."; exit 1; }
echo "All steps passed."
