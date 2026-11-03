#!/bin/sh
# Runs Tor as the SOCKS proxy for the other services and publishes the onion
# services listed in TOR_SERVICES (see services.sh). The container lives
# exactly as long as Tor does.
set -eu

. /usr/local/lib/archon/tor-services.sh

TORRC=/etc/tor/torrc

services=$(tor_services)

mkdir -p "$HS_ROOT" "$DATA_DIR"
for name in $(echo "$services" | cut -d' ' -f1); do
    mkdir -p "$HS_ROOT/$name"
done
chown -R tor:tor /var/lib/tor
chmod 700 "$HS_ROOT" "$DATA_DIR"
for name in $(echo "$services" | cut -d' ' -f1); do
    chmod 700 "$HS_ROOT/$name"
done

# Each target is resolved here and again below: a restarted service can come
# back on a different address.
resolved=$(echo "$services" | resolve_services)
echo "$resolved" | write_torrc > "$TORRC"

su-exec tor tor -f "$TORRC" &
pid=$!

(
    published=
    while :; do
        current=$(echo "$services" | resolve_services)
        if [ "$current" != "$resolved" ]; then
            resolved=$current
            echo "$resolved" | write_torrc > "$TORRC"
            kill -HUP "$pid" 2>/dev/null || true
            echo "$resolved" | sed -n 's/^\([^ ]*\) [^ ]* \(.*\)$/[tor] serving \1 at \2/p'
        fi
        # Drawbridge reads its onion hostname from this volume. The directory
        # keeps its hostname file between runs, so it is only current once this
        # Tor is serving the onion.
        hostname=$HS_ROOT/drawbridge/hostname
        if echo "$resolved" | grep -q '^drawbridge ' && [ -f "$hostname" ] && [ "$(cat "$hostname")" != "$published" ]; then
            published=$(cat "$hostname")
            cp "$hostname" /tor-hostname/hostname
            chmod 644 /tor-hostname/hostname
            echo '[tor] Published onion hostname'
        fi
        # Poll quickly until Drawbridge's onion is published, then settle.
        if [ -n "$published" ] || ! echo "$services" | grep -q '^drawbridge '; then sleep 30; else sleep 2; fi
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
