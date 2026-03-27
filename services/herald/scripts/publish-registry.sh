#!/bin/bash
# Name Service Registry Publisher
# Extracts names from the server and publishes to IPNS

set -e

# Configuration
API_URL="${ARCHON_HERALD_PUBLIC_URL:-http://localhost:3300}"
IPNS_KEY="${ARCHON_HERALD_IPNS_KEY_NAME:-${ARCHON_HERALD_NAME:-name-service}}"
OUTPUT_FILE="/tmp/registry.json"

echo "[$(date)] Starting registry publish..."

# Get registry from the API (already formatted correctly)
echo "Fetching registry from API..."
curl -s "${API_URL}/api/registry" > "$OUTPUT_FILE"

if [ ! -s "$OUTPUT_FILE" ]; then
    echo "ERROR: Could not fetch registry from API. Is the server running?"
    exit 1
fi

echo "Registry content:"
cat "$OUTPUT_FILE"
echo ""

# Add to IPFS
echo "Adding to IPFS..."
CID=$(ipfs add -Q "$OUTPUT_FILE")
echo "CID: $CID"

# Publish to IPNS
echo "Publishing to IPNS with key: $IPNS_KEY..."
RESULT=$(ipfs name publish --key="$IPNS_KEY" "/ipfs/$CID" 2>&1)
echo "$RESULT"

echo ""
echo "[$(date)] Registry published successfully!"
