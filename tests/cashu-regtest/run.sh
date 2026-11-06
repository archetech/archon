#!/usr/bin/env bash
# The Cashu wallet against real Lightning: regtest CLN nodes, LNbits, Drawbridge, the
# DIDComm relay and the mint on its cln backend, with both Keymaster flavors. See
# README.md. Set KEEP=1 to leave the stack running, SKIP_BUILD=1 to reuse the images.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cd "$here"

dc() { docker compose -f compose.yml "$@"; }
rpc=/data/lightning/regtest/regtest/lightning-rpc
ln() { local node=$1; shift; dc exec -T "$node" lightning-cli --rpc-file="$rpc" "$@"; }
btc() { dc exec -T bitcoind bitcoin-cli -regtest -rpcuser=u -rpcpassword=p "$@"; }
nodes=(cln-user cln-mint cln-hop cln-payee)

retry() {
    local seconds=$1
    shift
    for _ in $(seq "$seconds"); do
        "$@" >/dev/null 2>&1 && return 0
        sleep 1
    done
    "$@"
}

cleanup() {
    [[ -n "${KEEP:-}" ]] || dc down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ -z "${SKIP_BUILD:-}" ]]; then
    echo "== images, under private tags"
    (cd "$root" && node scripts/prefetch-prebuilds.mjs >/dev/null 2>&1 || true)
    for name in gatekeeper-ts keymaster-ts keymaster-py drawbridge lightning-mediator didcomm cli cln; do
        echo "   $name"
        docker build -q -f "$root/docker/Dockerfile.$name" -t "cashu-regtest/$name:local" "$root" >/dev/null
    done
fi

dc down -v --remove-orphans >/dev/null 2>&1 || true

echo "== bitcoin"
dc up -d bitcoind "${nodes[@]}" redis ipfs gatekeeper didcomm cli >/dev/null 2>&1
retry 60 btc getblockchaininfo
btc createwallet regtest >/dev/null
mining=$(btc getnewaddress)
mine() { btc generatetoaddress "$1" "$mining" >/dev/null; }
synced() {
    local height
    height=$(btc getblockcount)
    for node in "${nodes[@]}"; do
        for _ in $(seq 120); do
            [[ "$(ln "$node" getinfo | jq .blockheight)" -ge "$height" ]] && break
            sleep 1
        done
    done
}
mine 110
for node in "${nodes[@]}"; do retry 120 ln "$node" getinfo; done

echo "== channels"
# Several coins each: these are dual-funded channels, so the node receiving one also
# contributes a coin to it.
for node in "${nodes[@]}"; do
    for _ in 1 2 3 4 5 6; do
        btc sendtoaddress "$(ln "$node" newaddr | jq -r .bech32)" 0.5 >/dev/null
    done
done
mine 6
synced
node_id() { ln "$1" getinfo | jq -r .id; }
open_channel() {
    ln "$1" connect "$2@$3:9736" >/dev/null
    ln "$1" fundchannel "$2" "$4" >/dev/null
    mine 1
    synced
}
user=$(node_id cln-user); mint=$(node_id cln-mint); hop=$(node_id cln-hop); payee=$(node_id cln-payee)
open_channel cln-user "$mint" cln-mint 3000000
# The other way too, so the wallets on cln-user can receive.
open_channel cln-mint "$user" cln-user 2000000
open_channel cln-mint "$hop" cln-hop 3000000
open_channel cln-hop "$payee" cln-payee 3000000
mine 8
synced
for node in "${nodes[@]}"; do
    for _ in $(seq 120); do
        [[ "$(ln "$node" listpeerchannels | jq '[.channels[] | select(.state != "CHANNELD_NORMAL")] | length')" == 0 ]] && break
        sleep 1
    done
done
sees_payee() { ln cln-mint listchannels source="$hop" | jq -e --arg payee "$payee" 'any(.channels[]; .destination == $payee)'; }
retry 300 sees_payee

echo "== runes"
dc exec -T cln-user bash -s <<'RUNES'
set -euo pipefail
cli="lightning-cli --rpc-file=/data/lightning/regtest/regtest/lightning-rpc"
mkdir -p /data/lightning/lnbits /data/lightning/drawbridge
readonly=$($cli createrune restrictions='[["method=listfunds","method=listpays","method=listinvoices","method=getinfo","method=summary","method=waitanyinvoice"]]' | jq -er .rune)
invoice=$($cli createrune restrictions='[["method=invoice"],["rate=120"]]' | jq -er .rune)
pay=$($cli createrune restrictions='[["method=pay"],["rate=30"]]' | jq -er .rune)
printf 'CLNREST_READONLY_RUNE="%s"\nCLNREST_INVOICE_RUNE="%s"\nCLNREST_PAY_RUNE="%s"\n' "$readonly" "$invoice" "$pay" > /data/lightning/lnbits/runes.env
cp /data/lightning/regtest/regtest/ca.pem /data/lightning/regtest/regtest/server.pem /data/lightning/lnbits/
drawbridge=$($cli createrune restrictions='[["method^invoice","method^listinvoices"]]' | jq -er .rune)
echo "LIGHTNING_RUNE=\"$drawbridge\"" > /data/lightning/drawbridge/rune.txt
chmod -R a+rX /data/lightning/lnbits /data/lightning/drawbridge
RUNES

echo "== services"
dc up -d >/dev/null 2>&1
ready() {
    dc exec -T cli node -e "fetch('$1').then(async r => {
        const text = await r.text();
        process.exit(r.ok && !/\"ready\":false|^false/.test(text) ? 0 : 1);
    }).catch(() => process.exit(1))"
}
for url in http://cashu-mint:8085/v1/info http://drawbridge:4222/api/v1/ready http://keymaster-ts:4226/api/v1/ready http://keymaster-py:4226/api/v1/ready; do
    retry 180 ready "$url"
done
# LNbits redirects everything to this page until an administrator exists.
first_install() {
    dc exec -T cli node -e "fetch('http://lnbits:5000/api/v1/auth/first_install', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'regtest', password: 'regtest-password', password_repeat: 'regtest-password' }),
    }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
}
retry 180 first_install

echo "== scenarios"
python3 scenarios.py
