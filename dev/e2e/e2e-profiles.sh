#!/bin/sh
# Two browser profiles at once, as one person with a work and a personal Chrome profile has: two browsers with the
# extension, each with its own host, sharing one routine store. Driven by plain MCP clients.
# Usage: dev/e2e/e2e-profiles.sh [--no-build]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/.dev/e2e-profiles-$(date +%s)
STORE=$DIR/store
BUILD=; [ "$1" = "--no-build" ] && BUILD=--no-build
mkdir -p "$STORE"
AR_SHARED_STORE=$STORE AR_DEV_DIR=$DIR/a AR_CDP_PORT=9333 AR_SITE_PORT=8765 AR_TMUX_PREFIX=pa "$ROOT/dev/env/up.sh" --headless --no-claude $BUILD >/dev/null
AR_SHARED_STORE=$STORE AR_DEV_DIR=$DIR/b AR_CDP_PORT=9334 AR_SITE_PORT=8766 AR_TMUX_PREFIX=pb "$ROOT/dev/env/up.sh" --headless --no-claude --no-build >/dev/null
AGENTIC_ROUTINES_HOME=$STORE DEV_DIR=$DIR node "$ROOT/dev/e2e/e2e-profiles.mjs" || code=$?
AR_TMUX_PREFIX=pa AR_CDP_PORT=9333 "$ROOT/dev/env/down.sh"
AR_TMUX_PREFIX=pb AR_CDP_PORT=9334 "$ROOT/dev/env/down.sh"
exit ${code:-0}
