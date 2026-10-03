#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null || { echo "Docker CLI is required"; exit 1; }
command -v curl >/dev/null || { echo "curl is required"; exit 1; }
command -v git >/dev/null || { echo "Git CLI is required"; exit 1; }
command -v node >/dev/null || { echo "Node.js is required"; exit 1; }
command -v scp >/dev/null || { echo "scp is required"; exit 1; }
command -v ssh >/dev/null || { echo "ssh is required"; exit 1; }

LIGHTSAIL_TERRAFORM_DIR="${LIGHTSAIL_TERRAFORM_DIR:-infra/terraform/diplomacy}"

if [ -z "${LIGHTSAIL_HOST:-}" ] && command -v terraform >/dev/null && [ -d "$LIGHTSAIL_TERRAFORM_DIR" ]; then
  LIGHTSAIL_HOST="$(terraform -chdir="$LIGHTSAIL_TERRAFORM_DIR" output -raw lightsail_static_ip 2>/dev/null || true)"
  LIGHTSAIL_USER="${LIGHTSAIL_USER:-$(terraform -chdir="$LIGHTSAIL_TERRAFORM_DIR" output -json deploy_environment 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => process.stdout.write(JSON.parse(input).LIGHTSAIL_USER || ""));
  ' 2>/dev/null || true)}"
  LIGHTSAIL_APP_DIR="${LIGHTSAIL_APP_DIR:-$(terraform -chdir="$LIGHTSAIL_TERRAFORM_DIR" output -raw app_dir 2>/dev/null || true)}"
  SITE_DOMAIN="${SITE_DOMAIN:-$(terraform -chdir="$LIGHTSAIL_TERRAFORM_DIR" output -raw site_url 2>/dev/null | sed 's#^https://##' || true)}"
fi

if [ "${ALLOW_DIRTY_DEPLOY:-false}" != "true" ]; then
  git update-index -q --refresh
  if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "Refusing to deploy with uncommitted or untracked git changes."
    echo "Commit/stash them first, or set ALLOW_DIRTY_DEPLOY=true to override."
    git status --short
    exit 1
  fi
else
  echo "ALLOW_DIRTY_DEPLOY=true; skipping git cleanliness check"
fi

: "${LIGHTSAIL_HOST:?Set LIGHTSAIL_HOST or apply the Terraform stack in $LIGHTSAIL_TERRAFORM_DIR}"

LIGHTSAIL_USER="${LIGHTSAIL_USER:-ubuntu}"
LIGHTSAIL_APP_DIR="${LIGHTSAIL_APP_DIR:-/srv/diplomacy}"
SITE_DOMAIN="${SITE_DOMAIN:-diplomacy.camerondickie.ca}"
SSH_TARGET="$LIGHTSAIL_USER@$LIGHTSAIL_HOST"
DEFAULT_TAG="$(git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)"
IMAGE_TAG="${1:-${IMAGE_TAG:-$DEFAULT_TAG}}"
IMAGE_NAME="diplomacy:$IMAGE_TAG"
TMP_DIR="$(mktemp -d)"
SYNC_LIGHTSAIL_ENV="${SYNC_LIGHTSAIL_ENV:-true}"
LIGHTSAIL_ENV_FILE="${LIGHTSAIL_ENV_FILE:-.env}"
RENDERED_ENV_FILE="$TMP_DIR/app.env.next"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [ "$SYNC_LIGHTSAIL_ENV" = "true" ]; then
  echo "Validating production environment variables from $LIGHTSAIL_ENV_FILE"
  node scripts/render-production-env.cjs "$LIGHTSAIL_ENV_FILE" "$RENDERED_ENV_FILE"
elif [ "$SYNC_LIGHTSAIL_ENV" != "false" ]; then
  echo "SYNC_LIGHTSAIL_ENV must be true or false"
  exit 1
fi

