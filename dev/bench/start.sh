#!/bin/sh
# Starts the bench browser and site. Then run dev/bench/run.mjs. Stop with dev/down.sh and tmux kill-session -t br-bench-site.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
B=$ROOT/.dev/bench
mkdir -p "$B"
AR_DEV_DIR=$B/env "$ROOT/dev/up.sh" --headless --no-claude --no-build >/dev/null
tmux kill-session -t br-bench-site 2>/dev/null || true
tmux new-session -d -s br-bench-site "'$(command -v node)' '$ROOT/dev/bench/server.mjs'"
sleep 1
curl -s -o /dev/null -w 'site %{http_code}\n' http://127.0.0.1:8766/console/
