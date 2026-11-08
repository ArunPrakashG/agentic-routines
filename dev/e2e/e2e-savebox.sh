#!/bin/sh
# (Headed: a headless browser never shows the box.) A browser set to ask where to save each file: the agent still gets the file. Usage: dev/e2e/e2e-savebox.sh [--no-build]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/.dev/e2e-savebox-$(date +%s)
BUILD=; [ "$1" = "--no-build" ] && BUILD=--no-build
mkdir -p "$DIR"
echo '{"download":{"prompt_for_download":true}}' > "$DIR/prefs.json"
AR_PREFS=$DIR/prefs.json AR_DEV_DIR=$DIR AR_CDP_PORT=9337 AR_SITE_PORT=8769 AR_TMUX_PREFIX=ps "$ROOT/dev/env/up.sh" --no-claude $BUILD >/dev/null
AGENTIC_ROUTINES_HOME=$DIR/store DEV_DIR=$DIR node "$ROOT/dev/e2e/e2e-savebox.mjs" || code=$?
AR_TMUX_PREFIX=ps AR_CDP_PORT=9337 "$ROOT/dev/env/down.sh"
exit ${code:-0}
