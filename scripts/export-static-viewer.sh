#!/usr/bin/env bash
# The game viewer as static files, with the chosen games, for hosting anywhere (camerondickie.ca/diplomacy/).
#
#   npm run viewer:static -- OUT_DIR [RUN_ID...]
#
# Builds the viewer alone (no game server, no sign-in) for the path VIEWER_BASE (default /diplomacy/),
# publishes the games into it in compact form (no prompts, commits or local file names; each board stored
# once), and copies the result to OUT_DIR, replacing an earlier export there. With no RUN_IDs, every game in
# game-records/ is included. OUT_DIR must be empty, new, or an earlier export: anything else is refused.
set -euo pipefail

if [ $# -lt 1 ] || [ "${1#-}" != "$1" ]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
out="$1"; shift
root="$(cd "$(dirname "$0")/.." && pwd)"
marker=".diplomacy-static-viewer"

if [ -e "$out" ] && [ -n "$(ls -A "$out")" ] && [ ! -f "$out/$marker" ]; then
  echo "$out is not empty and is not an earlier export (no $marker); refusing to replace it." >&2
  exit 1
fi

cd "$root"
if [ $# -eq 0 ]; then
  # Every game the viewer lists, in its order.
  set -- $(node -e 'for (const g of require("./game-records/index.json").games) console.log(g.runId)')
fi

npm run build -w shared >/dev/null
npm run build -w server >/dev/null
(cd client && npx vite build --mode static --logLevel warn)
node server/dist/autoplay/recordsCli.js publish --compact --from game-records --into client/dist-static/game-records "$@" >/dev/null
touch "client/dist-static/$marker"

mkdir -p "$out"
rsync -a --delete "client/dist-static/" "$out/"
echo "Static viewer for ${VIEWER_BASE:-/diplomacy/} with $# games → $out ($(du -sh "$out" | cut -f1))"
