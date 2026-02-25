#!/bin/sh
set -e

RUNE_FILE="${DRAWBRIDGE_RUNE_PATH:-/data/lightning/drawbridge/rune.txt}"
SECRET_FILE="${DRAWBRIDGE_SECRET_PATH:-/data/drawbridge/macaroon-secret.txt}"

# --- Macaroon secret ---
if [ -n "$ARCHON_DRAWBRIDGE_MACAROON_SECRET" ]; then
    echo "[drawbridge] Using macaroon secret from environment"
elif [ -f "$SECRET_FILE" ]; then
    echo "[drawbridge] Loading macaroon secret from $SECRET_FILE"
    export ARCHON_DRAWBRIDGE_MACAROON_SECRET="$(cat "$SECRET_FILE")"
else
    echo "[drawbridge] Generating macaroon secret..."
    mkdir -p "$(dirname "$SECRET_FILE")"
    SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" || {
        echo "[drawbridge] ERROR: Failed to generate macaroon secret"
        exit 1
    }
    if [ -z "$SECRET" ]; then
        echo "[drawbridge] ERROR: Generated empty macaroon secret"
        exit 1
    fi
    echo "$SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    export ARCHON_DRAWBRIDGE_MACAROON_SECRET="$SECRET"
    echo "[drawbridge] Macaroon secret generated and saved to $SECRET_FILE"
fi

# --- CLN rune ---
if [ -f "$RUNE_FILE" ]; then
    echo "[drawbridge] Loading rune from $RUNE_FILE"
    . "$RUNE_FILE"
    export ARCHON_DRAWBRIDGE_CLN_RUNE="$LIGHTNING_RUNE"
elif [ -n "$ARCHON_DRAWBRIDGE_CLN_RUNE" ]; then
    echo "[drawbridge] Using rune from environment"
else
    echo "[drawbridge] WARNING: No rune found — Lightning invoices will not work"
fi

echo "[drawbridge] Starting Drawbridge..."
exec node server/dist/drawbridge-api.js
