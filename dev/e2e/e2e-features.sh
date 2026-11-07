#!/bin/sh
# What a routine does for itself over many runs: tidying, nudges, the meter, background runs, loops. Usage: dev/e2e/e2e-features.sh [--no-build]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/.dev/e2e-features-$(date +%s)
BUILD=; [ "$1" = "--no-build" ] && BUILD=--no-build
AR_DEV_DIR=$DIR AR_CDP_PORT=9338 AR_SITE_PORT=8772 AR_TMUX_PREFIX=pf "$ROOT/dev/env/up.sh" --headless --no-claude $BUILD >/dev/null
AGENTIC_ROUTINES_HOME=$DIR/store DEV_DIR=$DIR node "$ROOT/dev/e2e/e2e-features.mjs" || code=$?
AR_TMUX_PREFIX=pf AR_CDP_PORT=9338 "$ROOT/dev/env/down.sh"
exit ${code:-0}
