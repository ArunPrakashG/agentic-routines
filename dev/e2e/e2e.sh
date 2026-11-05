#!/bin/sh
# The scripted check: fresh headless browsers and stores, driven by a plain MCP client,
# then by input events in the real side panel.
# It replaces a running dev environment. Usage: dev/e2e/e2e.sh [--shots] [--dark]
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/.dev/e2e-$(date +%s)
AR_DEV_DIR=$DIR "$ROOT/dev/env/up.sh" --headless --no-claude >/dev/null
DEV_DIR=$DIR AGENTIC_ROUTINES_HOME=$DIR/store node "$ROOT/dev/e2e/e2e.mjs" "$@" || code=$?
"$ROOT/dev/env/down.sh"
# What a person does gets its own fresh browser, as the panel opens differently here.
AR_DEV_DIR=$DIR/panel "$ROOT/dev/env/up.sh" --headless --no-claude --no-build >/dev/null
node "$ROOT/dev/e2e/e2e-panel.mjs" || code=$?
"$ROOT/dev/env/down.sh"
# Hooks and instructions from a Git source, through the side panel, in a fresh browser again.
AR_TLS_HOST=hooks.acme.test AR_TLS_PORT=${AR_TLS_PORT:-8443} AR_DEV_DIR=$DIR/hooks "$ROOT/dev/env/up.sh" --headless --no-claude --no-build >/dev/null
DEV_DIR=$DIR/hooks AGENTIC_ROUTINES_HOME=$DIR/hooks/store node "$ROOT/dev/e2e/e2e-hooks.mjs" || code=$?
"$ROOT/dev/env/down.sh"
# Installing from Git sources and config.routine: the built CLI against a stand-in for GitHub, no browser.
node "$ROOT/dev/e2e/e2e-sources.mjs" || code=$?
exit ${code:-0}
