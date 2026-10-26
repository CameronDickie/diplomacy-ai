#!/usr/bin/env bash
# Deploys the current commit to the Lightsail instance (docs/deployment.md):
#   1. checks: clean tree on master, an explicit production env file, the local staging check;
#   2. builds the image for the instance's architecture and uploads it over SSH;
#   3. on the host: backs up the database, records the running image for rollback, validates the
#      environment inside the new image, recreates the app, waits for health, prunes old images;
#   4. checks the public site serves the new client and reports what the server offers.
# It never grants funds, turns on paid play for players, or publishes games: those are separate
# owner steps (the Operator view, `npm run storage -- grant`, scripts/publish-games-production.sh).
set -euo pipefail

for tool in docker curl git node scp ssh; do
  command -v "$tool" >/dev/null || { echo "$tool is required"; exit 1; }
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lightsail-target.sh
. scripts/lightsail-target.sh

if [ "${ALLOW_DIRTY_DEPLOY:-false}" != "true" ]; then
  git update-index -q --refresh
  if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "Refusing to deploy with uncommitted or untracked git changes."
    echo "Commit or stash them first, or set ALLOW_DIRTY_DEPLOY=true to override."
    git status --short
    exit 1
  fi
else
  echo "ALLOW_DIRTY_DEPLOY=true; skipping the clean-tree check"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "master" ] && [ "${ALLOW_NON_MASTER:-false}" != "true" ]; then
  echo "Refusing to deploy branch $BRANCH. Deploy master, or set ALLOW_NON_MASTER=true."
  exit 1
fi

DEFAULT_TAG="$(git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
IMAGE_TAG="${1:-${IMAGE_TAG:-$DEFAULT_TAG}}"
IMAGE_NAME="diplomacy:$IMAGE_TAG"
# Lightsail bundles are x86_64; building for the Mac's own architecture would not start there.
DEPLOY_PLATFORM="${DEPLOY_PLATFORM:-linux/amd64}"
TMP_DIR="$(mktemp -d)"
SYNC_LIGHTSAIL_ENV="${SYNC_LIGHTSAIL_ENV:-true}"
LIGHTSAIL_ENV_FILE="${LIGHTSAIL_ENV_FILE:-.env.production}"
RENDERED_ENV_FILE="$TMP_DIR/app.env.next"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

if [ "$SYNC_LIGHTSAIL_ENV" = "true" ]; then
  # The root .env is the development file (local keys and settings); production has its own.
  if [ "$(cd "$(dirname "$LIGHTSAIL_ENV_FILE")" 2>/dev/null && pwd)/$(basename "$LIGHTSAIL_ENV_FILE")" = "$ROOT/.env" ]; then
    echo "Refusing to deploy from the development .env. Put production values in .env.production (git-ignored) or set LIGHTSAIL_ENV_FILE."
    exit 1
  fi
  [ -f "$LIGHTSAIL_ENV_FILE" ] || { echo "Missing $LIGHTSAIL_ENV_FILE. See docs/deployment.md, Environment."; exit 1; }
  echo "Validating production environment from $LIGHTSAIL_ENV_FILE"
  node scripts/render-production-env.cjs "$LIGHTSAIL_ENV_FILE" "$RENDERED_ENV_FILE"
elif [ "$SYNC_LIGHTSAIL_ENV" != "false" ]; then
  echo "SYNC_LIGHTSAIL_ENV must be true or false"
  exit 1
fi

if [ "${SKIP_STAGING_CHECK:-false}" != "true" ]; then
  echo "Running the local staging check (SKIP_STAGING_CHECK=true skips it)"
  scripts/staging-check.sh
fi

