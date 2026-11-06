#!/bin/sh
# An agent's tab that is not in front (the person switched to another tab) still takes clicks, typing and pictures.
# Usage: dev/e2e/e2e-background.sh [--no-build]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/.dev/e2e-background-$(date +%s)
BUILD=; [ "$1" = "--no-build" ] && BUILD=--no-build
AR_DEV_DIR=$DIR AR_CDP_PORT=9335 AR_SITE_PORT=8767 AR_TMUX_PREFIX=pg "$ROOT/dev/env/up.sh" --headless --no-claude $BUILD >/dev/null
AGENTIC_ROUTINES_HOME=$DIR/store DEV_DIR=$DIR node "$ROOT/dev/e2e/e2e-background.mjs" || code=$?
AR_TMUX_PREFIX=pg AR_CDP_PORT=9335 "$ROOT/dev/env/down.sh"
exit ${code:-0}
