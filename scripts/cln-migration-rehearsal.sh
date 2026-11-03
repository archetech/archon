#!/usr/bin/env bash
# Rehearses moving a bundled Lightning node from the cl-hive image to
# ghcr.io/archetech/cln on regtest (#1509). Run by hand from a checkout; it
# pulls the old images and takes several minutes.
#
#   1. migration: per cl-hive version, two nodes with a channel and a payment;
#      node A moves to the new image on the same data, keeps its id, wallet
#      and channel, and pays in both directions.
#   2. tor: a tor-mode cl-hive node moves to the new image and the shared Tor
#      image and keeps its onion address, which then answers.
#   3. compose: the lightning and tor profiles start from empty data with
#      every rune container completing; switching to clearnet retires the
#      onion; a Tor crash recovers by itself.
#
# Everything is named cln-rehearsal-*, publishes no host ports and is removed
# on exit (KEEP=1 leaves it for inspection). The compose part runs a copy of
# the compose files in a temporary directory, so its data/ is that
# directory's and never this checkout's, which may hold a live node.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSIONS=${VERSIONS:-3.4.0 3.1.0}
CLN_IMAGE=${CLN_IMAGE:-ghcr.io/archetech/cln}
TOR_IMAGE=${TOR_IMAGE:-ghcr.io/archetech/tor}
BITCOIN_IMAGE=ghcr.io/archetech/bitcoin-core:v28.0-multiarch
P=cln-rehearsal
NET=$P
work=$(mktemp -d)
cp docker-compose.yml "$work/"
mkdir -p "$work/docker"
cp -r docker/compose "$work/docker/"
# Runs the Lightning services on regtest against the rehearsal's bitcoind,
# with no host ports. The rune containers read the mainnet socket and
# certificate paths, so the regtest network directory is mounted there.
cat > "$work/rehearsal.yml" <<YAML
x-regtest-socket: &regtest-socket
  volumes:
    - $work/data/cln-mainnet/regtest/regtest:/data/lightning/bitcoin/bitcoin

services:
  cln-mainnet-node:
    image: $CLN_IMAGE
    environment:
      - NETWORK=regtest
      - BITCOIN_RPCHOST=$P-bitcoind
      - BITCOIN_RPCPORT=18443
      - BITCOIN_RPCUSER=u
      - BITCOIN_RPCPASSWORD=p
    ports: !reset []
    networks:
      - rehearsal
  drawbridge-init:
    image: $CLN_IMAGE
    <<: *regtest-socket
  rtl-init:
    image: $CLN_IMAGE
    <<: *regtest-socket
  lnbits-init:
    image: $CLN_IMAGE
    <<: *regtest-socket
  tor:
    image: $TOR_IMAGE
    ports: !reset []

networks:
  rehearsal:
    name: $NET
    external: true
YAML
COMPOSE=(compose -p "$P" --project-directory "$work" -f "$work/docker-compose.yml" -f "$work/rehearsal.yml")

# docker compose, without its warnings about the many unrelated variables a
# checkout without .env leaves unset.
compose() {
    docker compose "$@" 2> >(grep -v 'level=warning' >&2)
}

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() {
    echo "FAIL: $*" >&2
    exit 1
}

cleanup() {
    COMPOSE_PROFILES=lightning,tor "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    docker ps -aq --filter "name=^$P-" | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker volume ls -q --filter "name=^$P-" | xargs -r docker volume rm >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    # The compose part writes root-owned files into the temporary directory.
    docker run --rm -v "$work:/work" alpine:3.22 rm -rf /work/data >/dev/null 2>&1 || true
}
if [[ -n "${KEEP:-}" ]]; then
    echo "Keeping everything; the compose copy is in $work"
else
    trap 'cleanup; rm -rf "$work"' EXIT
fi

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

cleanup
docker network create "$NET" >/dev/null

log "bitcoind"
docker run -d --name "$P-bitcoind" --network "$NET" "$BITCOIN_IMAGE" \
    bitcoind -regtest -server -rpcuser=u -rpcpassword=p -rpcbind=0.0.0.0 \
    -rpcallowip=0.0.0.0/0 -fallbackfee=0.0002 -printtoconsole=0 >/dev/null
btc() { docker exec "$P-bitcoind" bitcoin-cli -regtest -rpcuser=u -rpcpassword=p "$@"; }
retry 60 btc getblockchaininfo >/dev/null
btc createwallet rehearsal >/dev/null
mine() { btc generatetoaddress "$1" "$(btc getnewaddress)" >/dev/null; }
mine 101

