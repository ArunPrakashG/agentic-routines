#!/usr/bin/env bash
# Build the site here and ship it to the server as a new release.
#
#   apps/site/deploy/deploy.sh     build the working tree's site and deploy it
#
# Each release lands in site/www/releases/<tag> in the deploy folder and goes live when the "current"
# symlink moves to it. The three newest releases are kept; to roll back, point "current" at an older one.
# Then the edge cache for the host is purged, so pages are not served stale. First-time setup is in
# ../../api/README.md.
set -euo pipefail

# Where to deploy is not in the repo: DEPLOY_HOST (an SSH name) and DEPLOY_DIR (relative to its home).
. "${XDG_CONFIG_HOME:-$HOME/.config}/agentic-routines/deploy.env"
HOST=${DEPLOY_HOST:?set DEPLOY_HOST in deploy.env}
APP=${DEPLOY_DIR:?set DEPLOY_DIR in deploy.env}
DIR=$APP/site
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

TAG=$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain -- .)" ]; then
  TAG="$TAG-dirty"
fi

pnpm build
chmod -R a+rX dist

IMAGE=agenticroutines-site:2.11.4
if ! ssh "$HOST" "docker image inspect $IMAGE >/dev/null 2>&1"; then
  echo "Shipping the $IMAGE image"
  docker build -q -t "$IMAGE" deploy
  docker save "$IMAGE" | gzip -1 | ssh "$HOST" 'gunzip | docker load'
fi

echo "Shipping release $TAG to $HOST"
ssh "$HOST" "mkdir -p $DIR/www/releases/$TAG $DIR/conf"
tar -C dist -czf - . | ssh "$HOST" "tar -xzf - -C $DIR/www/releases/$TAG"
scp -q deploy/Caddyfile "$HOST:$DIR/conf/Caddyfile.new"
scp -q ../api/deploy/docker-compose.yml "$HOST:$APP/docker-compose.yml"

ssh "$HOST" "set -e; cd $DIR && \
  ln -sfn releases/$TAG www/current.new && mv -T www/current.new www/current && \
  if cmp -s conf/Caddyfile.new conf/Caddyfile; then rm conf/Caddyfile.new; changed=; else mv conf/Caddyfile.new conf/Caddyfile; changed=1; fi && \
  cd ~/$APP && docker compose up -d agenticroutines-site && \
  if [ -n \"\$changed\" ]; then docker restart agenticroutines-site >/dev/null; fi && \
  cd ~/$DIR/www/releases && command ls -1 | sort -r | tail -n +4 | xargs -r rm -rf"

# Only the pages change between releases (built files have new names), but purging the host is cheap.
if command -v cf >/dev/null; then
  CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-} cf cache purge --zone arunprakashg.com --force --body '{"hosts":["agenticroutines.arunprakashg.com"]}' >/dev/null 2>&1 \
    && echo "edge cache purged" || echo "could not purge the edge cache; pages refresh within five minutes"
fi

curl -fsS -o /dev/null "https://agenticroutines.arunprakashg.com/" && echo "live: $TAG"
