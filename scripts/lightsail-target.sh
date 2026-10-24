# Sourced by deploy_lightsail.sh and scripts/publish-games-production.sh: works out which Lightsail
# host, user, app directory and domain to use. Explicit environment variables win; otherwise the
# values come from the Terraform stack's outputs, then from the defaults below.

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

: "${LIGHTSAIL_HOST:?Set LIGHTSAIL_HOST or apply the Terraform stack in $LIGHTSAIL_TERRAFORM_DIR}"
LIGHTSAIL_USER="${LIGHTSAIL_USER:-ubuntu}"
LIGHTSAIL_APP_DIR="${LIGHTSAIL_APP_DIR:-/srv/diplomacy}"
SITE_DOMAIN="${SITE_DOMAIN:-diplomacy.camerondickie.ca}"
SSH_TARGET="$LIGHTSAIL_USER@$LIGHTSAIL_HOST"

# The running app container, found by its Compose labels so no Compose variables are needed.
remote_app_container() {
  echo "docker ps -q --filter label=com.docker.compose.service=app --filter label=com.docker.compose.project.working_dir='$LIGHTSAIL_APP_DIR'"
}
