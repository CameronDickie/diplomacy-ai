# Runtime configuration

`config/runtime.cjs` is the single validation contract for server startup, LLM
policy, production environment rendering, and deployment preflight. It has no
network effects and requires no build. `config/runtime.d.cts` exposes its TypeScript
types. Validation errors name settings without echoing their rejected values.

## Profiles and safe startup

Set `DIPLOMACY_PROFILE` to `local`, `private`, or `showcase`. Development defaults
to `local`; production defaults to `showcase`. Production rendering requires an
explicit profile and rejects `local`.

- `local`: loopback listener, offline STUB seats, no authentication by default.
- `private`: authentication required, configurable provider/model allowlists,
  optional explicitly enabled Discord. Players sign in through OAuth.
- `showcase`: authentication required; only STUB and server-owned OpenAI
  `gpt-6-luna` policy; Discord/voice cannot be enabled. OAuth player login is
  available; legacy free-form room commands are disabled in this profile.

`DIPLOMACY_PAID_AI_ENABLED` defaults to `false` in every profile. Existing keys
never enable paid calls. A temporary startup interlock rejects `true` until
DIC-64 wires every paid dispatch through durable budget admission. Settings can
be validated/rendered before that integration, but neither deployment preflight
nor the server will start paid operation. Configuration is not spend approval.

Start an offline clone with `.env.example`. To read a different ignored env file,
set `DIPLOMACY_ENV_FILE=/absolute/path/to/file` on the server process. Explicit
process environment values take precedence. This host-local path is deliberately
excluded from production rendering. Never source an untrusted env file as shell
code or put secrets in a `VITE_*` variable.

## Settings

All booleans accept exactly `true` or `false`. Numeric limits reject NaN,
infinities, fractions for integer settings, empty strings, and out-of-range values.
Unknown `LLM_*` settings fail validation so misspelled safety limits cannot be
silently ignored. Comma-separated lists are trimmed and deduplicated.

| Setting | Default / constraint |
| --- | --- |
| `NODE_ENV` | `production` activates HTTPS/secure-cookie validation |
| `PORT`, `HOST` | `3001` (1–65535); loopback in local, `0.0.0.0` otherwise |
| `CORS_ORIGINS` | Defaults to return origin; exact origins, includes return origin |
| `DIPLOMACY_AUTH_CALLBACK_ORIGIN` | `http://localhost:3001`; explicit HTTPS origin in production |
| `DIPLOMACY_AUTH_RETURN_ORIGIN` | `http://localhost:5173`; explicit HTTPS origin in production |
| `DIPLOMACY_AUTH_ENABLED` | Required in private/showcase/production; local default false |
| `DIPLOMACY_AUTH_COOKIE_SECURE` | True and mandatory in production |
| `DIPLOMACY_AUTH_SESSION_SECRET` | At least 32 characters if configured; required with login credentials |
| `DIPLOMACY_AUTH_USERNAME`, `DIPLOMACY_AUTH_PASSWORD_SALT`, `DIPLOMACY_AUTH_PASSWORD_HASH` | Retired; ignored. The shared password grants no application access. |
| `DIPLOMACY_GITHUB_CLIENT_ID`, `DIPLOMACY_GITHUB_CLIENT_SECRET` | Both required if either is supplied; required for paid showcase |
| `DIPLOMACY_GOOGLE_CLIENT_ID`, `DIPLOMACY_GOOGLE_CLIENT_SECRET` | Same rule as GitHub |
| `DIPLOMACY_ADMIN_GITHUB_USER_IDS` | Comma-separated immutable numeric IDs; at least one for paid showcase |
| `DIPLOMACY_DATABASE_PATH` | `./data/diplomacy.sqlite` relative to project root locally; `/data/diplomacy.sqlite` in production; use a durable mount |
| `DIPLOMACY_ENGINE_PATH` | Optional compiled Godip executable override |
| `DIPLOMACY_ENGINE_CONCURRENCY` | 2; integer 1–32 |
| `DIPLOMACY_ENGINE_MAX_QUEUE` | 16; integer 0–256 |
| `DIPLOMACY_ENGINE_TIMEOUT_MS` | 10000; integer 50–120000 |
| `DIPLOMACY_ENGINE_MAX_OUTPUT_BYTES` | 4194304; integer 1024–16777216 |
| `DIPLOMACY_MAX_ACTIVE_ATTEMPTS` | 3; integer 1–100 |
| `DIPLOMACY_MAX_ACTIVE_PER_ACCOUNT` | 1; positive integer no greater than global capacity |
| `DIPLOMACY_DAILY_START_LIMIT` | 3; integer 1–100 |
| `DIPLOMACY_IDLE_WARN_MINUTES`, `DIPLOMACY_IDLE_EXPIRE_MINUTES` | 25 / 30; integers 1–1440, warning strictly before expiry |
| `DIPLOMACY_RESULT_RETENTION_DAYS` | 30; integer 1–365 |
| `DIPLOMACY_DIAGNOSTIC_RETENTION_DAYS` | 7; integer 1–365 |
| `DIPLOMACY_RECEIPT_RETENTION_DAYS` | 90; integer 1–3650; ledger totals/liabilities must survive cleanup |

