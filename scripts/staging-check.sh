#!/usr/bin/env bash
# Local container staging check for the scenario game.
#
# Builds the production image and exercises it on this machine only: non-root
# runtime, showcase profile, health, public pages, notices and packaged source,
# an authenticated attempt, operator view, online backup, restart persistence
# and restore into a fresh volume. It makes no paid call, sends no email and
# contacts no service except the registry used to pull base images.
#
# Every credential-like value is generated for the run and never printed.
# Containers and volumes use a unique diplomacy-staging-* name and are removed
# on exit. Usage: scripts/staging-check.sh   (SKIP_BUILD=1 reuses the image)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER="${DOCKER:-docker}"
IMAGE="${STAGING_IMAGE:-diplomacy-staging:local}"
PORT="${STAGING_PORT:-3901}"
RUN_ID="diplomacy-staging-$$"
APP="$RUN_ID-app"; RESTORED="$RUN_ID-restored"
VOLUME="$RUN_ID-data"; RESTORE_VOLUME="$RUN_ID-restore"
ORIGIN="https://staging.diplomacy.test"
SECRET="$(openssl rand -hex 32)"
PASSED=0

cleanup() {
  "$DOCKER" rm -f "$APP" "$RESTORED" >/dev/null 2>&1 || true
  "$DOCKER" volume rm "$VOLUME" "$RESTORE_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
pass() { PASSED=$((PASSED + 1)); printf '  ok  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; exit 1; }
expect() { [ "$2" = "$3" ] && pass "$1" || fail "$1 (expected $3, got $2)"; }

start() { # name volume
  "$DOCKER" run -d --name "$1" -p "127.0.0.1:$PORT:3001" --mount "type=volume,source=$2,target=/data" \
    -e DIPLOMACY_PROFILE=showcase -e DIPLOMACY_PAID_AI_ENABLED=false \
    -e DIPLOMACY_AUTH_CALLBACK_ORIGIN="$ORIGIN" -e DIPLOMACY_AUTH_RETURN_ORIGIN="$ORIGIN" -e CORS_ORIGINS="$ORIGIN" \
    -e DIPLOMACY_AUTH_SESSION_SECRET="$SECRET" -e DIPLOMACY_ADMIN_GITHUB_USER_IDS=4242 \
    -e DIPLOMACY_NOTIFY_MODE=outbox -e DISCORD_ENABLED=false -e DISCORD_VOICE_ENABLED=false "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    GOT=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" || true); [ "$GOT" = 200 ] && return 0
    sleep 1
  done
  "$DOCKER" logs "$1" 2>&1 | tail -20 >&2
  fail "$1 did not become healthy"
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
api() { # method path cookie [body]
  local args=(-s -X "$1" "http://127.0.0.1:$PORT/api$2" -H "Origin: $ORIGIN" -H 'Content-Type: application/json')
  [ -n "${3:-}" ] && args+=(-H "Cookie: __Host-diplomacy_session=$3")
  [ -n "${4:-}" ] && args+=(-d "$4")
  curl "${args[@]}"
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(String(eval(process.argv[1])))})' "$1"; }
# bash 3.2 (the macOS default) mis-parses quotes inside a command substitution that is itself inside
# double quotes, so every check assigns its result to GOT first and compares afterwards.
# Stable digest of everything a restore must preserve, read-only from inside the container.
digest() {
  "$DOCKER" exec "$1" node -e '
    const {DatabaseSync}=require("node:sqlite"),{createHash}=require("node:crypto");
    const db=new DatabaseSync("/data/diplomacy.sqlite",{readOnly:true}),h=createHash("sha256");
    for(const t of ["players","sessions","challenges","attempts","reports","receipts","phase_jobs","start_receipts","account_starts","provider_calls","provider_decisions","operator_state","funding_grants","funding_adjustments","funding_pool","reservations","attempt_spend","exhibitions","exhibition_reports","schema_migrations"])
      h.update(t+JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1,2`).all(),(k,v)=>typeof v==="bigint"?String(v):v));
    console.log(h.digest("hex"));'
}

echo "Building $IMAGE"
[ -n "${SKIP_BUILD:-}" ] || "$DOCKER" build --quiet --tag "$IMAGE" "$ROOT" >/dev/null
"$DOCKER" volume create "$VOLUME" >/dev/null; "$DOCKER" volume create "$RESTORE_VOLUME" >/dev/null

echo "Configuration"
"$DOCKER" run --rm -e DIPLOMACY_PROFILE=showcase -e DIPLOMACY_AUTH_CALLBACK_ORIGIN="$ORIGIN" -e DIPLOMACY_AUTH_RETURN_ORIGIN="$ORIGIN" -e CORS_ORIGINS="$ORIGIN" \
  "$IMAGE" node scripts/validate-runtime-env.cjs >/dev/null || fail "offline showcase configuration validates"
pass "offline showcase configuration validates"
# Paid startup must stay interlocked even with a complete paid configuration.
REFUSAL=$("$DOCKER" run --rm -e DIPLOMACY_PROFILE=showcase -e DIPLOMACY_PAID_AI_ENABLED=true -e LLM_TOTAL_BUDGET_USD=1 -e LLM_MAX_GAME_COST_USD=1 \
  -e LLM_ALLOWED_PROVIDERS=OPENAI -e OPENAI_API_KEY=placeholder-not-a-key -e DIPLOMACY_AUTH_SESSION_SECRET="$SECRET" -e DIPLOMACY_ADMIN_GITHUB_USER_IDS=4242 \
  -e DIPLOMACY_GITHUB_CLIENT_ID=placeholder -e DIPLOMACY_GITHUB_CLIENT_SECRET=placeholder -e DIPLOMACY_GOOGLE_CLIENT_ID=placeholder -e DIPLOMACY_GOOGLE_CLIENT_SECRET=placeholder \
  -e DIPLOMACY_AUTH_CALLBACK_ORIGIN="$ORIGIN" -e DIPLOMACY_AUTH_RETURN_ORIGIN="$ORIGIN" -e CORS_ORIGINS="$ORIGIN" "$IMAGE" node scripts/validate-runtime-env.cjs 2>&1 || true)
case "$REFUSAL" in *"DIPLOMACY_PAID_AI_ENABLED: paid startup awaits"*) pass "paid startup is refused by the interlock";; *) fail "paid configuration was not refused by the interlock";; esac

echo "Runtime"
start "$APP" "$VOLUME"
GOT=$("$DOCKER" exec "$APP" id -u)
expect "runs as the unprivileged user" "$GOT" 10001
GOT=$("$DOCKER" exec "$APP" stat -c %a /data)
expect "data directory is private" "$GOT" 700
GOT=$("$DOCKER" exec "$APP" stat -c %a /data/diplomacy.sqlite)
expect "database file is private" "$GOT" 600
"$DOCKER" exec "$APP" sh -c 'test -s LICENSE && test -s THIRD_PARTY_NOTICES.md && test -s LIBRE_BASKERVILLE_OFL.txt && test -s source/server/src/index.ts && test -s source/engine/go.mod && test -d source/third_party/godip && test -s source/Dockerfile' \ || fail "notices and corresponding source are packaged"
pass "notices and corresponding source are packaged"

echo "Public surface"
GOT=$(status "http://127.0.0.1:$PORT/")
expect "client page" "$GOT" 200
GOT=$(status "http://127.0.0.1:$PORT/legal.html")
expect "credits page" "$GOT" 200
GOT=$(status "http://127.0.0.1:$PORT/LICENSE.txt")
expect "license text" "$GOT" 200
CATALOG="$(api GET /challenges)"
GOT=$(printf '%s' "$CATALOG" | json 'v.challenges.length+":"+v.rotation.label+":"+v.sponsoredPlay')
expect "catalog features one scenario" "$GOT" "1:DEVELOPMENT_ROTATION:NOT_OFFERED"
GOT=$(api GET /challenges/demo | json 'v.kind+":"+(v.reports.length>0)')
expect "reference replay" "$GOT" "REFERENCE:true"
GOT=$(status -X POST "http://127.0.0.1:$PORT/api/attempts" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{}')
expect "guest cannot start" "$GOT" 401
GOT=$(status "http://127.0.0.1:$PORT/api/operator/overview")
expect "guest cannot see operator data" "$GOT" 401
GOT=$(status -X POST "http://127.0.0.1:$PORT/api/attempts" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}')
expect "foreign origin is refused" "$GOT" 403
GOT=$(status "http://127.0.0.1:$PORT/api/nope")
expect "unknown API path is not the client page" "$GOT" 404

echo "Authenticated play (locally seeded test sessions)"
# Creates a test player, a test operator and one known plus one unresolved provider record.
SEEDED="$("$DOCKER" exec -e SEED_SECRET="$SECRET" "$APP" node --input-type=module -e '
  import { createHmac, createHash } from "node:crypto";
  import { Store, newToken, hashToken } from "/app/server/dist/storage/Store.js";
  const store = await Store.open("/data/diplomacy.sqlite"), now = Date.now(), out = [];
  for (const subject of ["staging-player", "4242"]) {
    const player = await store.call("identity", { provider: "github", subject, displayName: "Staging test", now });
    const token = newToken();
    await store.call("createSession", { tokenHash: createHmac("sha256", process.env.SEED_SECRET).update(token).digest("hex"), playerId: player.id, now, expiresAt: now + 3600000 });
    out.push(token, player.id);
  }
  // Synthetic funds so the two mock provider records below can hold reservations.
  await store.call("grantFunding", { amountNanousd: 1000000, authorizationRef: "staging-mock-grant", grantedBy: "staging", now });
  const card = (await (await fetch("http://127.0.0.1:3001/api/challenges")).json()).challenges[0];
  const attempt = await store.call("createAttempt", { id: "staging-ledger", playerId: out[3], challengeId: card.id, challengeVersion: card.version, reconnectTokenHash: hashToken("staging"), now });
  const hold = attempt.board.units.filter(u => u.power === card.humanPower).map(u => `${u.territory}|HOLD`);
  const { job } = await store.call("beginPhase", { id: attempt.id, playerId: out[3], expectedRevision: 0, phaseId: attempt.phaseId, operationId: "staging-phase", requestId: "orders", action: { phase: "ORDERS", orderIds: hold }, now });
  const power = ["FRANCE", "ENGLAND"].find(p => p !== card.humanPower);
  for (const id of ["staging-known", "staging-unresolved"]) {
    await store.call("prepareProviderCall", { now, intent: { id, fence: { operationId: job.operationId, attemptId: job.attemptId, phaseId: job.phaseId, revision: job.revision }, power, provider: "OPENAI", model: "gpt-6-luna", role: "ORDERS", pricingVersion: "staging-mock", requestHash: createHash("sha256").update(id).digest("hex"), maxCostNanousd: 100000 } });
    await store.call("dispatchProviderCall", { id, now });
  }
  await store.call("receiveProviderCall", { id: "staging-known", responseId: "resp_staging", now, usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0, costNanousd: 4321 } });
  // Close that attempt so no interrupted phase is left for startup recovery to finish: the rows below must not change across a restart.
  await store.call("terminateAttempt", { id: attempt.id, playerId: out[3], lifecycle: "STOPPED", now });
  await store.close(); console.log(out.join(" "));')"
read -r PLAYER_COOKIE _PLAYER_ID OPERATOR_COOKIE _OPERATOR_ID <<<"$SEEDED"
CARD_ID="$(printf '%s' "$CATALOG" | json 'v.challenges[0].id')"; CARD_VERSION="$(printf '%s' "$CATALOG" | json 'v.challenges[0].version')"
ATTEMPT="$(api POST /attempts "$PLAYER_COOKIE" "{\"requestId\":\"staging-start\",\"challengeId\":\"$CARD_ID\",\"challengeVersion\":$CARD_VERSION}")"
ATTEMPT_ID="$(printf '%s' "$ATTEMPT" | json 'v.id')"
GOT=$(printf '%s' "$ATTEMPT" | json 'v.lifecycle+":"+v.board.season+":"+v.challenge.id')
expect "player starts the featured scenario" "$GOT" "ACTIVE:SPRING:$CARD_ID"
GOT=$(api POST /attempts "$PLAYER_COOKIE" "{\"requestId\":\"staging-start\",\"challengeId\":\"$CARD_ID\",\"challengeVersion\":$CARD_VERSION}" | json 'v.id')
expect "repeated start returns the same attempt" "$GOT" "$ATTEMPT_ID"
ORDERS="$(api GET "/attempts/$ATTEMPT_ID/legal" "$PLAYER_COOKIE" | json 'JSON.stringify(v.options.filter(o=>o.order.type==="HOLD").map(o=>o.id))')"
PHASE_ID="$(printf '%s' "$ATTEMPT" | json 'v.phaseId')"
SUBMITTED="$(api POST "/attempts/$ATTEMPT_ID/orders" "$PLAYER_COOKIE" "{\"revision\":0,\"phaseId\":\"$PHASE_ID\",\"requestId\":\"staging-orders\",\"action\":{\"phase\":\"ORDERS\",\"orderIds\":$ORDERS}}")"
GOT=$(printf '%s' "$SUBMITTED" | json 'v.status')
expect "orders accepted" "$GOT" SUBMITTING
for _ in $(seq 1 30); do GOT=$(api GET "/attempts/$ATTEMPT_ID" "$PLAYER_COOKIE" | json 'v.board.season+":"+v.execution'); [ "$GOT" = "FALL:ACCEPTING" ] && break; sleep 1; done
GOT=$(api GET "/attempts/$ATTEMPT_ID" "$PLAYER_COOKIE" | json 'v.board.season+":"+v.execution')
expect "phase resolved by the engine" "$GOT" "FALL:ACCEPTING"
GOT=$(api GET "/attempts/$ATTEMPT_ID/reports" "$PLAYER_COOKIE" | json 'v.reports.length')
expect "phase report saved" "$GOT" 1
GOT=$(status "http://127.0.0.1:$PORT/api/operator/overview" -H "Cookie: __Host-diplomacy_session=$PLAYER_COOKIE")
expect "player cannot use operator routes" "$GOT" 403
OVERVIEW="$(api GET /operator/overview "$OPERATOR_COOKIE")"
GOT=$(printf '%s' "$OVERVIEW" | json 'v.activeAttempts+":"+v.funding.settledNanousd+":"+v.funding.reservedNanousd+":"+v.funding.availableNanousd')
expect "operator sees capacity and spend" "$GOT" "1:4321:100000:895679"
GOT=$(printf '%s' "$OVERVIEW" | json 'v.outbox.recent.filter(m=>m.dedupeKey==="start:'"$ATTEMPT_ID"'").length')
expect "start notice recorded once" "$GOT" 1

echo "Backup, restart and restore"
"$DOCKER" exec "$APP" node server/dist/storage/cli.js backup /data/diplomacy.sqlite /data/backup.sqlite >/dev/null || fail "online backup while serving"
pass "online backup while serving"
BEFORE="$(digest "$APP")"
"$DOCKER" restart "$APP" >/dev/null
for _ in $(seq 1 60); do GOT=$(status "http://127.0.0.1:$PORT/healthz" || true); [ "$GOT" = 200 ] && break; sleep 1; done
GOT=$(digest "$APP")
expect "restart keeps every durable row" "$GOT" "$BEFORE"
GOT=$(api GET "/attempts/$ATTEMPT_ID" "$PLAYER_COOKIE" | json 'v.board.season+":"+v.lifecycle')
expect "session and attempt survive restart" "$GOT" "FALL:ACTIVE"
"$DOCKER" rm -f "$APP" >/dev/null
# Restore into a different, empty volume and serve from it. The backup volume is mounted writable:
# SQLite cannot open a WAL-mode backup from read-only media.
"$DOCKER" run --rm --mount "type=volume,source=$VOLUME,target=/backup" --mount "type=volume,source=$RESTORE_VOLUME,target=/data" \
  --entrypoint node "$IMAGE" server/dist/storage/cli.js restore /backup/backup.sqlite /data/diplomacy.sqlite >/dev/null || fail "restore verifies and writes a new database"
pass "restore verifies and writes a new database"
if "$DOCKER" run --rm --mount "type=volume,source=$VOLUME,target=/backup" --mount "type=volume,source=$RESTORE_VOLUME,target=/data" \
  --entrypoint node "$IMAGE" server/dist/storage/cli.js restore /backup/backup.sqlite /data/diplomacy.sqlite >/dev/null 2>&1
then fail "restore overwrote an existing database"; else pass "restore refuses to overwrite"; fi
start "$RESTORED" "$RESTORE_VOLUME"
GOT=$(digest "$RESTORED")
expect "restored volume holds identical rows" "$GOT" "$BEFORE"
GOT=$(api GET "/attempts/$ATTEMPT_ID" "$PLAYER_COOKIE" | json 'v.board.season+":"+v.execution+":"+v.challenge.id')
expect "restored attempt is playable state" "$GOT" "FALL:ACCEPTING:$CARD_ID"
GOT=$(api GET /operator/overview "$OPERATOR_COOKIE" | json 'v.funding.settledNanousd+":"+v.funding.reservedNanousd+":"+v.funding.availableNanousd')
expect "restored spend and liability unchanged" "$GOT" "4321:100000:895679"

printf '\n%d checks passed. Local containers and volumes are removed on exit.\n' "$PASSED"
