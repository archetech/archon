#!/bin/sh
set -e

RUNE_FILE="${LIGHTNING_MEDIATOR_RUNE_PATH:-/data/lightning/drawbridge/rune.txt}"

if [ -n "$ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE" ]; then
    echo "[lightning-mediator] Using CLN rune from environment"
elif [ -f "$RUNE_FILE" ]; then
    echo "[lightning-mediator] Loading CLN rune from $RUNE_FILE"
    # shellcheck disable=SC1090
    . "$RUNE_FILE"
    export ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE="${ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE:-${LIGHTNING_RUNE:-}}"
else
    echo "[lightning-mediator] No bundled CLN rune found at $RUNE_FILE"
fi

exec node dist/lightning-mediator.js
