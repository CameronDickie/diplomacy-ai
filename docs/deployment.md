# Deployment

Diplomacy deploys as a single Node app container behind Caddy on a dedicated
AWS Lightsail instance. The deployment path mirrors the personal-site setup:
build locally, upload the Docker image over SSH, load it on the server, and
restart Docker Compose.

## Runtime Layout

Remote files live under `/srv/diplomacy` by default:

```text
/srv/diplomacy/
  Caddyfile
  docker-compose.lightsail.yml
  data/
  backups/
  env/app.env
  caddy/
```

SQLite now stores player identities and revocable sessions in `data/`. Legacy
rooms remain ephemeral until the owned challenge recovery work is integrated.
See [storage/backup instructions](storage.md); use a durable private volume.

## Environment

Production environment values are rendered from a local ignored env file into
the remote `env/app.env`. The renderer copies only the approved allowlist.

Example offline showcase preparation (supply real credentials privately):

```dotenv
DIPLOMACY_PROFILE=showcase
DIPLOMACY_PAID_AI_ENABLED=false
DIPLOMACY_AUTH_CALLBACK_ORIGIN=https://diplomacy.camerondickie.ca
DIPLOMACY_AUTH_RETURN_ORIGIN=https://diplomacy.camerondickie.ca
CORS_ORIGINS=https://diplomacy.camerondickie.ca
DIPLOMACY_AUTH_SESSION_SECRET=...
DIPLOMACY_GITHUB_CLIENT_ID=...
DIPLOMACY_GITHUB_CLIENT_SECRET=...
DIPLOMACY_GOOGLE_CLIENT_ID=...
DIPLOMACY_GOOGLE_CLIENT_SECRET=...
DIPLOMACY_ADMIN_GITHUB_USER_IDS=...
DISCORD_ENABLED=false
DISCORD_VOICE_ENABLED=false
```

See [OAuth configuration and verification](authentication.md). Shared-password
login has been retired. Missing OAuth providers are disabled; no password or
local-mode setting can grant operator privileges. Showcase prohibits Discord
and voice. Private integrations have a separate [setup guide](discord-local-setup.md).

Keep `DISCORD_VOICE_DEBUG=false` in production unless actively diagnosing an
audio issue. Leave `VITE_SERVER_URL` unset when the client and server share the
same origin.

Validate env rendering locally:

```bash
node scripts/render-production-env.cjs .env /tmp/diplomacy-app.env
```

## First-Time Infrastructure

Provision the dedicated Lightsail instance and DNS record:

```bash
cd infra/terraform/diplomacy
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform validate
terraform plan -out diplomacy.tfplan
terraform apply diplomacy.tfplan
```

Confirm cloud-init installed Docker and created `/srv/diplomacy`:

```bash
ssh "$(terraform output -raw ssh_target)" 'cloud-init status --wait && docker --version && ls -la /srv/diplomacy'
```

## Deploy

From the repo root:

```bash
./deploy_lightsail.sh
```

The script:

1. Refuses dirty deploys unless `ALLOW_DIRTY_DEPLOY=true`.
2. Validates and uploads the approved production environment variables.
3. Builds the Docker image locally.
4. Saves and uploads the image over SSH.
5. Uploads the Compose file and Caddyfile.
6. Verifies required container environment variables.
7. Starts/restarts the app and Caddy.
8. Verifies `/healthz` and the deployed frontend asset.

Use another env source when needed:

```bash
LIGHTSAIL_ENV_FILE=.env.production ./deploy_lightsail.sh
```

Preserve an existing remote env file:

```bash
SYNC_LIGHTSAIL_ENV=false ./deploy_lightsail.sh
```

## Smoke Test

After deploy:

1. Open `https://diplomacy.camerondickie.ca`.
2. Create a game and join from a second browser session.
3. Confirm Socket.IO stays connected after a refresh.
4. Use Discord `/link` and send one DM to a configured bot.
5. If voice is enabled, start one voice conversation and confirm transcript and
   audio response.

## Persistence TODO

Before relying on this for multi-week games, add SQLite-backed persistence under
`/srv/diplomacy/data`.

Persist:

- games, players, orders, settings, phase state, and turn history
- Discord guild bindings and linked users
- chat messages and LLM memory
- adjudication results and public phase summaries

Do not persist active voice sessions. Add import/export support around the
existing turn-history JSON so ephemeral games can be backfilled later.
