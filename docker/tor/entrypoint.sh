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

write_torrc() {
    cat > "$TORRC" <<EOF
DataDirectory $DATA_DIR
SocksPort 0.0.0.0:9050
HiddenServiceDir $HS_DIR
HiddenServicePort $TARGET_PORT $1:$TARGET_PORT
EOF
}

address=$(resolve || true)
while [ -z "$address" ]; do
    echo "[tor] waiting for $TARGET_HOST to resolve"
    sleep 2
    address=$(resolve || true)
done

mkdir -p "$HS_DIR" "$DATA_DIR"
chown -R tor:tor /var/lib/tor
chmod 700 "$HS_ROOT" "$HS_DIR" "$DATA_DIR"
write_torrc "$address"

su-exec tor tor -f "$TORRC" &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT

until [ -f "$HS_DIR/hostname" ]; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
done

if [ -f "$HS_DIR/hostname" ]; then
    cp "$HS_DIR/hostname" /tor-hostname/hostname
    chmod 644 /tor-hostname/hostname
    echo '[tor] Published onion hostname'
fi

(
    while sleep 30; do
        current=$(resolve || true)
        if [ -n "$current" ] && [ "$current" != "$address" ]; then
            address=$current
            write_torrc "$address"
            kill -HUP "$pid" 2>/dev/null || true
            echo "[tor] $TARGET_HOST is now $address; reloaded"
        fi
    done
) &
watcher=$!

status=0
wait "$pid" || status=$?
kill "$watcher" 2>/dev/null || true
exit "$status"
