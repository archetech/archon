#!/usr/bin/env bash
# Archon Noderunner — VPS bootstrap
# Usage: curl -fsSL https://4tress.org/install.sh | bash

set -euo pipefail

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# --- Prereqs ---
log "Checking OS"
. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
[ "$ID" = "ubuntu" ] || die "Ubuntu required (found: $ID)"
maj="${VERSION_ID%%.*}"
[ "$maj" -ge 22 ] || die "Ubuntu 22.04+ required (found: $VERSION_ID)"

log "Checking sudo"
sudo -n true 2>/dev/null || die "passwordless sudo required for the current user"

[ "$(id -u)" -ne 0 ] || die "run as a non-root sudo user, not root"

# --- git + curl (needed before we can clone) ---
log "Installing git, curl, ca-certificates"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates

# --- Node.js LTS via NodeSource ---
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  log "Installing Node.js LTS"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
log "node $(node -v)  npm $(npm -v)"

# --- Claude Code ---
if ! command -v claude >/dev/null; then
  log "Installing Claude Code"
  sudo npm install -g @anthropic-ai/claude-code >/dev/null
fi
log "claude $(claude --version 2>/dev/null || echo installed)"

# --- Clone archon ---
if [ ! -d "$HOME/archon" ]; then
  log "Cloning archon"
  git clone --depth 1 https://github.com/archetech/archon.git "$HOME/archon"
else
  warn "$HOME/archon already exists — skipping clone"
fi

# --- Symlink the noderunner skill ---
SKILL_SRC="$HOME/archon/deploy/claude-skill/archon-noderunner"
SKILL_DST="$HOME/.claude/skills/archon-noderunner"
mkdir -p "$HOME/.claude/skills"
if [ -d "$SKILL_SRC" ]; then
  [ -L "$SKILL_DST" ] || ln -sfn "$SKILL_SRC" "$SKILL_DST"
  log "Skill linked: $SKILL_DST → $SKILL_SRC"
else
  warn "Noderunner skill not yet in the archon repo — you can invoke Claude anyway and the skill will appear on next 'git pull' in ~/archon"
fi

# --- Next steps ---
cat <<EOF

$(printf '\033[1;32m==>\033[0m Bootstrap complete.')

Next steps:
  1. Start Claude and authenticate:
       claude
     Claude will print a URL — open it on your laptop to log in.

  2. Once authenticated, invoke the installer:
       /archon-noderunner install --domain <yourdomain> --node-name <Name> --node-id <ID>

You'll be prompted for chain registries, RPC keys, and DNS confirmation.
Stage 0 (minimal hyperswarm node, delegating to 4tress.org) requires no funding.

Docs: ~/archon/deploy/claude-skill/archon-noderunner/README.md
EOF
