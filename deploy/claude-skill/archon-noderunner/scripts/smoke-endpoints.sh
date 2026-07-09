#!/usr/bin/env bash
# Smoke-test the public surface after install / add-stage.
# Usage: smoke-endpoints.sh <domain> [additional path ...]

set -euo pipefail

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "usage: $0 <domain> [path ...]"; exit 2; }
shift

BASE_PATHS=(
  "https://$DOMAIN/"
  "https://$DOMAIN/api/v1/capabilities"
  "https://$DOMAIN/api/v1/registries"
  "https://wallet.$DOMAIN/"
)
EXTRA=("$@")

FAIL=0
for url in "${BASE_PATHS[@]}" "${EXTRA[@]}"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$url")
  if [ "$CODE" = "200" ]; then
    printf '  %-60s %s ✓\n' "$url" "$CODE"
  else
    printf '  %-60s %s ✗\n' "$url" "$CODE"
    FAIL=$((FAIL+1))
  fi
done

[ "$FAIL" -eq 0 ]
