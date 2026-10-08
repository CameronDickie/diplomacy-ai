#!/usr/bin/env bash
# Runs the evaluation harness, or the storage tool for its ledger, inside the production image
# with the ledger on a dedicated named volume.
#
#   scripts/evaluate-in-container.sh VOLUME storage  init|funding|held|grant ... (database path is supplied)
#   scripts/evaluate-in-container.sh VOLUME evaluate --run RUN_ID [--preset luna|haiku] [--attempts N] ...
#
# What the container is allowed:
#   - a read-only root filesystem, no Linux capabilities, no privilege escalation, bounded memory and processes;
#   - write access to the one volume only (the ledger and any --out report under /data);
#   - NO network at all unless --live is given;
#   - with --live, the network and exactly one provider key: the one the chosen preset uses.
#     The key is passed by name from this shell's environment and never appears on a command line.
# The ledger still bounds spend: a live run needs a funding grant recorded in this volume's database.
set -euo pipefail

DOCKER="${DOCKER:-docker}"
IMAGE="${EVALUATION_IMAGE:-diplomacy-evaluation:local}"
DB=/data/evaluation.sqlite
usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

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
  *) usage;;
esac
