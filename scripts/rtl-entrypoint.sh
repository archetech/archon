#!/bin/sh
set -e

CONFIG_DIR="${RTL_CONFIG_PATH:-/data}"
CONFIG_FILE="$CONFIG_DIR/RTL-Config.json"
RUNE_FILE="$CONFIG_DIR/rune.txt"

CLN_HOST="${CLN_REST_HOST:-cln-mainnet-node}"
CLN_PORT="${CLN_REST_PORT:-3001}"
NODE_NAME="${RTL_NODE_NAME:-archon}"
RTL_PASS="${RTL_PASSWORD:-changeme}"

# Wait for rune file (created by rtl-init sidecar)
echo "[rtl-init] Waiting for rune file at $RUNE_FILE..."
timeout=120
elapsed=0
while [ ! -f "$RUNE_FILE" ]; do
    sleep 2
    elapsed=$((elapsed + 2))
    if [ $elapsed -ge $timeout ]; then
        echo "[rtl-init] ERROR: Rune file not found after ${timeout}s"
        exit 1
    fi
done
echo "[rtl-init] Rune file found"

# Generate config if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
    echo "[rtl-init] Generating RTL-Config.json..."
    cat > "$CONFIG_FILE" << EOF
{
  "multiPass": "$RTL_PASS",
  "port": "3000",
  "defaultNodeIndex": 1,
  "dbDirectoryPath": "$CONFIG_DIR",
  "SSO": {
    "rtlSSO": 0,
    "rtlCookiePath": "",
    "logoutRedirectLink": ""
  },
  "nodes": [
    {
      "index": 1,
      "lnNode": "$NODE_NAME",
      "lnImplementation": "CLN",
      "authentication": {
        "runePath": "$RUNE_FILE"
      },
      "settings": {
        "userPersona": "OPERATOR",
        "themeMode": "NIGHT",
        "themeColor": "PURPLE",
        "logLevel": "INFO",
        "fiatConversion": true,
        "unannouncedChannels": false,
        "lnServerUrl": "https://$CLN_HOST:$CLN_PORT",
        "blockExplorerUrl": "https://mempool.space"
      }
    }
  ]
}
EOF
    echo "[rtl-init] Config generated"
else
    echo "[rtl-init] RTL-Config.json already exists, skipping"
fi

echo "[rtl-init] Starting RTL..."
exec node rtl
