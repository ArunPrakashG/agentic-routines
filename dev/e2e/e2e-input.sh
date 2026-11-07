#!/bin/sh
# The browser tools on pages that only believe real input, and replays of them. Usage: dev/e2e/e2e-input.sh [--no-build]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/.dev/e2e-input-$(date +%s)
BUILD=; [ "$1" = "--no-build" ] && BUILD=--no-build
AR_DEV_DIR=$DIR AR_CDP_PORT=9336 AR_SITE_PORT=8768 AR_TMUX_PREFIX=pi "$ROOT/dev/env/up.sh" --headless --no-claude $BUILD >/dev/null
AGENTIC_ROUTINES_HOME=$DIR/store DEV_DIR=$DIR node "$ROOT/dev/e2e/e2e-input.mjs" || code=$?
AR_TMUX_PREFIX=pi AR_CDP_PORT=9336 "$ROOT/dev/env/down.sh"
exit ${code:-0}
