#!/bin/sh
# Just the directory install check, in a fresh headless browser. Usage: dev/e2e/e2e-directory.sh [--no-build]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/.dev/e2e-directory-$(date +%s)
BUILD=; [ "$1" = "--no-build" ] && BUILD=--no-build
AR_DEV_DIR=$DIR AR_CDP_PORT=9339 AR_SITE_PORT=8773 AR_TMUX_PREFIX=pd "$ROOT/dev/env/up.sh" --headless --no-claude $BUILD >/dev/null
AR_CDP_PORT=9339 DEV_DIR=$DIR AGENTIC_ROUTINES_HOME=$DIR/store node "$ROOT/dev/e2e/e2e-directory.mjs" "$@" || code=$?
AR_TMUX_PREFIX=pd AR_CDP_PORT=9339 "$ROOT/dev/env/down.sh"
exit ${code:-0}
