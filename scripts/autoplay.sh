#!/usr/bin/env bash
# Runs the autoplay tool (docs/autoplay.md) on this machine with a ready environment.
#
#   scripts/autoplay.sh --run RUN_ID [--until 1908] [--live --authorization-ref REF] [other autoplay options]
#
# What it sets up, so nothing has to be exported by hand:
#   - the development profile (the tool refuses anything else);
#   - the database data/autoplay.sqlite, created on first use (override with AUTOPLAY_DB);
#   - for --live only: OPENAI_API_KEY and ANTHROPIC_API_KEY, read from an env file if they are not
#     already in the environment. Only those two lines are read; the file is not sourced and no value
#     is printed. The file defaults to playtest.env (override with AUTOPLAY_ENV).
# It never records a funding grant: that is the owner's authorization and stays a separate command.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${AUTOPLAY_DB:-$ROOT/data/autoplay.sqlite}"
ENV_FILE="${AUTOPLAY_ENV:-$ROOT/playtest.env}"
CLI="$ROOT/server/dist/autoplay/cli.js"
[ -f "$CLI" ] || { echo "Build first: npm run build" >&2; exit 2; }

LIVE=0
for ARG in "$@"; do
  [ "$ARG" = --live ] && LIVE=1
  [ "$ARG" = --db ] && { echo "The database is $DB; set AUTOPLAY_DB to use another." >&2; exit 2; }
done

if [ "$LIVE" = 1 ]; then
  for KEY in OPENAI_API_KEY ANTHROPIC_API_KEY; do
    if [ -z "${!KEY:-}" ] && [ -f "$ENV_FILE" ]; then
      # The last assignment of exactly this name; surrounding quotes are dropped.
      VALUE="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$KEY=//p" "$ENV_FILE" | tail -n 1)"
      VALUE="${VALUE%\"}"; VALUE="${VALUE#\"}"; VALUE="${VALUE%\'}"; VALUE="${VALUE#\'}"
      [ -n "$VALUE" ] && export "$KEY=$VALUE"
      unset VALUE
    fi
    if [ -n "${!KEY:-}" ]; then echo "$KEY: found" >&2; else echo "$KEY: not set (needed only if a power uses that provider)" >&2; fi
  done
fi

if [ ! -f "$DB" ]; then
  mkdir -p "$(dirname "$DB")"
  node "$ROOT/server/dist/storage/cli.js" init "$DB" >/dev/null
  echo "Created $DB. Record a funding grant before a game can start:" >&2
  echo "  npm run storage -- grant \"$DB\" <usd> <your-reference>" >&2
fi
export DIPLOMACY_PROFILE=local
exec node "$CLI" --db "$DB" "$@"
