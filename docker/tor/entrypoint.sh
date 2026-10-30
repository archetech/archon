#!/bin/sh
# Runs Tor as the SOCKS proxy for the other services and publishes Drawbridge
# as a v3 onion service. The container lives exactly as long as Tor does.
set -eu

HS_ROOT=/var/lib/tor/hidden_service
HS_DIR=$HS_ROOT/drawbridge
DATA_DIR=/var/lib/tor/data
TORRC=/etc/tor/torrc
TARGET_HOST=${TOR_SERVICE_HOST:-drawbridge}
TARGET_PORT=${TOR_SERVICE_PORT:-4222}

# HiddenServicePort takes an address, not a hostname, so the target is
# resolved here and again below: a restarted Drawbridge can come back on a
# different address.
resolve() {
    getent hosts "$TARGET_HOST" | awk '{ print $1; exit }'
}

# The SOCKS proxy never depends on Drawbridge: the profile also serves
# stacks without it. The onion service is added once its target resolves.
write_torrc() {
    {
        echo "DataDirectory $DATA_DIR"
        echo "SocksPort 0.0.0.0:9050"
        if [ -n "$1" ]; then
            echo "HiddenServiceDir $HS_DIR"
            echo "HiddenServicePort $TARGET_PORT $1:$TARGET_PORT"
        fi
    } > "$TORRC"
}

mkdir -p "$HS_DIR" "$DATA_DIR"
chown -R tor:tor /var/lib/tor
chmod 700 "$HS_ROOT" "$HS_DIR" "$DATA_DIR"

address=$(resolve || true)
write_torrc "$address"

su-exec tor tor -f "$TORRC" &
pid=$!

(
    published=
    while :; do
        current=$(resolve || true)
        if [ -n "$current" ] && [ "$current" != "$address" ]; then
            address=$current
            write_torrc "$address"
            kill -HUP "$pid" 2>/dev/null || true
            echo "[tor] serving $TARGET_HOST at $address"
        fi
        # The directory keeps its hostname file between runs, so it is only
        # current once this Tor is serving the onion.
        if [ -n "$address" ] && [ -f "$HS_DIR/hostname" ] && [ "$(cat "$HS_DIR/hostname")" != "$published" ]; then
            published=$(cat "$HS_DIR/hostname")
            cp "$HS_DIR/hostname" /tor-hostname/hostname
            chmod 644 /tor-hostname/hostname
            echo '[tor] Published onion hostname'
        fi
        # Poll quickly until the onion is published, then settle.
        if [ -n "$published" ]; then sleep 30; else sleep 2; fi
    done
) &
watcher=$!

finish() {
    status=0
    wait "$pid" || status=$?
    kill "$watcher" 2>/dev/null || true
    exit "$status"
}

# Forward the stop signal, then let Tor finish shutting down before exiting.
trap 'kill -TERM "$pid" 2>/dev/null || true; finish' TERM INT

finish
