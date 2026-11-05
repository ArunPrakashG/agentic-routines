#!/bin/sh
# The scripted check: a fresh headless browser and store, driven by a plain MCP client.
# It replaces a running dev environment. Usage: dev/e2e.sh [--shots] [--dark]
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/.dev/e2e-$(date +%s)
BR_DEV_DIR=$DIR "$ROOT/dev/up.sh" --headless --no-claude >/dev/null
DEV_DIR=$DIR BROWSER_ROUTINES_HOME=$DIR/store node "$ROOT/dev/e2e.mjs" "$@" || code=$?
"$ROOT/dev/down.sh"
exit ${code:-0}