node_env=(-e NETWORK=regtest -e BITCOIN_RPCHOST="$P-bitcoind" -e BITCOIN_RPCPORT=18443
    -e BITCOIN_RPCUSER=u -e BITCOIN_RPCPASSWORD=p -e LIGHTNING_PORT=9736 -e BOLTZ_ENABLED=false)
rpc=/data/lightning/regtest/regtest/lightning-rpc
cli() {
    local node=$1
    shift
    docker exec "$P-$node" lightning-cli --rpc-file="$rpc" "$@"
}

# Starts node $1 from image $2 on volume $P-$1, with any further docker args.
start_node() {
    local node=$1 image=$2
    shift 2
    docker run -d --name "$P-$node" --network "$NET" --stop-timeout 120 \
        -v "$P-$node:/data/lightning" "${node_env[@]}" "$@" "$image" >/dev/null
    retry 300 cli "$node" getinfo >/dev/null || fail "$node did not start on $image"
}

wait_synced() {
    local height
    height=$(btc getblockcount)
    for node in "$@"; do
        retry 120 bash -c "[[ \$(docker exec $P-$node lightning-cli --rpc-file=$rpc getinfo | jq .blockheight) -ge $height ]]" ||
            fail "$node did not sync to $height"
    done
}

channel_state() { cli "$1" listpeerchannels | jq -r '.channels[0].state // "none"'; }

# Pays $4 msat (default 1000 sat) from node $1 to node $2.
pay() {
    local from=$1 to=$2 label=$3 msat=${4:-1000000}
    local bolt11
    bolt11=$(cli "$to" invoice "$msat" "$label" "$label" | jq -r .bolt11)
    retry 60 cli "$from" pay "$bolt11" >/dev/null || fail "$from could not pay $to ($label)"
    [[ "$(cli "$to" listinvoices "$label" | jq -r '.invoices[0].status')" == paid ]] || fail "$to's invoice $label is not paid"
}

for version in $VERSIONS; do
    old=ghcr.io/lightning-goats/cl-hive-node:$version
    log "migration from cl-hive $version"
    docker pull -q "$old" >/dev/null
    start_node a "$old" -e NETWORK_MODE=clearnet -e ALIAS=rehearsal-a
    start_node b "$old" -e NETWORK_MODE=clearnet -e ALIAS=rehearsal-b

    btc sendtoaddress "$(cli a newaddr | jq -r .bech32)" 1 >/dev/null
    mine 1
    wait_synced a b
    cli a connect "$(cli b getinfo | jq -r .id)" "$P-b" 9736 >/dev/null
    retry 60 cli a fundchannel "$(cli b getinfo | jq -r .id)" 1000000 >/dev/null || fail "fundchannel"
    mine 6
    wait_synced a b
    retry 120 bash -c "[[ \$(docker exec $P-a lightning-cli --rpc-file=$rpc listpeerchannels | jq -r '.channels[0].state') == CHANNELD_NORMAL ]]" ||
        fail "the channel did not reach CHANNELD_NORMAL on cl-hive $version"
    # Enough for b to clear its channel reserve and pay back after the switch.
    pay a b "before-$version" 50000000

    id=$(cli a getinfo | jq -r .id)
    channel=$(cli a listpeerchannels | jq -r '.channels[0].short_channel_id')

    log "switching node a to $CLN_IMAGE"
    docker stop "$P-a" >/dev/null
    docker rm "$P-a" >/dev/null
    start_node a "$CLN_IMAGE" -e NETWORK_MODE=clearnet -e ALIAS=rehearsal-a

    [[ "$(cli a getinfo | jq -r .id)" == "$id" ]] || fail "node id changed"
    docker exec "$P-a" test -f /data/lightning/regtest/lightningd.sqlite3 || fail "wallet moved"
    docker exec "$P-a" test ! -e /data/lightning/regtest/regtest/lightningd.sqlite3 || fail "a second wallet was created"
    docker exec "$P-a" test -f /data/lightning/regtest/config.cl-hive.bak || fail "the cl-hive config was not kept"
    [[ "$(cli a listpeerchannels | jq -r '.channels[0].short_channel_id')" == "$channel" ]] || fail "channel changed"
    cli a connect "$(cli b getinfo | jq -r .id)" "$P-b" 9736 >/dev/null || true
    retry 120 bash -c "[[ \$(docker exec $P-a lightning-cli --rpc-file=$rpc listpeerchannels | jq -r '.channels[0].peer_connected') == true ]]" ||
        fail "the peer did not reconnect"
    [[ "$(channel_state a)" == CHANNELD_NORMAL ]] || fail "channel is $(channel_state a) after the switch"
    pay a b "after-ab-$version"
    pay b a "after-ba-$version"
    log "cl-hive $version: id, wallet and channel kept; paid both ways"

    docker rm -f "$P-a" "$P-b" >/dev/null
    docker volume rm "$P-a" "$P-b" >/dev/null
