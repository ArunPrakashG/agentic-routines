#!/bin/sh
# Just the hooks check, in a fresh headless browser. Usage: dev/e2e-hooks.sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/.dev/e2e-hooks-$(date +%s)
export AR_TLS_HOST=hooks.acme.test AR_TLS_PORT=${AR_TLS_PORT:-8443}
AR_DEV_DIR=$DIR "$ROOT/dev/up.sh" --headless --no-claude >/dev/null
DEV_DIR=$DIR AGENTIC_ROUTINES_HOME=$DIR/store node "$ROOT/dev/e2e-hooks.mjs" "$@" || code=$?
"$ROOT/dev/down.sh"
exit ${code:-0}
