#!/usr/bin/env bash

set -euo pipefail

DEFAULT_GATEKEEPER_URL="https://archon.technology"
MIN_NODE_MAJOR=22
MIN_NPM_MAJOR=10
MIN_NPM_MINOR=8
MIN_NPM_PATCH=2
TTY="/dev/tty"

say() {
    printf '%s\n' "$*"
}

say_tty() {
    printf '%s\n' "$*" > "${TTY}"
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

version_ge() {
    local a="$1"
    local b="$2"

    [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}

detect_platform() {
    local uname_out
    uname_out="$(uname -s 2>/dev/null || true)"

    case "$uname_out" in
        Linux*)
            echo "linux"
            ;;
        Darwin*)
            echo "macos"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

print_node_install_help() {
    local platform
    platform="$(detect_platform)"

    say
    say "Node.js and npm are required before continuing."
    say "Please install Node.js 22.x or newer, then run this installer again."
    say

    case "$platform" in
        macos)
            say "Recommended options on macOS:"
            say "  brew install node"
            say "  or install from https://nodejs.org/"
            ;;
        linux)
            say "Recommended options on Linux:"
            say "  install from your package manager if it provides Node.js 22.x or newer"
            say "  or install from https://nodejs.org/"
            ;;
        *)
            say "Install Node.js from https://nodejs.org/"
            ;;
    esac
}

check_runtime_versions() {
    local node_version
    local npm_version
    local min_npm_version

    node_version="$(node --version | sed 's/^v//')"
    npm_version="$(npm --version)"
    min_npm_version="${MIN_NPM_MAJOR}.${MIN_NPM_MINOR}.${MIN_NPM_PATCH}"

    if [ "${node_version%%.*}" -lt "${MIN_NODE_MAJOR}" ]; then
        fail "Node.js ${MIN_NODE_MAJOR}.x or newer is required. Found ${node_version}."
    fi

    if ! version_ge "${npm_version}" "${min_npm_version}"; then
        fail "npm ${min_npm_version} or newer is required. Found ${npm_version}."
    fi
}

prompt_required() {
    local prompt="$1"
    local value=""

    while true; do
        read -r -p "$prompt" value < "${TTY}"
        if [ -n "${value}" ]; then
            printf '%s' "$value"
            return 0
        fi
        say_tty "A value is required."
    done
}

prompt_hidden_confirm() {
    local first=""
    local second=""

    while true; do
        read -r -s -p "Keymaster passphrase: " first < "${TTY}"
        say_tty ""
        [ -n "${first}" ] || {
            say_tty "A passphrase is required."
            continue
        }

        read -r -s -p "Confirm passphrase: " second < "${TTY}"
        say_tty ""
        [ "${first}" = "${second}" ] && {
            printf '%s' "$first"
            return 0
        }

        say_tty "Passphrases did not match. Please try again."
    done
}

prompt_gatekeeper_url() {
    local value=""
    while true; do
        read -r -p "Node URL [${DEFAULT_GATEKEEPER_URL}]: " value < "${TTY}"
        if [ -z "${value}" ]; then
            printf '%s' "${DEFAULT_GATEKEEPER_URL}"
            return 0
        fi

        case "$value" in
            http://*|https://*)
                printf '%s' "$value"
                return 0
                ;;
            *)
                say_tty "Please enter a URL starting with http:// or https://"
                ;;
        esac
    done
}

print_shell_persistence() {
    local gatekeeper_url="$1"

    say
    say "This installer cannot export variables back into your current shell when run as 'curl | bash'."
    say "To use keymaster in later commands, add these to ~/.bashrc or ~/.zshrc, or export them manually:"
    say
    say "export ARCHON_NODE_URL=\"${gatekeeper_url}\""
    say
    say "If you want to persist your passphrase too, add this line yourself:"
    say
    say "export ARCHON_PASSPHRASE=\"your-passphrase-here\""
    say
    say "Only do that if you accept storing the passphrase in plaintext."
    say "If you add either line, restart your shell or run: source ~/.bashrc"
}

main() {
    say "Archon Keymaster installer"
    say

    if [ ! -r "${TTY}" ] || [ ! -w "${TTY}" ]; then
        fail "Interactive prompts require a readable and writable TTY. Run this script from a terminal."
    fi

    if ! command_exists node || ! command_exists npm; then
        print_node_install_help
        exit 1
    fi

    check_runtime_versions

    say "Found Node.js: $(node --version)"
    say "Found npm: $(npm --version)"
    say

    if command_exists keymaster; then
        say "Found Keymaster: $(keymaster --version)"
    else
        say "Installing @didcid/keymaster..."
        if ! npm install -g @didcid/keymaster; then
            fail "Failed to install @didcid/keymaster. Check npm permissions and try again."
        fi
    fi

    command_exists keymaster || fail "The keymaster command is not available after installation."

    say
    local id_name
    local passphrase
    local gatekeeper_url

    id_name="$(prompt_required 'ID name: ')"
    passphrase="$(prompt_hidden_confirm)"
    gatekeeper_url="$(prompt_gatekeeper_url)"

    export ARCHON_PASSPHRASE="${passphrase}"
    export ARCHON_NODE_URL="${gatekeeper_url}"

    say
    say "Creating your identity..."
    keymaster create-id "${id_name}"

    say
    say "Keymaster setup completed."
    say "The Node URL used for setup was: ${ARCHON_NODE_URL}"
    say "If you ran this installer via 'curl | bash', your parent shell was not updated."
    print_shell_persistence "${gatekeeper_url}"
    say
    say "Next steps:"
    say "  export ARCHON_NODE_URL=\"${gatekeeper_url}\""
    say "  export ARCHON_PASSPHRASE=\"your-passphrase-here\""
    say "  keymaster list-ids"
    say "  keymaster resolve-id"
}

main "$@"
