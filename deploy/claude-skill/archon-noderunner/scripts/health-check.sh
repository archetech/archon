#!/usr/bin/env bash
# Recurring health probe for an archon-noderunner-provisioned node.
# Reads the current stage set from COMPOSE_PROFILES in .env; probes accordingly.
#
# Exit code: 0 if healthy, 1 if any red-alert condition trips.
#
# Red-alert conditions:
#   - Any writer wallet emits "insufficient funds" or "not enough funds"
#     in the last 30 minutes  (per feedback_funding_red_alert.md)
#   - Any expected registry missing from /api/v1/registries
#   - Any /public endpoint not returning 200

set -euo pipefail
cd "$(dirname "$0")/../../.."

ENV_FILE=".env"
DOMAIN=$(grep -E "^ARCHON_HOSTNAME=" $ENV_FILE | cut -d= -f2-)
[ -n "$DOMAIN" ] || { echo "cannot read ARCHON_HOSTNAME from $ENV_FILE"; exit 2; }

PROFILES=$(grep -E "^COMPOSE_PROFILES=" $ENV_FILE | cut -d= -f2-)
RED=0

echo "=== $(date -u +'%Y-%m-%d %H:%M UTC') · $DOMAIN ==="

# --- containers ---
UP=$(docker ps --format "{{.Names}}" | wc -l)
UNH=$(docker ps --filter "health=unhealthy" --format "{{.Names}}")
echo "containers running: $UP"
[ -n "$UNH" ] && { echo "🚨 UNHEALTHY: $UNH"; RED=1; }

# --- public endpoints ---
for url in "https://$DOMAIN/" "https://$DOMAIN/api/v1/capabilities" "https://$DOMAIN/api/v1/registries"; do
  C=$(curl -s -o /dev/null -w "%{http_code}" -m 8 "$url")
  [ "$C" = "200" ] || { echo "🚨 $url → $C"; RED=1; }
done

# --- writer funding (only for enabled chain registries) ---
for pair in "btc:BTC:mainnet" "zcash:ZEC:mainnet" "eth:ETH:mainnet" "sol:SOL:mainnet-beta"; do
  svc="${pair%%:*}"
  case ",$PROFILES," in *,${svc}-mainnet,*|*,${svc}-mainnet-beta,*)
    N=$(docker logs --since 30m "archon-${svc}-mainnet-mediator-1" 2>&1 | grep -ciE "insufficient|not enough funds|below minimum" || true)
    if [ "${N:-0}" -gt 0 ]; then
      DETAIL=$(docker logs --since 30m "archon-${svc}-mainnet-mediator-1" 2>&1 | grep -iE 'insufficient|not enough funds' | tail -1)
      echo "🚨 RED — ${pair#*:}: $DETAIL"
      RED=1
    fi
    ;;
  esac
done

if [ $RED -eq 0 ]; then
  echo "✅ all green"
fi

exit $RED
