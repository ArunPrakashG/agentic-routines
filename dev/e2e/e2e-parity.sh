#!/bin/sh
# Hand-overs, lent tabs, sessions, settings, secrets, capture, the local CDP endpoint, compiled routines. Usage: dev/e2e/e2e-parity.sh [--no-build]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/.dev/e2e-parity-$(date +%s)
BUILD=; [ "$1" = "--no-build" ] && BUILD=--no-build
AR_DEV_DIR=$DIR AR_CDP_PORT=9339 AR_SITE_PORT=8773 AR_TMUX_PREFIX=pr "$ROOT/dev/env/up.sh" --headless --no-claude $BUILD >/dev/null
AGENTIC_ROUTINES_HOME=$DIR/store DEV_DIR=$DIR node "$ROOT/dev/e2e/e2e-parity.mjs" || code=$?
AR_TMUX_PREFIX=pr AR_CDP_PORT=9339 "$ROOT/dev/env/down.sh"
exit ${code:-0}