echo "Building $IMAGE_NAME for $DEPLOY_PLATFORM"
docker build --platform "$DEPLOY_PLATFORM" -t "$IMAGE_NAME" -f Dockerfile .
# Read the client's entry asset from the image without running it (it is built for another architecture).
BUILT="$(docker create --platform "$DEPLOY_PLATFORM" "$IMAGE_NAME")"
EXPECTED_JS_ASSET="$(docker cp "$BUILT:/app/client/dist/index.html" - | tar -xO | grep -oE 'assets/[^"]+\.js' | head -1)"
docker rm "$BUILT" >/dev/null
[ -n "$EXPECTED_JS_ASSET" ] || { echo "Could not find the client asset in $IMAGE_NAME"; exit 1; }
echo "Built frontend asset: $EXPECTED_JS_ASSET"

echo "Packing image"
docker save "$IMAGE_NAME" | gzip > "$TMP_DIR/diplomacy-image.tar.gz"

echo "Preparing remote directory $LIGHTSAIL_APP_DIR"
ssh "$SSH_TARGET" "mkdir -p '$LIGHTSAIL_APP_DIR/env' '$LIGHTSAIL_APP_DIR/data' '$LIGHTSAIL_APP_DIR/caddy/data' '$LIGHTSAIL_APP_DIR/caddy/config'"

echo "Uploading compose files and image"
UPLOAD_FILES=(docker-compose.lightsail.yml Caddyfile "$TMP_DIR/diplomacy-image.tar.gz")
if [ "$SYNC_LIGHTSAIL_ENV" = "true" ]; then
  UPLOAD_FILES+=("$RENDERED_ENV_FILE")
fi
scp "${UPLOAD_FILES[@]}" "$SSH_TARGET:$LIGHTSAIL_APP_DIR/"

echo "Deploying on the Lightsail host"
ssh "$SSH_TARGET" "LIGHTSAIL_APP_DIR='$LIGHTSAIL_APP_DIR' SITE_DOMAIN='$SITE_DOMAIN' DIPLOMACY_IMAGE='$IMAGE_NAME' SYNC_LIGHTSAIL_ENV='$SYNC_LIGHTSAIL_ENV' bash -s" <<'REMOTE'
set -euo pipefail

cd "$LIGHTSAIL_APP_DIR"
deployment_stage="initialization"
trap 'status=$?; echo "Remote deployment failed during: $deployment_stage (exit $status)" >&2; docker compose -f docker-compose.lightsail.yml ps 2>/dev/null || true; exit $status' ERR
export DIPLOMACY_IMAGE SITE_DOMAIN

deployment_stage="image loading"
docker load < diplomacy-image.tar.gz
rm -f diplomacy-image.tar.gz

# Migrations only move forward, so a rollback needs the database as it was before this deploy.
# The backup is taken by the running app (its own code and schema), as its own user.
deployment_stage="pre-deploy backup"
running="$(docker ps -q --filter label=com.docker.compose.service=app --filter label=com.docker.compose.project.working_dir="$LIGHTSAIL_APP_DIR")"
if [ -n "$running" ]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$running")"
  backup=none
  if docker exec "$running" test -f /data/diplomacy.sqlite; then
    backup="/data/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-${previous_image#diplomacy:}.sqlite"
    docker exec "$running" sh -c "mkdir -p /data/backups && node server/dist/storage/cli.js backup /data/diplomacy.sqlite '$backup'" >/dev/null
    echo "Backed up the database to data/backups/${backup#/data/backups/} (previous image $previous_image)"
  else
    echo "The running app ($previous_image) has no database yet: nothing to back up"
  fi
  printf '%s\n%s\n' "$previous_image" "$backup" > previous-deploy.txt
else
  echo "No running app container: first deploy, nothing to back up"
fi

# The data folder is bind-mounted over the image's own /data, so it must belong to the user the new
# image runs as (an older image, or a folder made by the SSH user, leaves it unwritable).
deployment_stage="data folder ownership"
app_owner="$(docker run --rm --entrypoint sh "$DIPLOMACY_IMAGE" -c 'echo "$(id -u):$(id -g)"' </dev/null)"
if [ "$(stat -c '%u:%g' data)" != "$app_owner" ]; then
  sudo -n chown -R "$app_owner" data
  sudo -n chmod 700 data
  echo "Gave data/ to the app's user ($app_owner)"
