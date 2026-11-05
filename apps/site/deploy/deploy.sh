#!/usr/bin/env bash
# Build the site here and ship it to ovh-arun as a new release.
#
#   apps/site/deploy/deploy.sh     build the working tree's site and deploy it
#
# Each release lands in ~/infra/apps/agenticroutines/site/www/releases/<tag> and goes live when the "current"
# symlink moves to it. The three newest releases are kept; to roll back, point "current" at an older one.
# Then the edge cache for the host is purged, so pages are not served stale. First-time setup is in
# ../../api/README.md.
set -euo pipefail

HOST=${HOST:-ovh-arun}
APP=infra/apps/agenticroutines
DIR=$APP/site
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

TAG=$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain -- .)" ]; then
  TAG="$TAG-dirty"
fi

pnpm build
chmod -R a+rX dist

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
  CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-cbbf132b853042edad6f8b315e5690a1} cf cache purge --zone arunprakashg.com --force --body '{"hosts":["agenticroutines.arunprakashg.com"]}' >/dev/null 2>&1 \
    && echo "edge cache purged" || echo "could not purge the edge cache; pages refresh within five minutes"
fi

curl -fsS -o /dev/null "https://agenticroutines.arunprakashg.com/" && echo "live: $TAG"
