# Onion services for the Tor entrypoint. Sourced, so the parsing and torrc
# generation can be tested without starting Tor.
#
# TOR_SERVICES is a space-separated list of name:host:port[:mode] entries,
# each served from $HS_ROOT/<name>. An entry whose mode is `clearnet` is not
# served: its owner has opted out of Tor, and serving the onion anyway would
# keep an address reachable that the operator meant to retire.
#
# TOR_SERVICE_HOST and TOR_SERVICE_PORT predate the list and still override
# the drawbridge entry's host and port.

HS_ROOT=${HS_ROOT:-/var/lib/tor/hidden_service}
DATA_DIR=${DATA_DIR:-/var/lib/tor/data}

# Prints "name host port" for each entry that is to be served.
tor_services() (
    set -f
    for entry in ${TOR_SERVICES:-drawbridge:drawbridge:4222}; do
        IFS=: read -r name host port mode <<EOF
$entry
EOF
        if [ "$name" = drawbridge ]; then
            host=${TOR_SERVICE_HOST:-$host}
            port=${TOR_SERVICE_PORT:-$port}
        fi
        case "$name" in
            ''|*[!a-z0-9-]*) echo "[tor] invalid service name in '$entry'" >&2; return 1 ;;
        esac
        case "$port" in
            ''|*[!0-9]*) echo "[tor] invalid port in '$entry'" >&2; return 1 ;;
        esac
        if [ -z "$host" ]; then
            echo "[tor] missing host in '$entry'" >&2
            return 1
        fi
        case "$mode" in
            ''|tor|hybrid) echo "$name $host $port" ;;
            clearnet) ;;
            *) echo "[tor] invalid mode in '$entry'" >&2; return 1 ;;
        esac
    done
)

# HiddenServicePort takes an address, not a hostname.
resolve() {
    getent hosts "$1" | awk '{ print $1; exit }'
}

# Reads "name host port" lines and prints "name port address" for each target
# that currently resolves. The rest are left out until they do.
resolve_services() {
    while read -r name host port; do
        [ -n "$name" ] || continue
        address=$(resolve "$host" || true)
        if [ -n "$address" ]; then
            echo "$name $port $address"
        fi
    done
}

# Reads "name port address" lines. The SOCKS proxy is always on, whatever the
# onion services are doing: the profile also serves stacks without them.
write_torrc() {
    echo "DataDirectory $DATA_DIR"
    echo "SocksPort 0.0.0.0:9050"
    while read -r name port address; do
        [ -n "$name" ] || continue
        echo "HiddenServiceDir $HS_ROOT/$name"
        echo "HiddenServicePort $port $address:$port"
    done
}
