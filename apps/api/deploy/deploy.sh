#!/usr/bin/env bash
# Build the image here, ship it to ovh-arun and restart the container there.
#
#   apps/api/deploy/deploy.sh      build HEAD's tree and deploy it
#
# First-time server setup (database, .env, Caddy, DNS, cache rule) is in ../README.md.
set -euo pipefail

HOST=${HOST:-ovh-arun}
DIR=infra/apps/browserroutines
NAME=browserroutines-api
cd "$(dirname "$0")/.."

TAG=$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain -- .)" ]; then
  TAG="$TAG-dirty"
fi

echo "Building $NAME:$TAG"
docker build -t "$NAME:$TAG" .

echo "Shipping it to $HOST"
docker save "$NAME:$TAG" | gzip -1 | ssh "$HOST" 'gunzip | docker load'
scp -q deploy/docker-compose.yml "$HOST:$DIR/docker-compose.yml"

echo "Starting it"
ssh "$HOST" "cd $DIR && \
  (grep -q '^TAG=' .env && sed -i 's/^TAG=.*/TAG=$TAG/' .env || echo 'TAG=$TAG' >> .env) && \
  docker compose up -d && \
  for i in \$(seq 30); do s=\$(docker inspect -f '{{.State.Health.Status}}' $NAME); [ \"\$s\" = healthy ] && break; sleep 2; done; \
  docker compose ps && \
  docker images $NAME --format '{{.Tag}}' | sort -r | tail -n +4 | sed 's/^/$NAME:/' | xargs -r docker rmi -f >/dev/null"
# (keeps the three newest images on the server for a quick rollback: set TAG in .env and `docker compose up -d`)

curl -fsS "https://browserroutines.arunprakashg.com/healthz" && echo " live: $NAME:$TAG"