fi

if [ "$SYNC_LIGHTSAIL_ENV" = "true" ]; then
  deployment_stage="environment installation"
  # Kept for a rollback to the previous image, which may need its own settings.
  if [ -f env/app.env ]; then install -m 600 env/app.env env/app.env.previous; fi
  install -m 600 app.env.next env/app.env
  rm -f app.env.next
  echo "Installed env/app.env from the validated local environment file"
fi
if [ ! -f env/app.env ]; then
  echo "Missing $LIGHTSAIL_APP_DIR/env/app.env"
  echo "Run the deploy with SYNC_LIGHTSAIL_ENV=true or create the production environment file manually."
  exit 1
fi

deployment_stage="container environment validation"
docker compose -f docker-compose.lightsail.yml run --rm -T app node scripts/validate-runtime-env.cjs </dev/null

deployment_stage="service recreation"
docker compose -f docker-compose.lightsail.yml up -d --force-recreate app caddy

deployment_stage="running image verification"
running_image="$(docker compose -f docker-compose.lightsail.yml ps -q app | xargs docker inspect --format '{{.Config.Image}}')"
if [ "$running_image" != "$DIPLOMACY_IMAGE" ]; then
  echo "App container is running $running_image, expected $DIPLOMACY_IMAGE"
  docker compose -f docker-compose.lightsail.yml ps
  exit 1
fi

deployment_stage="container health check"
healthy=false
for attempt in $(seq 1 30); do
  if docker compose -f docker-compose.lightsail.yml exec -T app node -e "fetch('http://127.0.0.1:3001/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    healthy=true; break
  fi
  sleep 2
done
if [ "$healthy" != true ]; then
  echo "Health check failed"
  docker compose -f docker-compose.lightsail.yml ps
  [ -f previous-deploy.txt ] && echo "To roll back, see docs/deployment.md (Rollback); previous image and backup are in previous-deploy.txt"
  exit 1
fi
echo "Health check passed"

# Keep the running image and the one before it; older ones only fill the disk.
deployment_stage="image pruning"
keep_previous="$(head -1 previous-deploy.txt 2>/dev/null || true)"
docker image ls diplomacy --format '{{.Repository}}:{{.Tag}}' | while read -r image; do
  [ "$image" = "$DIPLOMACY_IMAGE" ] || [ "$image" = "$keep_previous" ] || docker image rm "$image" >/dev/null 2>&1 || true
done
REMOTE

echo "Verifying https://$SITE_DOMAIN serves $EXPECTED_JS_ASSET"
observed_assets=""
for attempt in $(seq 1 30); do
  live_html="$(curl -fsS --max-time 10 "https://$SITE_DOMAIN/" || true)"
  observed_assets="$(printf '%s' "$live_html" | grep -oE 'assets/[^"]+\.(js|css)' | tr '\n' ' ' || true)"
  if printf '%s' "$live_html" | grep -Fq "$EXPECTED_JS_ASSET"; then
    echo "Public asset verification passed"
    # What the site now offers, as a signed-out visitor sees it.
    curl -fsS --max-time 10 "https://$SITE_DOMAIN/api/auth/session" | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => { const v = JSON.parse(s), c = v.capabilities || {};
        console.log(`Profile ${v.profile}; hosted games ${c.games ? "on" : "off"}; published AI games ${c.recordedGames ? "on" : "off"}`); });' || true
    curl -fsS --max-time 10 "https://$SITE_DOMAIN/api/challenges" | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => console.log(`AI opponents for players: ${JSON.parse(s).sponsoredPlay}`));' || true
    echo "Done. Deployed $IMAGE_NAME to https://$SITE_DOMAIN"
    exit 0
  fi
  sleep 2
done

echo "Public asset verification failed." >&2
echo "Expected: $EXPECTED_JS_ASSET" >&2
echo "Observed: ${observed_assets:-no frontend assets returned}" >&2
exit 1
