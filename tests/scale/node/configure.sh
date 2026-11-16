#!/usr/bin/env bash
# Runs on a machine, in the cloned repository. Writes the node's .env and the Compose
# file that fits the node to the host's network.
#   configure.sh <node name> <protocol> <node number, 1 to 150>
# The golden machine runs it with placeholder values, to pull the right images; each
# node runs it again with its own.
set -euo pipefail
name=$1; protocol=$2; number=$3
cp sample.env .env
set_env() {
    if grep -qE "^#? ?$1=" .env; then sed -i -E "s|^#? ?$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
set_env ARCHON_UID "$(id -u)"
set_env ARCHON_GID "$(id -g)"
set_env ARCHON_NODE_ID "$name"
set_env ARCHON_NODE_NAME "$name"
set_env COMPOSE_PROFILES hyperswarm,cli
set_env ARCHON_GATEKEEPER_FLAVOR rust
set_env ARCHON_KEYMASTER_FLAVOR ts
set_env ARCHON_ADMIN_API_KEY "$(openssl rand -hex 32)"
set_env ARCHON_PASSPHRASE "$(openssl rand -hex 16)"
set_env ARCHON_PROTOCOL "$protocol"
set_env COMPOSE_FILE docker-compose.yml:docker-compose.override.yml:scale-network.yml
mkdir -p data

# Machines in one region leave it through one public address, so Hyperswarm peers
# there connect over the private network, each choosing the other's local address
# that looks nearest its own. A stock node cannot do that: its mediator sits on a
# Docker bridge and offers a bridge address, which is the same on every machine. So
# the mediator runs on the host's network here, where it offers the machine's
# private address, and the bridges are moved to a subnet of this machine's own so
# that no other machine's bridge address looks nearer than its private one.
cat > scale-network.yml <<YAML
services:
  hyperswarm-mediator:
    network_mode: host
    ports: !reset []
    environment:
      - ARCHON_GATEKEEPER_URL=http://127.0.0.1:4224
      - ARCHON_KEYMASTER_URL=http://127.0.0.1:4226
      - ARCHON_IPFS_URL=http://127.0.0.1:5001/api/v0
networks:
  default:
    ipam:
      config:
        - subnet: 10.$((100 + number)).0.0/24
YAML
sudo -n ip addr flush dev docker0
