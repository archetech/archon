#!/usr/bin/env bash
# Install docker + compose plugin + caddy on Ubuntu 22.04+.
# Invoked by the archon-noderunner skill during stage 0.

set -euo pipefail

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# --- docker ---
if ! command -v docker >/dev/null; then
  log "Installing Docker"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  log "Note: log out and back in to pick up docker group membership, or run 'newgrp docker' in the current shell."
fi

# --- caddy ---
if ! command -v caddy >/dev/null; then
  log "Installing Caddy"
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
fi

# --- python3 (for the health-check script) ---
sudo apt-get install -y -qq python3 python3-pip jq

log "System prereqs ready"
log "docker $(docker --version | awk '{print $3}' | tr -d ,)"
log "caddy $(caddy version | awk '{print $1}')"
