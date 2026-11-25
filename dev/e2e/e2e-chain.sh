#!/bin/sh
# Routines one after another: where each starts and ends, and what the agent is told. Usage: dev/e2e/e2e-chain.sh [--no-build]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/.dev/e2e-chain-$(date +%s)
BUILD=; [ "$1" = "--no-build" ] && BUILD=--no-build
AR_DEV_DIR=$DIR AR_CDP_PORT=9339 AR_SITE_PORT=8773 AR_TMUX_PREFIX=pc "$ROOT/dev/env/up.sh" --headless --no-claude $BUILD >/dev/null
AGENTIC_ROUTINES_HOME=$DIR/store DEV_DIR=$DIR AR_SITE_PORT=8773 node "$ROOT/dev/e2e/e2e-chain.mjs" || code=$?
AR_TMUX_PREFIX=pc AR_CDP_PORT=9339 "$ROOT/dev/env/down.sh"
exit ${code:-0}
