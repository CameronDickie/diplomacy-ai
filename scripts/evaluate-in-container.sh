#!/usr/bin/env bash
# Runs the evaluation harness, or the storage tool for its ledger, inside the production image
# with the ledger on a dedicated named volume.
#
#   scripts/evaluate-in-container.sh VOLUME storage  init|funding|held|grant ... (database path is supplied)
#   scripts/evaluate-in-container.sh VOLUME evaluate --run RUN_ID [--preset luna|haiku] [--attempts N] ...
#   scripts/evaluate-in-container.sh VOLUME autoplay --run RUN_ID [--until 1908] [--models ...] [--live --authorization-ref REF]
#   scripts/evaluate-in-container.sh VOLUME fetch    autoplay-RUN_ID.json > autoplay-RUN_ID.json
#
# What the container is allowed:
#   - a read-only root filesystem, no Linux capabilities, no privilege escalation, bounded memory and processes;
#   - write access to the one volume only (the ledger and any --out report under /data);
#   - NO network at all unless --live is given;
#   - with --live, the network and exactly one provider key: the one the chosen preset uses.
#     The key is passed by name from this shell's environment and never appears on a command line.
#     A full game (autoplay) uses both models by default, so it is given both keys.
# The ledger still bounds spend: a live run needs a funding grant recorded in this volume's database.
set -euo pipefail

DOCKER="${DOCKER:-docker}"
IMAGE="${EVALUATION_IMAGE:-diplomacy-evaluation:local}"
DB=/data/evaluation.sqlite
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

[ $# -ge 2 ] || usage
VOLUME="$1"; MODE="$2"; shift 2
case "$VOLUME" in ''|*[!A-Za-z0-9_.-]*) echo "Volume name must be letters, digits, dot, dash or underscore." >&2; exit 2;; esac

if [ -z "${EVALUATION_IMAGE:-}" ]; then
  "$DOCKER" build --quiet --tag "$IMAGE" "$(cd "$(dirname "$0")/.." && pwd)" >/dev/null
fi
"$DOCKER" volume create "$VOLUME" >/dev/null

RUN=("$DOCKER" run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 256 --memory 1g --volume "$VOLUME:/data" --env DIPLOMACY_PROFILE=local --entrypoint node)

case "$MODE" in
  storage)
    [ $# -ge 1 ] || usage
    COMMAND="$1"; shift
    exec "${RUN[@]}" --network none "$IMAGE" server/dist/storage/cli.js "$COMMAND" "$DB" "$@"
    ;;
  evaluate)
    LIVE=0; PRESET=luna; PREVIOUS=
    for ARG in "$@"; do
      [ "$ARG" = --live ] && LIVE=1
      [ "$ARG" = --db ] && { echo "The database path is fixed inside the volume; do not pass --db." >&2; exit 2; }
      [ "$PREVIOUS" = --preset ] && PRESET="$ARG"
      case "$ARG" in --preset=*) PRESET="${ARG#--preset=}";; esac
      PREVIOUS="$ARG"
    done
    if [ "$LIVE" = 1 ]; then
      case "$PRESET" in
        haiku) KEY=ANTHROPIC_API_KEY;;
        luna) KEY=OPENAI_API_KEY;;
        *) echo "Unknown preset: $PRESET" >&2; exit 2;;
      esac
      [ -n "${!KEY:-}" ] || { echo "A live $PRESET run needs $KEY in this shell's environment." >&2; exit 2; }
      exec "${RUN[@]}" --env "$KEY" "$IMAGE" server/dist/evaluation/cli.js --db "$DB" "$@"
    fi
    exec "${RUN[@]}" --network none "$IMAGE" server/dist/evaluation/cli.js --db "$DB" "$@"
    ;;
  autoplay)
    # A full game with a model on every power (docs/autoplay.md). Its record is written into the volume.
    LIVE=0; RUNID=; OUT=0; PREVIOUS=
    for ARG in "$@"; do
      [ "$ARG" = --live ] && LIVE=1
      [ "$ARG" = --db ] && { echo "The database path is fixed inside the volume; do not pass --db." >&2; exit 2; }
      [ "$ARG" = --out ] && OUT=1
      [ "$PREVIOUS" = --run ] && RUNID="$ARG"
      case "$ARG" in --run=*) RUNID="${ARG#--run=}";; --out=*) OUT=1;; esac
      PREVIOUS="$ARG"
    done
    case "$RUNID" in ''|*[!a-z0-9-]*) echo "Give --run RUN_ID (lowercase letters, digits, dashes)." >&2; exit 2;; esac
    [ "$OUT" = 1 ] && { echo "The record is written to the volume as autoplay-$RUNID.json; do not pass --out. Copy it out with the fetch mode." >&2; exit 2; }
    if [ "$LIVE" = 1 ]; then
      KEYS=()
      for KEY in OPENAI_API_KEY ANTHROPIC_API_KEY; do [ -n "${!KEY:-}" ] && KEYS+=(--env "$KEY"); done
      [ ${#KEYS[@]} -gt 0 ] || { echo "A live game needs OPENAI_API_KEY and/or ANTHROPIC_API_KEY in this shell's environment." >&2; exit 2; }
      exec "${RUN[@]}" --init --interactive "${KEYS[@]}" "$IMAGE" server/dist/autoplay/cli.js --db "$DB" --out "/data/autoplay-$RUNID.json" "$@"
    fi
    exec "${RUN[@]}" --init --interactive --network none "$IMAGE" server/dist/autoplay/cli.js --db "$DB" --out "/data/autoplay-$RUNID.json" "$@"
    ;;
  fetch)
    # Prints one file from the volume, for example a game record, so it can be redirected to a local file.
    [ $# -eq 1 ] || usage
    case "$1" in ''|*[!A-Za-z0-9_.-]*|.*) echo "Name a file in the volume, for example autoplay-RUN_ID.json." >&2; exit 2;; esac
    exec "${RUN[@]}" --network none --entrypoint cat "$IMAGE" "/data/$1"
    ;;
  *) usage;;
esac
