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

SQLite in `data/` is the authority for identities, sessions, attempts, phase
reports, receipts, provider call records, operator state and queued
notifications. Legacy rooms are memory only and are disabled in the showcase
profile. See [storage and backup](storage.md); use a durable private volume.

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

## Local container staging check

Before any external deployment, exercise the production image on your own
machine:

```bash
scripts/staging-check.sh
```

It builds the image and, using values generated for the run, checks: offline
showcase configuration validates and a paid configuration is refused; the
container runs as uid 10001 with a private data directory and database; notices
and corresponding source are packaged; the client, credits and license pages
load; the catalog and reference replay answer without an account; guests,
foreign origins and non-operators are refused; a locally seeded test player
starts the featured scenario, submits orders and gets a resolved phase; the
operator overview reports capacity, known cost and unresolved liability; an
online backup is taken while serving; a restart preserves every durable row; and
a restore into an empty volume serves identical rows, the same attempt and the
same spend figures. It needs Docker, makes no paid call, sends no email and
removes its containers and volumes on exit. `SKIP_BUILD=1` reuses the image.

The seeded sessions are created directly in the staging database. The script
does not exercise real GitHub or Google sign-in; do that by hand against the
deployed origin.

## Smoke test after deploy

1. Open the site signed out: the scenario goal, "How this challenge works" and
   the reference replay load. `/legal.html` shows credits and licenses.
2. Sign in with GitHub and with Google in separate sessions. Each is its own
   account.
3. Start the featured scenario, submit a turn, reload the page and confirm the
   attempt resumes. Finish or abandon it and open its saved phase reports.
4. As the operator, open **Operator**: capacity, spend and the start
   notification are shown; an ordinary account has no Operator button.
5. Repeat steps 1 and 3 at phone width.
6. Restart the app container and confirm the session and the attempt survive.

## Rollback

Take a backup before every upgrade ([operations runbook](operations.md)).
Migrations only move forward, so rolling back means the previous image **and**
the backup taken before the upgrade, restored into a new path. An older image
refuses to start against a newer database with a schema error rather than
running against it.

## Owner gates

Nothing in this repository performs these, and no document here authorizes
them. Each needs an explicit owner decision recorded in Linear (DIC-72):

- running `terraform apply`, `deploy_lightsail.sh`, or changing DNS;
- rendering a production environment file with real credentials;
- funding and enabling paid AI (also blocked in code until DIC-64);
- sending live notification email (`DIPLOMACY_NOTIFY_MODE=resend`);
- approving a public scenario catalog and calling the game "daily";
- making the repository public, after a human review of its history;
- linking the game from the personal site, which is a separate repository and
  deployment and shares no code, cookies or credentials with this one.

See [release-evidence.md](release-evidence.md) for what has been verified so far.
