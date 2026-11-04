#!/bin/sh
# Starts the node's Cashu mint (cdk-mintd, the `cashu` profile).
#
# cdk-mintd keeps its configuration in its database. On the first start this
# script generates the mint's seed, writes a TOML document from the
# environment and imports it with `config init`; later starts run the mint as
# configured, and changing the environment has no effect (see
# docs/deployment.md for changing a running mint).
set -eu

DATA=${CDK_MINTD_WORK_DIR:-/data}
BACKEND=${BACKEND:-fakewallet}
MINT_URL=${MINT_URL:-}
MINT_NAME=${MINT_NAME:-Archon mint}
MINT_DESCRIPTION=${MINT_DESCRIPTION:-}
MIN_MINT=${MIN_MINT:-1}
MAX_MINT=${MAX_MINT:-10000}
MIN_MELT=${MIN_MELT:-1}
MAX_MELT=${MAX_MELT:-10000}
INPUT_FEE_PPK=${INPUT_FEE_PPK:-0}
LN_FEE_PERCENT=${LN_FEE_PERCENT:-0.02}
LN_RESERVE_FEE_MIN=${LN_RESERVE_FEE_MIN:-2}
CLN_RPC=${CLN_RPC:-/cln/lightning-rpc}

die() {
    echo "[cashu-mint] ERROR: $*" >&2
    exit 1
}

positive_int() {
    case "$2" in
        ''|*[!0-9]*) die "$1 must be a non-negative integer, not '$2'" ;;
    esac
}

case "$BACKEND" in
    fakewallet|cln) ;;
    *) die "ARCHON_CASHU_MINT_BACKEND must be fakewallet or cln, not '$BACKEND'" ;;
esac
[ -n "$MINT_URL" ] || die "MINT_URL is required"

# The cln backend talks to the node's RPC socket through the relay the CLN
# container opens when ARCHON_CLN_RPC_SHARE=true.
if [ "$BACKEND" = cln ] && [ ! -S "$CLN_RPC" ]; then
    die "no CLN RPC socket at $CLN_RPC; the cln backend needs the lightning profile and ARCHON_CLN_RPC_SHARE=true"
fi

# Secrets and the database are the mint's funds.
umask 077

state=$(cdk-mintd --work-dir "$DATA" config show 2>&1 >/dev/null) && initialized=true || initialized=false

if [ "$initialized" = false ]; then
    # Only a database that was never configured is initialized here. Any other
    # failure to read the configuration must not be met with `config init`.
    case "$state" in
        *"not initialized"*) ;;
        *) die "cannot read the mint configuration: $state" ;;
    esac

    for name in MIN_MINT MAX_MINT MIN_MELT MAX_MELT INPUT_FEE_PPK LN_RESERVE_FEE_MIN; do
        eval "positive_int \"ARCHON_CASHU_MINT_$name\" \"\$$name\""
    done

    # The signing seed: 32 random bytes, hex-encoded. cdk-mintd uses the file's
    # bytes as the BIP32 master seed. With the database, it is what restores
    # the mint.
    if [ ! -s "$DATA/seed" ]; then
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DATA/seed"
        echo "[cashu-mint] Generated a new mint seed in $DATA/seed; back it up"
    fi

    {
        echo '[info]'
        echo "url = \"$MINT_URL\""
        echo 'listen_host = "0.0.0.0"'
        echo 'listen_port = 8085'
        echo "seed = \"file:$DATA/seed\""
        echo "input_fee_ppk = $INPUT_FEE_PPK"
        echo
        echo '[info.logging]'
        echo 'output = "stderr"'
        echo
        echo '[mint_info]'
        echo "name = \"$MINT_NAME\""
        [ -n "$MINT_DESCRIPTION" ] && echo "description = \"$MINT_DESCRIPTION\""
        echo
        echo '[database]'
        echo 'engine = "sqlite"'
        echo
        echo '[payment_backend]'
        echo "backend = \"$BACKEND\""
        echo 'unit = "sat"'
        echo "min_mint = $MIN_MINT"
        echo "max_mint = $MAX_MINT"
        echo "min_melt = $MIN_MELT"
        echo "max_melt = $MAX_MELT"
        echo
        if [ "$BACKEND" = cln ]; then
            echo '[cln]'
            echo "rpc_path = \"$CLN_RPC\""
            echo 'bolt12 = false'
            echo "fee_percent = $LN_FEE_PERCENT"
            echo "reserve_fee_min = $LN_RESERVE_FEE_MIN"
        else
            echo '[fake_wallet]'
            echo "fee_percent = $LN_FEE_PERCENT"
            echo "reserve_fee_min = $LN_RESERVE_FEE_MIN"
            echo 'custom_payment_methods = []'
        fi
    } > "$DATA/mint.toml"

    cdk-mintd --work-dir "$DATA" config validate --file "$DATA/mint.toml"
    cdk-mintd --work-dir "$DATA" config init --new-mint --file "$DATA/mint.toml"
    echo "[cashu-mint] Initialized a $BACKEND mint at $MINT_URL"
fi

exec cdk-mintd --work-dir "$DATA"