echo "Building $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f Dockerfile .
EXPECTED_JS_ASSET="$(
  docker run --rm "$IMAGE_NAME" node -e '
    const fs = require("node:fs");
    const html = fs.readFileSync("/app/client/dist/index.html", "utf8");
    const match = html.match(/assets\/[^"]+\.js/);
    if (!match) process.exit(1);
    process.stdout.write(match[0]);
  '
)"
echo "Built frontend asset: $EXPECTED_JS_ASSET"

echo "Packing image"
docker save "$IMAGE_NAME" | gzip > "$TMP_DIR/diplomacy-image.tar.gz"

echo "Preparing remote directory $LIGHTSAIL_APP_DIR"
ssh "$SSH_TARGET" "mkdir -p '$LIGHTSAIL_APP_DIR/env' '$LIGHTSAIL_APP_DIR/data' '$LIGHTSAIL_APP_DIR/backups' '$LIGHTSAIL_APP_DIR/caddy/data' '$LIGHTSAIL_APP_DIR/caddy/config'"

echo "Uploading compose files and image"
UPLOAD_FILES=(docker-compose.lightsail.yml Caddyfile "$TMP_DIR/diplomacy-image.tar.gz")
if [ "$SYNC_LIGHTSAIL_ENV" = "true" ]; then
  UPLOAD_FILES+=("$RENDERED_ENV_FILE")
fi
scp "${UPLOAD_FILES[@]}" "$SSH_TARGET:$LIGHTSAIL_APP_DIR/"

echo "Deploying on Lightsail host"
ssh "$SSH_TARGET" "LIGHTSAIL_APP_DIR='$LIGHTSAIL_APP_DIR' SITE_DOMAIN='$SITE_DOMAIN' DIPLOMACY_IMAGE='$IMAGE_NAME' SYNC_LIGHTSAIL_ENV='$SYNC_LIGHTSAIL_ENV' bash -s" <<'REMOTE'
set -euo pipefail

cd "$LIGHTSAIL_APP_DIR"
deployment_stage="initialization"
trap 'status=$?; echo "Remote deployment failed during: $deployment_stage (exit $status)" >&2; docker compose -f docker-compose.lightsail.yml ps 2>/dev/null || true; exit $status' ERR

if [ "$SYNC_LIGHTSAIL_ENV" = "true" ]; then
  deployment_stage="environment installation"
  install -m 600 app.env.next env/app.env
  rm -f app.env.next
  echo "Installed env/app.env from the validated local environment file"
fi

if [ ! -f env/app.env ]; then
  echo "Missing $LIGHTSAIL_APP_DIR/env/app.env"
  echo "Run the deploy with SYNC_LIGHTSAIL_ENV=true or create the production environment file manually."
  exit 1
fi

deployment_stage="image loading"
docker load < diplomacy-image.tar.gz
rm -f diplomacy-image.tar.gz

export DIPLOMACY_IMAGE SITE_DOMAIN
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
for attempt in $(seq 1 30); do
  if docker compose -f docker-compose.lightsail.yml exec -T app node -e "fetch('http://127.0.0.1:3001/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    echo "Health check passed"
    exit 0
  fi
  sleep 2
done

echo "Health check failed"
docker compose -f docker-compose.lightsail.yml ps
exit 1
REMOTE

echo "Verifying https://$SITE_DOMAIN serves $EXPECTED_JS_ASSET"
observed_assets=""
for attempt in $(seq 1 30); do
  live_html="$(curl -fsS --max-time 10 "https://$SITE_DOMAIN/" || true)"
  observed_assets="$(printf '%s' "$live_html" | grep -oE 'assets/[^"]+\.(js|css)' | tr '\n' ' ' || true)"
  if printf '%s' "$live_html" | grep -Fq "$EXPECTED_JS_ASSET"; then
    echo "Public asset verification passed"
    echo "Done. Deployed $IMAGE_NAME to https://$SITE_DOMAIN"
    exit 0
  fi
  sleep 2
done

echo "Public asset verification failed." >&2
echo "Expected: $EXPECTED_JS_ASSET" >&2
echo "Observed: ${observed_assets:-no frontend assets returned}" >&2
exit 1

