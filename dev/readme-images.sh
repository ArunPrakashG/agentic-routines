#!/bin/sh
# Rebuilds the images in docs/images: a real run of the extension against the test site, in a light and a dark
# browser, then the composites. Needs Chromium from Playwright, ffmpeg and ImageMagick. Nothing outside .dev/ is touched.
# AR_CDP_PORT and AR_SITE_PORT move the ports it uses, AR_TMUX_PREFIX the tmux session names.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FRAMES=${AR_FRAMES_DIR:-$ROOT/.dev/readme-frames}
export AR_CDP_PORT=${AR_CDP_PORT:-9555} AR_SITE_PORT=${AR_SITE_PORT:-8771} AR_TMUX_PREFIX=${AR_TMUX_PREFIX:-rdm}
(cd "$ROOT" && pnpm --filter @agentic-routines/site build >/dev/null)
rm -rf "$FRAMES"
BUILD=
for scheme in light dark; do
  DIR=$ROOT/.dev/readme-$scheme
  rm -rf "$DIR"
  AR_DEV_DIR=$DIR "$ROOT/dev/up.sh" --headless --no-claude $BUILD >/dev/null
  BUILD=--no-build
  DEV_DIR=$DIR AGENTIC_ROUTINES_HOME=$DIR/store node "$ROOT/dev/shots.mjs" "$FRAMES/$scheme" "$scheme"
  AR_DEV_DIR=$DIR "$ROOT/dev/down.sh"
done
node "$ROOT/dev/readme-images.mjs" "$FRAMES" "$ROOT/docs/images"