done

log "tor-mode migration"
old=ghcr.io/lightning-goats/cl-hive-node:${VERSIONS%% *}
# The cl-hive image keeps its Tor state, including the onion key, in
# /var/lib/tor; the compose file mounts data/cln-mainnet/tor there.
start_node c "$old" -e NETWORK_MODE=tor -v "$P-c-tor:/var/lib/tor"
onion=$(cli c getinfo | jq -r '.address[] | select(.type == "torv3") | .address')
[[ -n "$onion" ]] || fail "the cl-hive node announced no onion"
docker stop "$P-c" >/dev/null
docker rm "$P-c" >/dev/null

# The shared Tor serves the key directory cl-hive's Tor created, as the
# compose file's bind mount of data/cln-mainnet/tor/cln-service does, and the
# node reads the hostname from it.
key_dir=type=volume,src=$P-c-tor,volume-subpath=cln-service
docker run -d --name "$P-tor" --network "$NET" --network-alias tor \
    --mount "$key_dir,dst=/var/lib/tor/hidden_service/cln" \
    -e TOR_SERVICES="cln:$P-c:9736" "$TOR_IMAGE" >/dev/null
start_node c "$CLN_IMAGE" -e NETWORK_MODE=tor --mount "$key_dir,dst=/tor/cln-service,readonly"
after=$(cli c getinfo | jq -r '.address[] | select(.type == "torv3") | .address')
[[ "$after" == "$onion" ]] || fail "onion changed from $onion to $after"
log "waiting for $onion to answer through Tor"
retry 600 docker exec "$P-c" cln-healthcheck || fail "$onion did not become reachable"
log "tor: kept $onion, and it answers"
docker rm -f "$P-c" "$P-tor" >/dev/null

log "compose: lightning,tor from empty data"
COMPOSE_PROFILES=lightning,tor \
    "${COMPOSE[@]}" up -d --no-build tor cln-mainnet-node drawbridge-init rtl-init lnbits-init >/dev/null
for init in drawbridge-init rtl-init lnbits-init; do
    retry 600 bash -c "[[ \$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' $P-$init-1) == 'exited 0' ]]" ||
        fail "$init did not complete"
done
for file in drawbridge/rune.txt rtl/rune.txt lnbits/runes.env; do
    docker run --rm -v "$work/data:/data:ro" alpine:3.22 grep -q '="[^"]\+"' "/data/cln-mainnet/$file" ||
        fail "$file has no rune"
done
node=$P-cln-mainnet-node-1
retry 900 docker exec "$node" cln-healthcheck || fail "the compose node's onion did not answer"
compose_onion=$(docker exec "$node" cat /tor/cln-service/hostname)
log "compose: every rune container completed; $compose_onion answers"

log "compose: killing the Tor process"
docker exec "$P-tor-1" pkill -x tor
retry 120 bash -c "[[ \$(docker inspect -f '{{.RestartCount}}' $P-tor-1) -ge 1 && \$(docker inspect -f '{{.State.Running}}' $P-tor-1) == true ]]" ||
    fail "tor did not restart"
retry 600 docker exec "$node" cln-healthcheck || fail "CLN did not recover after Tor restarted"
log "compose: tor restarted and the onion answers again"

log "compose: switching to clearnet without the tor profile"
"${COMPOSE[@]}" rm -sf tor >/dev/null
COMPOSE_PROFILES=lightning ARCHON_CLN_NETWORK_MODE=clearnet \
    "${COMPOSE[@]}" up -d --no-build cln-mainnet-node >/dev/null
retry 300 docker exec "$node" cln-healthcheck || fail "the clearnet node is not healthy"
docker exec "$node" lightning-cli --rpc-file=/data/lightning/regtest/regtest/lightning-rpc getinfo |
    jq -e '.address | length == 0' >/dev/null || fail "the clearnet node still announces an address"
# A separate Tor client must no longer reach the old onion.
docker run -d --name "$P-probe" --network "$NET" "$TOR_IMAGE" >/dev/null
retry 120 docker exec "$P-probe" nc -z 127.0.0.1 9050 || fail "probe Tor did not start"
sleep 60
if docker run --rm --network "container:$P-probe" --entrypoint socat "$CLN_IMAGE" -T 30 /dev/null \
    "SOCKS4A:127.0.0.1:$compose_onion:9736,socksport=9050" >/dev/null 2>&1; then
    fail "$compose_onion still answers after the switch to clearnet"
fi
log "compose: clearnet, and the old onion no longer answers"

log "PASS"
