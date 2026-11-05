#!/bin/sh
# Starts the local test environment in tmux. Nothing outside the state folder is
# touched: the browser, the routine store and the agent config all live there.
#   dev/up.sh [--headless] [--no-claude] [--no-build]
# BR_DEV_DIR moves the state folder, BR_CHROME picks the browser, BR_MODEL the agent's model.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV=${BR_DEV_DIR:-$ROOT/.dev}
HEADLESS=; CLAUDE=1; BUILD=1
for a in "$@"; do
  case "$a" in
    --headless) HEADLESS=--headless=new ;;
    --no-claude) CLAUDE= ;;
    --no-build) BUILD= ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

# Branded Chrome ignores --load-extension, so this needs Chromium.
CHROME=${BR_CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)}
[ -x "$CHROME" ] || { echo "No Chromium found. Run: npx playwright install chromium" >&2; exit 1; }
NODE=$(command -v node)
CLI=$ROOT/packages/cli/dist/index.js
EXT=$ROOT/packages/extension/.output/chrome-mv3

if [ -n "$BUILD" ]; then
  (cd "$ROOT" && pnpm -r build >/dev/null)
fi
[ -f "$CLI" ] && [ -d "$EXT" ] || { echo "Nothing built. Run without --no-build." >&2; exit 1; }

"$(dirname "$0")/down.sh"

STORE=$DEV/store
# A reused profile keeps the old background script after a rebuild, so each build gets its own.
BHOME=$DEV/home-$(sha256sum "$EXT/background.js" | cut -c1-8)
PROFILE=$BHOME/.config/chromium
mkdir -p "$PROFILE" "$STORE" "$DEV/workspace"
cp "$ROOT"/dev/fixtures/* "$DEV/workspace/"

# Real setup against the throwaway home, with no agent on PATH to edit.
env HOME="$BHOME" BROWSER_ROUTINES_HOME="$STORE" PATH="$(dirname "$NODE"):/usr/bin:/bin" "$NODE" "$CLI" setup >/dev/null

touch "$DEV/.started"
tmux new-session -d -s br-site "python3 -m http.server 8765 --bind 127.0.0.1 --directory '$ROOT/dev/site'"
tmux new-session -d -s br-chrome "env HOME='$BHOME' BROWSER_ROUTINES_HOME='$STORE' DISPLAY='$DISPLAY' WAYLAND_DISPLAY='$WAYLAND_DISPLAY' XDG_RUNTIME_DIR='$XDG_RUNTIME_DIR' PATH='$(dirname "$NODE"):/usr/bin:/bin' '$CHROME' $HEADLESS --user-data-dir='$PROFILE' --load-extension='$EXT' --disable-extensions-except='$EXT' --remote-debugging-port=9333 --password-store=basic --no-first-run --no-default-browser-check --window-size=1280,900 http://127.0.0.1:8765/ > '$DEV/chrome.log' 2>&1"

i=0; until curl -s localhost:9333/json/version >/dev/null || [ $i -gt 100 ]; do i=$((i+1)); sleep 0.2; done
# Only a host from this browser counts: a crash leaves the old one's file behind.
host_up() { [ -n "$(find "$STORE/hosts" -name '*.json' -newer "$DEV/.started" 2>/dev/null)" ]; }
i=0; until host_up || [ $i -gt 300 ]; do i=$((i+1)); sleep 0.2; done
host_up || { echo "Native host did not start. See $DEV/chrome.log and $STORE/host.log" >&2; exit 1; }

if [ -n "$CLAUDE" ]; then
  cat > "$DEV/mcp.json" <<JSON
{ "mcpServers": { "browser-routines": { "type": "stdio", "command": "$NODE", "args": ["$CLI", "mcp"], "env": { "BROWSER_ROUTINES_HOME": "$STORE" } } } }
JSON
  # Your own login, but only this server and none of your user settings or hooks.
  # Default permissions, because auto mode opens a dialog that edits your real settings.
  tmux new-session -d -s br-claude -c "$DEV/workspace" -x 120 -y 40 "'$(command -v claude)' --mcp-config '$DEV/mcp.json' --strict-mcp-config --setting-sources project,local --permission-mode default --allowedTools mcp__browser-routines --model '${BR_MODEL:-sonnet}'"
fi

echo "Site     http://127.0.0.1:8765/ (tmux: br-site)"
echo "Browser  CDP on 9333 (tmux: br-chrome)"
[ -n "$CLAUDE" ] && echo "Agent    tmux attach -t br-claude"
echo "State    $DEV"
