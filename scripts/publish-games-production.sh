#!/usr/bin/env bash
# Puts the games in published-games/ on the production site (docs/game-viewer.md, Publishing chosen
# games). The folder is the whole truth: what is in it after `npm run records -- publish` / `withdraw`
# is exactly what the site shows afterwards.
#
#   scripts/publish-games-production.sh [--dry-run] [FOLDER]
#
# It checks every game is in published form first (`records check`), streams the folder into the
# running app container (so the files belong to the app's own user), swaps it in at once, and then
# confirms the live site lists the same games. The server must run with
# DIPLOMACY_PUBLISHED_GAMES_DIR=/data/published-games, which is set at deploy time.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DRY_RUN=false
FOLDER=published-games
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -*) echo "Usage: $0 [--dry-run] [FOLDER]"; exit 1 ;;
    *) FOLDER="$arg" ;;
  esac
done

[ -f "$FOLDER/index.json" ] || { echo "$FOLDER/index.json is missing. Run npm run records -- publish RUN_ID... first."; exit 1; }
[ -f server/dist/autoplay/recordsCli.js ] || npm run build -w shared -w server >/dev/null
node server/dist/autoplay/recordsCli.js check --into "$FOLDER"
COUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).games.length)' "$FOLDER/index.json")"
if [ "$DRY_RUN" = true ]; then echo "Dry run: would publish $COUNT game(s) from $FOLDER."; exit 0; fi

# shellcheck source=scripts/lightsail-target.sh
. scripts/lightsail-target.sh

echo "Publishing $COUNT game(s) to $SITE_DOMAIN"
# Only the folder's own flat .json files travel; the swap keeps the old folder until the new one is complete.
(cd "$FOLDER" && tar -cf - ./*.json) | ssh "$SSH_TARGET" "container=\$($(remote_app_container)); [ -n \"\$container\" ] || { echo 'The app is not running on the host.' >&2; exit 1; }
  docker exec -i \"\$container\" sh -c 'set -e; cd /data; rm -rf published-games.next published-games.old; mkdir published-games.next; tar -xf - -C published-games.next
    chmod 755 published-games.next; chmod 644 published-games.next/*.json
    if [ -d published-games ]; then mv published-games published-games.old; fi; mv published-games.next published-games; rm -rf published-games.old'"

LIVE="$(curl -fsS --max-time 10 "https://$SITE_DOMAIN/game-records/index.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).games.length))' || echo none)"
if [ "$LIVE" = "$COUNT" ]; then
  echo "Done: https://$SITE_DOMAIN/viewer lists $LIVE published game(s)."
else
  echo "Uploaded, but the site lists ${LIVE} game(s), expected $COUNT." >&2
  echo "Check that the production env sets DIPLOMACY_PUBLISHED_GAMES_DIR=/data/published-games, then redeploy." >&2
  exit 1
fi
