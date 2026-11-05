#!/bin/sh
# The scripted check: fresh headless browsers and stores, driven by a plain MCP client,
# then by input events in the real side panel.
# It replaces a running dev environment. Usage: dev/e2e.sh [--shots] [--dark]
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/.dev/e2e-$(date +%s)
AR_DEV_DIR=$DIR "$ROOT/dev/up.sh" --headless --no-claude >/dev/null
DEV_DIR=$DIR AGENTIC_ROUTINES_HOME=$DIR/store node "$ROOT/dev/e2e.mjs" "$@" || code=$?
"$ROOT/dev/down.sh"
# What a person does gets its own fresh browser, as the panel opens differently here.
AR_DEV_DIR=$DIR/panel "$ROOT/dev/up.sh" --headless --no-claude --no-build >/dev/null
node "$ROOT/dev/e2e-panel.mjs" || code=$?
"$ROOT/dev/down.sh"
# Installing from Git sources and config.routine: the built CLI against a stand-in for GitHub, no browser.
node "$ROOT/dev/e2e-sources.mjs" || code=$?
exit ${code:-0}
