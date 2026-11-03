#!/usr/bin/env bash
# Healthy when lightningd answers on its RPC socket and, in tor and hybrid
# modes, its onion accepts a connection through Tor. A hostname only shows the
# onion service is configured; peers need it to be reachable, and that is
# reported here rather than by whether the node started.
set -euo pipefail

NETWORK=${NETWORK:-bitcoin}
NETWORK_MODE=${NETWORK_MODE:-tor}
LIGHTNING_PORT=${LIGHTNING_PORT:-9736}
LIGHTNING_ROOT=${LIGHTNING_ROOT:-/data/lightning}
TOR_HOST=${TOR_HOST:-tor}
TOR_HS_DIR=${TOR_HS_DIR:-/tor/cln-service}

lightning-cli --rpc-file="$LIGHTNING_ROOT/$NETWORK/$NETWORK/lightning-rpc" getinfo >/dev/null

if [[ "$NETWORK_MODE" != clearnet ]]; then
    onion=$(tr -d '[:space:]' < "$TOR_HS_DIR/hostname")
    socat -T 20 /dev/null "SOCKS4A:$TOR_HOST:$onion:$LIGHTNING_PORT,socksport=9050"
fi
