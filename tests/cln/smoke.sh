#!/usr/bin/env bash
# Smoke test for ghcr.io/archetech/cln against a regtest bitcoind: clnrest with
# a rune, the planned on-disk layout, a startup failure that must exit rather
# than hang, and a Tor-mode start through the shared Tor image.
#
# Expects the images built as CLN_IMAGE and TOR_IMAGE (see
# .github/workflows/docker-build-test.yml).
# Set KEEP=1 to leave the containers running for inspection after a failure.
set -euo pipefail

CLN_IMAGE=${CLN_IMAGE:-archon-cln-test}
TOR_IMAGE=${TOR_IMAGE:-archon-tor-test}
BITCOIN_IMAGE=ghcr.io/archetech/bitcoin-core:v28.0-multiarch
P=cln-smoke

cleanup() {
    docker rm -f "$P-bitcoind" "$P-cln" "$P-cln-tor" "$P-tor" >/dev/null 2>&1 || true
    docker volume rm "$P-data" "$P-data-tor" "$P-hs" >/dev/null 2>&1 || true
    docker network rm "$P" >/dev/null 2>&1 || true
}
[[ -n "${KEEP:-}" ]] || trap cleanup EXIT
cleanup

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# Retries a command once a second for up to $1 seconds.
retry() {
    local seconds=$1
    shift
    for _ in $(seq "$seconds"); do
        "$@" >/dev/null 2>&1 && return 0
        sleep 1
    done
    "$@"
}

docker network create "$P" >/dev/null

echo "== bitcoind"
docker run -d --name "$P-bitcoind" --network "$P" "$BITCOIN_IMAGE" \
    bitcoind -regtest -server -rpcuser=u -rpcpassword=p -rpcbind=0.0.0.0 \
    -rpcallowip=0.0.0.0/0 -fallbackfee=0.0002 -printtoconsole=0 >/dev/null
btc() { docker exec "$P-bitcoind" bitcoin-cli -regtest -rpcuser=u -rpcpassword=p "$@"; }
retry 60 btc getblockchaininfo >/dev/null
btc createwallet smoke >/dev/null
btc generatetoaddress 101 "$(btc getnewaddress)" >/dev/null

cln_env=(-e NETWORK=regtest -e BITCOIN_RPCHOST="$P-bitcoind" -e BITCOIN_RPCPORT=18443
    -e BITCOIN_RPCUSER=u -e BITCOIN_RPCPASSWORD=p)
rpc=/data/lightning/regtest/regtest/lightning-rpc

echo "== clearnet"
docker run -d --name "$P-cln" --network "$P" -v "$P-data:/data/lightning" -p 127.0.0.1::3001 \
    "${cln_env[@]}" -e NETWORK_MODE=clearnet "$CLN_IMAGE" >/dev/null
retry 120 docker exec "$P-cln" cln-healthcheck || fail "healthcheck did not pass in clearnet mode"

docker exec "$P-cln" test -S "$rpc" || fail "RPC socket is not at $rpc"
docker exec "$P-cln" test -f /data/lightning/regtest/regtest/hsm_secret || fail "hsm_secret is not in the network directory"
docker exec "$P-cln" test -f /data/lightning/regtest/lightningd.sqlite3 || fail "wallet is not in the lightning dir"
docker exec "$P-cln" test ! -e /data/lightning/regtest/regtest/lightningd.sqlite3 || fail "a second wallet exists in the network directory"
[[ "$(docker exec "$P-cln" stat -c %a /data/lightning/regtest/config)" == 600 ]] || fail "config is not owner-only"

rune=$(docker exec "$P-cln" lightning-cli --rpc-file="$rpc" createrune | jq -er .rune)
port=$(docker port "$P-cln" 3001 | head -n 1 | cut -d: -f2)
rest() { curl -skf -X POST "https://127.0.0.1:$port/v1/$1" -H "Rune: $rune" -H 'Content-Type: application/json' -d "${2:-{\}}"; }
rest getinfo | jq -e '.id | length == 66' >/dev/null || fail "getinfo over clnrest"
rest invoice '{"amount_msat":1000,"label":"smoke","description":"smoke"}' |
    jq -e '.bolt11 | startswith("lnbcrt")' >/dev/null || fail "invoice over clnrest"

echo "== startup failure"
docker rm -f "$P-cln" >/dev/null
status=0
timeout 120 docker run --rm --network "$P" -v "$P-data:/data/lightning" \
    "${cln_env[@]}" -e NETWORK_MODE=clearnet "$CLN_IMAGE" --not-an-option >/dev/null 2>&1 || status=$?
[[ $status -ne 0 ]] || fail "an invalid option did not stop the container"
[[ $status -ne 124 ]] || fail "the container hung after lightningd failed to start"

echo "== tor"
docker run -d --name "$P-tor" --network "$P" --network-alias tor -v "$P-hs:/var/lib/tor/hidden_service" \
    -e TOR_SERVICES="cln:$P-cln-tor:9736" "$TOR_IMAGE" >/dev/null
docker run -d --name "$P-cln-tor" --network "$P" -v "$P-data-tor:/data/lightning" \
    -v "$P-hs:/tor-hs:ro" -e TOR_HS_DIR=/tor-hs/cln \
    "${cln_env[@]}" -e NETWORK_MODE=tor "$CLN_IMAGE" >/dev/null
tor_rpc() { docker exec "$P-cln-tor" lightning-cli --rpc-file="$rpc" "$@"; }
retry 180 tor_rpc getinfo >/dev/null || fail "lightningd did not start in tor mode"

onion=$(docker exec "$P-tor" cat /var/lib/tor/hidden_service/cln/hostname)
tor_rpc getinfo | jq -e --arg onion "$onion" '.address | any(.type == "torv3" and .address == $onion)' >/dev/null ||
    fail "tor mode does not announce $onion"
tor_rpc listconfigs | jq -e '.configs.proxy.value_str == "127.0.0.1:9050" and .configs["always-use-proxy"].value_bool' >/dev/null ||
    fail "tor mode is not proxying through the relay"
# A SOCKS5 greeting through the relay must be answered by Tor.
reply=$(docker exec "$P-cln-tor" bash -c "printf '\\x05\\x01\\x00' | socat -t 3 - TCP:127.0.0.1:9050 | od -An -tx1" | tr -d ' \n')
[[ "$reply" == 0500 ]] || fail "the relay did not reach Tor (got '$reply')"

echo "PASS"
