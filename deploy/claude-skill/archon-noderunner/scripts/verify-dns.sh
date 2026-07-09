#!/usr/bin/env bash
# Verify DNS A records match the current VPS public IP.
# Usage: verify-dns.sh <domain> [extra subdomain ...]
# Exits 0 when all names resolve to the VPS IP; 1 otherwise.

set -euo pipefail

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "usage: $0 <domain> [extra ...]"; exit 2; }
shift
EXTRA=("$@")

VPS_IP=$(curl -sf https://api.ipify.org)
[ -n "$VPS_IP" ] || { echo "cannot determine VPS public IP"; exit 2; }
echo "VPS IP: $VPS_IP"

NAMES=("$DOMAIN" "wallet.$DOMAIN" "${EXTRA[@]}")
FAIL=0
for name in "${NAMES[@]}"; do
  RESOLVED=$(dig +short "$name" A | tail -1)
  if [ "$RESOLVED" = "$VPS_IP" ]; then
    printf '  %-40s %s ✓\n' "$name" "$RESOLVED"
  else
    printf '  %-40s %s ✗  (expected %s)\n' "$name" "${RESOLVED:-<no A record>}" "$VPS_IP"
    FAIL=$((FAIL+1))
  fi
done

[ "$FAIL" -eq 0 ]
