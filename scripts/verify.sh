#!/usr/bin/env bash
# Runs on this machine what the GitHub Actions workflow runs, so changes can be checked without paying for
# hosted CI (the workflow now runs only when started by hand from GitHub).
#
#   scripts/verify.sh            build, server and engine tests, browser journeys
#   scripts/verify.sh --image    also build the production image and check what it ships
#
# Uses this machine's Node and Go. Hosted CI also ran the build and tests on Node 22 / Go 1.23; the
# production image (--image) is the place that toolchain family is still exercised here.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
IMAGE=0
for ARG in "$@"; do case "$ARG" in --image) IMAGE=1 ;; *) echo "Usage: scripts/verify.sh [--image]" >&2; exit 2 ;; esac; done

step() { printf '\n== %s\n' "$1"; }
step "Toolchain: node $(node -v), $(go version | awk '{print $3}')"

step "Build, server tests and engine tests (npm run check)"
npm run check

step "Browser journeys (npm run test:e2e)"
npm run test:e2e

if [ "$IMAGE" = 1 ]; then
  step "Production image: build"
  docker build --tag diplomacy:verify .
  step "Production image: shipped source and browser notices"
  docker run --rm --entrypoint sh diplomacy:verify -c '
    test -f /app/source/engine/go.mod &&
    test -f /app/source/third_party/godip/LICENSE &&
    test -f /app/source/client/src/ui/App.tsx &&
    test -f /app/source/server/fixtures/development/tunis-expedition.v1.json &&
    node /app/server/dist/fixtures/cli.js validate /app/server/fixtures/development/retreat-position.v1.json &&
    test -f /app/client/dist/legal.html &&
    cmp /app/LICENSE /app/client/dist/LICENSE.txt &&
    cmp /app/LIBRE_BASKERVILLE_OFL.txt /app/client/dist/LIBRE_BASKERVILLE_OFL.txt
  '
  step "Production image: non-root durable storage and backup"
  VOLUME="diplomacy-verify-storage-$$"
  docker volume create "$VOLUME" >/dev/null
  trap 'docker volume rm "$VOLUME" >/dev/null' EXIT
  run() { docker run --rm --mount "type=volume,source=$VOLUME,target=/data" --entrypoint node diplomacy:verify "$@"; }
  run server/dist/storage/cli.js init /data/game.sqlite
  run server/dist/storage/cli.js backup /data/game.sqlite /data/backup.sqlite
  run server/dist/storage/cli.js restore /data/backup.sqlite /data/restored.sqlite
  run -e 'const fs=require("node:fs"); for(const path of ["/data/game.sqlite","/data/backup.sqlite","/data/restored.sqlite"]) { const s=fs.statSync(path); if(s.uid!==10001 || (s.mode&511)!==384) process.exit(1); }'
fi

step "All checks passed"
