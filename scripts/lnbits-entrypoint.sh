#!/bin/sh
set -e

RUNE_FILE="${LNBITS_RUNE_PATH:-/data/lightning/lnbits/runes.env}"

# --- CLN runes ---
if [ -n "$CLNREST_READONLY_RUNE" ] && [ -n "$CLNREST_INVOICE_RUNE" ] && [ -n "$CLNREST_PAY_RUNE" ]; then
    echo "[lnbits] Using runes from environment"
elif [ -f "$RUNE_FILE" ]; then
    echo "[lnbits] Loading runes from $RUNE_FILE"
    . "$RUNE_FILE"
    export CLNREST_READONLY_RUNE
    export CLNREST_INVOICE_RUNE
    export CLNREST_PAY_RUNE
else
    echo "[lnbits] WARNING: No runes found — CLN backend will not work"
fi

# --- Auth secret ---
SECRET_FILE="/data/lnbits/auth-secret.txt"

if [ -n "$AUTH_SECRET_KEY" ]; then
    echo "[lnbits] Using auth secret from environment"
elif [ -f "$SECRET_FILE" ]; then
    echo "[lnbits] Loading auth secret from $SECRET_FILE"
    export AUTH_SECRET_KEY="$(cat "$SECRET_FILE")"
else
    echo "[lnbits] Generating auth secret..."
    mkdir -p "$(dirname "$SECRET_FILE")"
    SECRET="$(python3 -c "import secrets; print(secrets.token_hex(32))")"
    echo "$SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    export AUTH_SECRET_KEY="$SECRET"
    echo "[lnbits] Auth secret generated and saved to $SECRET_FILE"
fi

# --- Wait for CLN REST ---
if [ -n "$CLNREST_URL" ]; then
    if [ -z "$CLNREST_READONLY_RUNE" ]; then
        echo "[lnbits] ERROR: CLNREST_READONLY_RUNE is required for CLNRestWallet"
        exit 1
    fi

    echo "[lnbits] Waiting for CLN REST at $CLNREST_URL/v1/listfunds..."
    timeout=120; elapsed=0
    while ! python3 -c "
import urllib.request, ssl, os, json
cafile = os.environ.get('CLNREST_CA')
if cafile and os.path.isfile(cafile):
    ctx = ssl.create_default_context(cafile=cafile)
else:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
req = urllib.request.Request(
    '$CLNREST_URL/v1/listfunds',
    data=b'{}',
    headers={
        'Content-Type': 'application/json',
        'rune': os.environ['CLNREST_READONLY_RUNE'],
    },
    method='POST',
)
with urllib.request.urlopen(req, context=ctx, timeout=3) as resp:
    json.load(resp)
" >/dev/null 2>&1; do
        sleep 2; elapsed=$((elapsed + 2))
        if [ $elapsed -ge $timeout ]; then
            echo "[lnbits] ERROR: CLN REST not ready after ${timeout}s"
            exit 1
        fi
    done
    echo "[lnbits] CLN REST is ready"
fi

echo "[lnbits] Starting LNbits..."
exec uv run lnbits --host "$LNBITS_HOST" --port "$LNBITS_PORT"
