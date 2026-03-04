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
if [ -n "$ARCHON_DRAWBRIDGE_CLN_RUNE" ]; then
    echo "[drawbridge] Using rune from environment"
elif [ -f "$RUNE_FILE" ]; then
    echo "[drawbridge] Loading rune from $RUNE_FILE"
    . "$RUNE_FILE"
    export ARCHON_DRAWBRIDGE_CLN_RUNE="$LIGHTNING_RUNE"
else
    echo "[drawbridge] WARNING: No rune found — Lightning invoices will not work"
fi

# --- Public host (Tor fallback) ---
if [ -n "$ARCHON_DRAWBRIDGE_PUBLIC_HOST" ]; then
    echo "[drawbridge] Using public host from environment: $ARCHON_DRAWBRIDGE_PUBLIC_HOST"
else
    TOR_HOSTNAME_FILE="/data/tor/hostname"
    if [ -f "$TOR_HOSTNAME_FILE" ]; then
        ONION_HOST="$(cat "$TOR_HOSTNAME_FILE" | tr -d '[:space:]')"
        export ARCHON_DRAWBRIDGE_PUBLIC_HOST="http://${ONION_HOST}:${ARCHON_DRAWBRIDGE_PORT:-4222}"
        echo "[drawbridge] Using Tor address as public host: $ARCHON_DRAWBRIDGE_PUBLIC_HOST"
    else
        echo "[drawbridge] No public host configured (no ARCHON_DRAWBRIDGE_PUBLIC_HOST or Tor hostname)"
    fi
fi

echo "[drawbridge] Starting Drawbridge..."
exec node server/dist/drawbridge-api.js
