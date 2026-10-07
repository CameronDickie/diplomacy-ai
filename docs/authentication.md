# Player authentication

The application uses GitHub OAuth and Google OpenID Connect. A public visitor
has no player or operator authority. Local mode permits human/offline-bot
practice without impersonating an authenticated user. The former shared-password
login and stateless cookies no longer grant access, including in private mode.

Configure either or both providers in an ignored environment file with
`DIPLOMACY_AUTH_SESSION_SECRET` (at least 32 random characters). Both ID and secret
are required for a configured provider. Missing pairs disable their sign-in
button; invalid partial configuration fails startup. Never put credentials in
`VITE_*` settings. For a **new installation only**, `npm run generate:auth-env --
.env.auth.new` creates an exclusive mode-600 secret file. Keep an existing secret:
rotating it invalidates every application session.

| Setting | Purpose |
| --- | --- |
| `DIPLOMACY_GITHUB_CLIENT_ID`, `DIPLOMACY_GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `DIPLOMACY_GOOGLE_CLIENT_ID`, `DIPLOMACY_GOOGLE_CLIENT_SECRET` | Google external web client |
| `DIPLOMACY_AUTH_CALLBACK_ORIGIN` | Trusted API origin: locally `http://localhost:3001` |
| `DIPLOMACY_AUTH_RETURN_ORIGIN` | Trusted app origin: locally `http://localhost:5173` |
| `DIPLOMACY_ADMIN_GITHUB_USER_IDS` | Comma-separated immutable numeric GitHub IDs |

Production uses `https://diplomacy.camerondickie.ca` for both origins. Register
exact `/api/auth/github/callback` and `/api/auth/google/callback` URLs under the
API origin. Login starts at `/api/auth/github` or `/api/auth/google`. The server
always returns to the configured app root; query parameters and Host headers
cannot choose a destination. Use `localhost` consistently for local browser
verification, since `127.0.0.1` cookies are a different host. The Vite proxy
preserves the browser origin. Production requires HTTPS and secure cookies.

## Trust and lifecycle

Each login uses a random state bound to an HttpOnly browser cookie, S256 PKCE,
and a ten-minute deadline. Google additionally verifies signature (RS256),
issuer, audience, issued-at/expiry, nonce and authorized presenter. Only basic
GitHub profile / Google openid-profile-email scopes are requested. Email, provider
access/refresh tokens and authorization codes are never persisted. No email
matching, display name, socket auth payload or room-host status grants a role.

Provider + immutable subject identifies one player. Google and GitHub identities
are separate accounts even with the same email, and quotas will apply to each
identity. Account linking is deferred: any future linking must require recent
proof of control of both accounts. Shared identity with the personal site could
use a common OIDC issuer/audience contract and explicit role mapping, without
merging repositories, sharing the game cookie, or reusing admin passwords.

A successful login rotates the old application session and issues a random
opaque cookie for seven days. SQLite stores only its HMAC-SHA256 digest (keyed by
the configured secret). Cookies are HttpOnly, SameSite=Lax, host-only, path `/`,
and use the `__Host-` prefix with Secure in production. Sessions survive restart;
revocation, ban and expiry are checked on every protected HTTP/socket action.
Logout revokes durably before clearing cookies and disconnects that session's
sockets. Expiry disconnects sockets at their deadline. Bans or revocations from
another process also remove passive subscriptions within 15 seconds. Mutations
still check immediately. Durable attempt writes must separately fence ownership,
ban and revisions in their transaction; authentication alone is not admission.

Only configured GitHub subjects are operators. Operator does not mean room host,
and room host does not mean operator. Private provider setup/integration commands
require operator authority. Local anonymous offline bots remain available.
Showcase rejects legacy free-form room commands for everyone, including operators;
the owned challenge service supplies its fixed offline-practice preset and
transactional admission path. Showcase renders that challenge UI and never opens
the legacy room socket or resumes a saved private room. Sponsored Luna play
remains interlocked until financial accounting is integrated.

`/api/auth/session` returns explicit `providerSettings`, `discord` and `voice`
capabilities. All are false for guests/ordinary players and in showcase mode.
Private/local operators receive integration capabilities only when those
services are explicitly enabled. The browser hides unavailable controls; fresh
server authorization remains authoritative on every action. Disabled services
have no registered handlers, constructors or SDK imports.

HTTP mutations require an exact trusted Origin. Socket upgrades require an
allowed Origin too (CORS alone does not protect WebSockets). Same-origin polling
GETs may omit Origin only with browser-controlled `Sec-Fetch-Site: same-origin`;
that fallback never applies to a WebSocket upgrade. Protected request
failures close access; unrecognized API routes do not return the SPA. Responses
and OAuth redirects use no-store and no-referrer headers.

Login begins are limited to five/minute per direct peer and thirty/minute
process-wide, 128 pending flows, and four concurrent exchanges. Forwarded-for is
not trusted: behind Caddy the conservative peer limit is shared. Restart drops
pending logins and rate buckets, never established sessions. Provider fetches
reject redirects, responses over 64 KiB and deadlines (10 seconds for exchange
and identity, 5 seconds for cached Google signing-key refresh). No raw provider
error body is returned or logged. This is a single-process MVP policy.

## Verification

`npm run check` runs actual HTTP and WebSocket tests with mocked provider
exchanges and locally signed Google tokens. Coverage includes state replay and
cross-browser binding, PKCE, provider denial, bad claims/signature/nonce, stable
identity separation, no raw credentials in backups, session restart/rotation,
logout/ban/expiry, origins, rate/body bounds, operator separation and revocation
on an existing socket. Tests never load the developer's `.env` or call providers.

For real-provider verification, start the API with the selected ignored env file,
local origins, paid AI disabled and notifications in outbox mode. Run the Vite
client and visit `http://localhost:5173`. Sign in once through each configured
provider, verify the account label and appropriate operator badge, reload, then
sign out. Do not record callback codes, cookies, secrets, account email or raw
provider responses in screenshots/reports. Refreshing a consumed callback must
fail. Review shared Google consent branding/privacy information before release.

DIC-51 remains open until the actual owned challenge start/resume/order paths,
server-owned preset, public replay and operator controls are integrated and
verified. Login foundation tests do not prove those application flows complete.

References: [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect),
[jose JWT validation](https://github.com/panva/jose).
