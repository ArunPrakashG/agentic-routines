#!/bin/sh
# Stops everything dev/up.sh started. State stays, so routines survive a restart.
for s in br-claude br-chrome br-site; do tmux kill-session -t "$s" 2>/dev/null; done
pkill -f "remote-debugging-port=9333" 2>/dev/null
i=0; while curl -s localhost:9333/json/version >/dev/null && [ $i -lt 50 ]; do i=$((i+1)); sleep 0.2; done
exit 0