Engine limits apply to one shared asynchronous pool across all rooms and legal
catalogs. Queue wait counts toward the deadline. The pool bounds stdout and
stderr together, kills timed-out/cancelled process groups on POSIX, and retains
each running slot until its child is reaped. Requests also have a fixed 4 MiB
input limit. Engine errors return stable codes and safe retry guidance without
forwarding subprocess output. Legal catalogs share pending/completed work for
each room, phase and power; failures are evicted so a fresh request can retry.
Room removal and server shutdown cancel pending rules work.

The SQLite repository starts before HTTP and health fails when storage is
unavailable. See [storage operation](storage.md). Attempt-flow integration,
admission, lifecycle and notifications remain separate work items;
declaring settings does not mean those features are implemented. OAuth sessions
now use this storage; see [authentication](authentication.md).

## AI policy

`OPENAI_API_KEY` and `GEMINI_API_KEY` are required only when their paid provider is
enabled. Private/local provider identifiers are `STUB`, `OPENAI`, `GEMINI`,
`ANTHROPIC`, `OPENROUTER`, `OLLAMA`; enabling an unimplemented adapter is rejected.
Showcase accepts only STUB/OPENAI and exactly `gpt-6-luna` for OpenAI.

Supported allowlist precedence is `LLM_ALLOWED_MODELS_<PROVIDER>`, then the legacy
`<PROVIDER>_ALLOWED_MODELS`, then `LLM_ALLOWED_MODELS`, then profile defaults.
`LLM_ALLOWED_PROVIDERS` selects providers, while the paid-enable switch removes
all paid providers from effective policy when false. Model-role precedence is
`LLM_<PROVIDER>_<ROLE>_MODEL`, then `LLM_<ROLE>_MODEL`, then
`LLM_DEFAULT_<PROVIDER>_MODEL`, then profile defaults. Roles are
`DIPLOMACY_INITIATIVE`, `DIPLOMACY_REPLY`, `ORDERS`, `RETREATS`, `BUILDS`, `MEMORY`;
role settings support OPENAI and GEMINI. Every active default must be allowlisted.

| Setting | Default / constraint |
| --- | --- |
| `DIPLOMACY_PAID_AI_ENABLED` | false; explicit true is necessary but not sufficient for live operation |
| `LLM_TOTAL_BUDGET_USD` | 0; explicit positive total required for paid policy |
| `LLM_MAX_GAME_COST_USD` | 1; positive, at most 15 in showcase, no greater than funded total when paid |
| `LLM_MAX_RETRIES` | 1; integer 0–3 |
| `LLM_REQUEST_TIMEOUT_MS` | 30000; integer 1000–120000 |
| `LLM_MAX_INPUT_TOKENS` | 16000; integer 256–128000 |
| `LLM_MAX_OUTPUT_TOKENS` | 2048; integer 256–16384 |

Dollar amounts are USD. Configured totals are ceilings, not refills; the durable
ledger must retain spending and outstanding liabilities over restart/cleanup.

## Optional services

`DISCORD_ENABLED=false` skips bot initialization even if tokens exist. True
requires `DISCORD_GUILD_ID` and `DISCORD_COORDINATOR_TOKEN`. Optional per-power
tokens use `DISCORD_<POWER>_TOKEN` for AUSTRIA, ENGLAND, FRANCE, GERMANY, ITALY,
RUSSIA and TURKEY. `DISCORD_VOICE_ENABLED=false` is separate; true requires
Discord, all seven tokens, `OPENAI_API_KEY`, and explicit paid enablement.
`DISCORD_VOICE_DEBUG=false` and `DISCORD_VOICE_AUTO_LISTEN=true` are preserved.
Showcase rejects enabling either integration.

`DIPLOMACY_NOTIFY_MODE=outbox` is the safe default. `resend` requires
`RESEND_API_KEY`, `DIPLOMACY_NOTIFY_FROM`, and `DIPLOMACY_NOTIFY_TO`; those values
remain outside source control. Development must use a local sink and never send
an email merely because a key exists.

## Production preparation

Prepare a separate ignored environment file. At minimum, select showcase, set
both auth origins to your HTTPS game origin and set `HOST=0.0.0.0`. Preserve the
configured offline/paid switch and all limits intentionally. Use `/data/...` for
the database with the existing Compose durable volume.

```sh
node scripts/render-production-env.cjs .env.production /private/tmp/app.env.next
node --env-file=/private/tmp/app.env.next scripts/validate-runtime-env.cjs
```

The renderer validates first, refuses to overwrite the input, writes atomically
with mode 600 (including replacement of an existing file), and preserves all
supported settings except the host-local env-file override. Values are single
quoted to stop Compose `$` interpolation; apostrophes, NUL and carriage returns
are rejected instead of silently corrupting a credential. The server and deploy
script use the same validator. Deployment remains a separate operator action.
