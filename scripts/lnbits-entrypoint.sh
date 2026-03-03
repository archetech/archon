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
    echo "[lnbits] Waiting for CLN REST at $CLNREST_URL..."
    timeout=120; elapsed=0
    while ! python3 -c "
import urllib.request, ssl
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
urllib.request.urlopen('$CLNREST_URL', context=ctx, timeout=3)
" >/dev/null 2>&1; do
        sleep 2; elapsed=$((elapsed + 2))
        if [ $elapsed -ge $timeout ]; then
            echo "[lnbits] WARNING: CLN REST not ready after ${timeout}s, starting anyway"
            break
        fi
    done
    if [ $elapsed -lt $timeout ]; then
        echo "[lnbits] CLN REST is ready"
    fi
fi

# --- Patch: fix internal payment balance zeroing (lnbits/lnbits#3817) ---
TASKS_FILE="$(find / -path '*/lnbits/tasks.py' -not -path '*/test*' 2>/dev/null | head -1)"
if [ -f "$TASKS_FILE" ] && grep -q "payment.fee = status.fee_msat" "$TASKS_FILE" && ! grep -q "if not is_internal:" "$TASKS_FILE"; then
    echo "[lnbits] Applying patch #3817 (internal payment fix)..."
    python3 -c "
with open('$TASKS_FILE', 'r') as f:
    content = f.read()
old = '''    from lnbits.core.services.payments import check_payment_status

    status = await check_payment_status(
        payment, skip_internal_payment_notifications=True
    )
    payment.fee = status.fee_msat or payment.fee
    # only overwrite preimage if status.preimage provides it
    payment.preimage = status.preimage or payment.preimage
    payment.status = PaymentState.SUCCESS'''
new = '''    if not is_internal:
        from lnbits.core.services.payments import check_payment_status

        status = await check_payment_status(
            payment, skip_internal_payment_notifications=True
        )
        payment.fee = status.fee_msat or payment.fee
        # only overwrite preimage if status.preimage provides it
        payment.preimage = status.preimage or payment.preimage
    payment.status = PaymentState.SUCCESS'''
if old in content:
    with open('$TASKS_FILE', 'w') as f:
        f.write(content.replace(old, new))
    print('[lnbits] Patch #3817 applied successfully')
else:
    print('[lnbits] Patch #3817 already applied or code changed, skipping')
"
else
    echo "[lnbits] Patch #3817 not needed, skipping"
fi

echo "[lnbits] Starting LNbits..."
exec uv run lnbits --host "$LNBITS_HOST" --port "$LNBITS_PORT"
