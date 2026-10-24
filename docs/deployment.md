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
  data/                  the database, backups/ and published-games/
  env/app.env
  previous-deploy.txt    the image and backup from before the latest deploy
  caddy/
```

SQLite in `data/` is the authority for identities, sessions, attempts, phase
reports, receipts, provider call records, operator state and queued
notifications. Legacy rooms are memory only and are disabled in the showcase
profile. See [storage and backup](storage.md); use a durable private volume.

## Environment

Production environment values are rendered from a local, git-ignored
`.env.production` (or `LIGHTSAIL_ENV_FILE`) into the remote `env/app.env`. The
renderer copies only the approved allowlist. The deploy refuses the root `.env`,
which is the development file.

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
DIPLOMACY_TRUSTED_PROXY=private
# Games with friends and against practice bots, signed-in players only (off if unset).
DIPLOMACY_SHOWCASE_GAMES=true
DIPLOMACY_MAX_ROOMS=20
DIPLOMACY_MAX_ROOMS_PER_ACCOUNT=1
# Published AI games (scripts/publish-games-production.sh fills the folder).
DIPLOMACY_PUBLISHED_GAMES_DIR=/data/published-games
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
node scripts/render-production-env.cjs .env.production /tmp/diplomacy-app.env
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

From a clean `master`:

```bash
./deploy_lightsail.sh
```

The script:

1. Refuses uncommitted changes (`ALLOW_DIRTY_DEPLOY=true`), a branch other than
   `master` (`ALLOW_NON_MASTER=true`) and the development `.env`.
2. Validates `.env.production` with the production allowlist.
3. Runs `scripts/staging-check.sh` (`SKIP_STAGING_CHECK=true` skips it).
4. Builds the image for `linux/amd64` (`DEPLOY_PLATFORM`), the Lightsail
   architecture, whatever this machine is, and reads its client asset name
   without running it.
5. Uploads the image, the Compose file and the Caddyfile over SSH.
6. On the host: backs up the database to `data/backups/pre-deploy-*.sqlite`
   and writes the running image and that backup to `previous-deploy.txt`;
   installs the environment; validates it inside the new image; recreates the
   app and Caddy; waits for `/healthz`; keeps only the new and previous images.
7. Checks the public site serves the new client, then prints what it offers:
   hosted games, published AI games, and whether players have AI opponents.

It never grants funds, opens paid play to players or publishes games; those
are the Operator view, `npm run storage -- grant` and
`scripts/publish-games-production.sh`.

Keep the existing remote environment instead of uploading one:

```bash
SYNC_LIGHTSAIL_ENV=false ./deploy_lightsail.sh
```

The host comes from the Terraform outputs, or `LIGHTSAIL_HOST`,
`LIGHTSAIL_USER`, `LIGHTSAIL_APP_DIR` and `SITE_DOMAIN`
(`scripts/lightsail-target.sh`).

## Local container staging check

Before any external deployment, exercise the production image on your own
machine:

```bash
scripts/staging-check.sh
```

It builds the image and, using values generated for the run, checks: offline
showcase and paid configurations validate, and the stand-in provider is refused
on a real origin; the
container runs as uid 10001 with a private data directory and database; notices
and corresponding source are packaged; the client, credits and license pages
load; the catalog and reference replay answer without an account; guests,
foreign origins and non-operators are refused; a locally seeded test player
starts the featured scenario, submits orders and gets a resolved phase; the
operator overview reports capacity, known cost and unresolved liability; an
online backup is taken while serving; a restart preserves every durable row; and
a restore into an empty volume serves identical rows, the same attempt and the
same spend figures; and the paid path with a stand-in provider and a dedicated
test grant: AI opponents start off for players, a sponsored game cannot start
until the operator turns them on, a turn's calls are charged to the grant and
stay within it, turning them off closes sponsored play, and the switch survives
a restart. It needs Docker, makes no paid call, sends no email and
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
7. With hosted games on: signed out, Games says to sign in; signed in, start a
   game against practice bots and play a turn; a second account joins a
   friends' game by its code; hosting a second game while the first is
   unfinished is refused; Leave this game brings back the Games home.
8. With games published: `/viewer` lists them signed out and a game opens.

## Rollback

Migrations only move forward, so rolling back means the previous image **and**
the backup taken just before the deploy, restored into a new path. Both are
named in `previous-deploy.txt` on the host. An older image refuses to start
against a newer database with a schema error rather than running against it.

```bash
cd /srv/diplomacy && cat previous-deploy.txt     # line 1: image, line 2: backup
export DIPLOMACY_IMAGE=<previous image> SITE_DOMAIN=diplomacy.camerondickie.ca
docker compose -f docker-compose.lightsail.yml stop app
docker compose -f docker-compose.lightsail.yml run --rm -T app \
  node server/dist/storage/cli.js restore <backup> /data/diplomacy-restored.sqlite
# set DIPLOMACY_DATABASE_PATH=/data/diplomacy-restored.sqlite in env/app.env, then:
docker compose -f docker-compose.lightsail.yml up -d --force-recreate app
```

Spend, grants and unresolved liabilities travel with the backup, so nothing is
refunded or lost by restoring it. Calls made after that backup was taken are
not in it: check the provider's own usage before resuming paid play.

## Owner gates

Nothing in this repository performs these, and no document here authorizes
them. Each needs an explicit owner decision recorded in Linear (DIC-72):

- running `terraform apply`, `deploy_lightsail.sh`, or changing DNS;
- rendering a production environment file with real credentials;
- granting funds, making paid AI available and turning **AI opponents for
  players** on ([operations.md](operations.md#ai-opponents-for-players));
- sending live notification email (`DIPLOMACY_NOTIFY_MODE=resend`);
- approving a public scenario catalog and calling the game "daily";
- making the repository public, after a human review of its history;
- linking the game from the personal site, which is a separate repository and
  deployment and shares no code, cookies or credentials with this one.

See [release-evidence.md](release-evidence.md) for what has been verified so far.
