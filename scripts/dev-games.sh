#!/usr/bin/env bash
# Starts the development server and client so full games can be started and watched in the browser at
# http://localhost:5173/viewer (docs/game-viewer.md).
#
# What it sets up, so nothing has to be exported by hand:
#   - the development profile, which is the only one that has the full-games pages;
#   - OPENAI_API_KEY and ANTHROPIC_API_KEY for live games, read from an env file if they are not already
#     in the environment. Only those two lines are read; the file is not sourced and no value is printed.
#     The file defaults to playtest.env (override with AUTOPLAY_ENV). Stand-in games need no keys.
#   - The root .env is not read (override with DIPLOMACY_ENV_FILE): the game pages need nothing from it.
# Live games use the ledger in data/autoplay.sqlite, the same one the autoplay command uses; stand-in games
# use data/autoplay-stand-in.sqlite. Recording a funding grant stays a separate command.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${AUTOPLAY_ENV:-$ROOT/playtest.env}"
for KEY in OPENAI_API_KEY ANTHROPIC_API_KEY; do
  if [ -z "${!KEY:-}" ] && [ -f "$ENV_FILE" ]; then
    # The last assignment of exactly this name; surrounding quotes are dropped.
    VALUE="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$KEY=//p" "$ENV_FILE" | tail -n 1)"
    VALUE="${VALUE%\"}"; VALUE="${VALUE#\"}"; VALUE="${VALUE%\'}"; VALUE="${VALUE#\'}"
    [ -n "$VALUE" ] && export "$KEY=$VALUE"
    unset VALUE
  fi
  if [ -n "${!KEY:-}" ]; then echo "$KEY: found" >&2; else echo "$KEY: not set (live games with that provider will be refused)" >&2; fi
done
export DIPLOMACY_PROFILE=local
export DIPLOMACY_ENV_FILE="${DIPLOMACY_ENV_FILE:-/dev/null}"
echo "Open http://localhost:5173/viewer once the server has started." >&2
cd "$ROOT"
exec npm run dev
