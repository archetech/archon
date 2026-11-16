#!/usr/bin/env bash
# Runs on the machine, in the cloned repository. Loads Memeplex objects in stages and
# measures the node after each: memory, storage, latency and restart time.
#   pilot.sh <cumulative object counts...>     e.g. pilot.sh 10000 100000 300000 1000000
# Prints one line of JSON for each stage. Stops before a stage if the Gatekeeper and
# Redis together hold more than three quarters of the machine's memory. The scripts
# must already be in /home/boxd/scale and copied to /app in the cli container.
set -euo pipefail
cd /home/boxd/archon
loaders=4
have=$(docker compose exec -T cli sh -c 'ls /tmp/stage-*.json 2>/dev/null | wc -l')
[ "$have" = 0 ] || { echo "stage files already exist in the cli container" >&2; exit 1; }
in_cli() { docker compose exec -T cli sh -c "cd /app && $1"; }
mem() { docker stats --no-stream --format '{{.MemUsage}}' "$1" | awk '{print $1}'; }
# docker prints 1.5GiB, and 0B for a container that has stopped.
bytes() { local v=${1%B}; case $v in *i) numfmt --from=iec-i "$v" ;; *) numfmt --from=si "${v:-0}" ;; esac; }
total=$(awk '/MemTotal/{print $2*1024}' /proc/meminfo)
loaded=0; stage=0
for target in "$@"; do
    stage=$((stage + 1))
    used=$(( $(bytes "$(mem archon-gatekeeper-1)") + $(bytes "$(mem archon-redis-1)") ))
    if [ "$used" -gt $((total * 3 / 4)) ]; then echo "{\"stopped\":\"memory\",\"before\":$target}"; break; fi
    each=$(( (target - loaded) / loaders ))
    began=$(date +%s.%N)
    pids=()
    for n in $(seq 1 $loaders); do
        in_cli "node load.mjs --url http://gatekeeper:4224 --registry hyperswarm --objects $each --authors $(( each / 100 + 1 )) --seed $((stage * 100 + n)) --out /tmp/stage-$stage-$n.json" > /tmp/pilot-load-$stage-$n.log 2>&1 &
        pids+=($!)
    done
    for pid in "${pids[@]}"; do wait "$pid" || { echo "{\"failed\":\"loader\",\"stage\":$stage}"; tail -3 /tmp/pilot-load-$stage-*.log >&2; exit 1; }; done
    seconds=$(echo "$(date +%s.%N) - $began" | bc)
    loaded=$(( loaded + each * loaders ))
    sleep 20
    samples=$(in_cli 'ls /tmp/stage-*.json | tr "\n" ","')
    measured=$(in_cli "node measure.mjs --url http://gatekeeper:4224 --samples $samples")
    gatekeeper=$(bytes "$(mem archon-gatekeeper-1)"); redis=$(bytes "$(mem archon-redis-1)"); mediator=$(bytes "$(mem archon-hyperswarm-mediator-1)")
    keys=$(docker compose exec -T redis redis-cli dbsize | tr -dc 0-9)
    redis_data=$(docker compose exec -T redis redis-cli info memory | awk -F: '/^used_memory:/{print $2}' | tr -dc 0-9)
    disk=$(sudo du -sb data 2>/dev/null | awk '{print $1}')
    # Restart the Gatekeeper and time how long it takes to answer as ready again.
    restart=$(date +%s.%N)
    docker compose restart gatekeeper >/dev/null 2>&1
    until curl -sf -m 5 http://localhost:4224/api/v1/ready 2>/dev/null | grep -q true; do sleep 1; done
    startup=$(echo "$(date +%s.%N) - $restart" | bc)
    sleep 5
    after=$(bytes "$(mem archon-gatekeeper-1)")
    echo "{\"stage\":$stage,\"objects\":$loaded,\"loadSeconds\":$seconds,\"objectsPerSecond\":$(echo "$each * $loaders / $seconds" | bc),\"gatekeeperBytes\":$gatekeeper,\"gatekeeperBytesAfterRestart\":$after,\"redisBytes\":$redis,\"redisUsedMemory\":$redis_data,\"redisKeys\":$keys,\"mediatorBytes\":$mediator,\"dataDirBytes\":${disk:-0},\"startupSeconds\":$startup,\"measured\":$measured}"
done
echo '{"done":true}'
