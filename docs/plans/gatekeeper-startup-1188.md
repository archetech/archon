# Gatekeeper Redis startup performance (#1188)

## Observed failure

On 2026-09-18, Rust Gatekeeper took 90.6 seconds to listen after the #1186
upgrade. Docker Compose had already marked it unhealthy, leaving dependent
services in `Created`. The node eventually became healthy. The production
configuration allows approximately 80 seconds for startup.

The timestamp repair changed about 25,000 event histories. Recovery refreshed
their search entries individually, status initialization read the full database,
and startup then built the full search index again. The initial #1186 in-memory
replay benchmark did not measure this production Redis startup path.

## Change

In both implementations, after durable history publication, startup builds complete search and status
views in one pass over the accepted in-memory replay snapshot. Candidate-only
histories do not enter these views. Both views are published before recovery
releases the history lock; readiness still waits for initialization to finish.
Empty databases initialize empty views and counters.

Rust snapshot preparation also reuses canonical operation content from the normalized
candidate journal for predecessor lookups. References to retrieval aliases still
use the operation database; peer-supplied operation IDs are not treated as aliases.

Runtime imports still refresh affected search entries. Rust invalidates cached
status; TypeScript status scans continue to read current histories. Controller removal, garbage collection, journal persistence, publication,
signature verification, and accepted-history selection retain their existing
paths. Compose healthcheck timing is unchanged.

## Validation method

Captured only the live Gatekeeper `archon/*` Redis keys using read-only SCAN/DUMP
commands. Restored them into a separate Redis 8.0.4 instance on loopback port
6398, with AOF enabled and `appendfsync everysec`, matching the live settings.
The live database and services were not modified or restarted.

Each Rust benchmark starts a release binary against the isolated Redis instance and
measures wall time until `/api/v1/ready` succeeds. Background status and GC are
disabled in both builds; neither starts before readiness in production. The same
accepted histories and candidate journal are restored before each comparison.

The live snapshot had already undergone #1186 repair. To exercise an upgrade,
the harness changes only Hyperswarm envelope times in the isolated accepted
histories and candidate journal to an old receipt timestamp. This is a simulated
timestamp migration, not a recovered copy of the original pre-upgrade database.
It preserves operation bytes, IDs, ordinals, rejected evidence, and chain metadata.
The unchanged scenario uses the unmodified snapshot.

Compare canonicalized persisted history content, status counts, five search
queries (including all indexed documents), and a structured query after readiness.
The unit regression additionally exercises a nonempty structured query, unchanged
history indexing, rejected candidate exclusion, repeated startup, runtime deletion,
and controller removal. Existing tests cover alias recovery, GC failures, and
publication locking.

Initial isolated results: the baseline migration took 135.9 seconds. Consolidating
search/status alone reduced it to 76.2 seconds, with identical histories, counts,
and query results. Reusing canonical predecessor content reduced the final upgrade run to **67.3
seconds**, with all comparisons still identical: 25,356 accepted DIDs and 39,875
events. This gives about 13 seconds of margin against the existing health window.
These shared-host measurements should be compared within this benchmark;
they are not a claim that every production host has the same absolute timings.

Local artifacts are under `/tmp/1188-benchmark/`: `snapshot.pkl`,
`redis_snapshot.py`, `run.py`, build/test logs, and per-run logs/results. The
snapshot is local validation data, not a repository fixture.

The full Rust suite passed: 76 unit tests and 29 integration tests, with three
opt-in tests ignored. The release binary was benchmarked after compilation and
testing finished, with runs serialized on the same isolated Redis instance.

## Rust readiness comparison

| Scenario | Baseline | Final | Reduction |
| --- | ---: | ---: | ---: |
| Simulated timestamp-repair upgrade | 135.9s | 67.3s | 50% |
| Unchanged startup | 91.5s | 45.6s | 50% |

All four runs produced identical canonical accepted histories, status counts,
search sets, and structured-query results. The existing Compose timeout was not
changed. A second node/host should still be used to confirm deployment timing.

## TypeScript startup

TypeScript had the same redundant work: changed histories refreshed individual
search entries during publication, followed by a full status scan and full search
scan. Its 32-DID concurrency reduces network latency but does not remove those
passes. `Gatekeeper.initialize()` now returns status and populates search from
the complete accepted replay snapshot, under the recovery lock. The server uses
that result to initialize its status metrics without rescanning. Subsequent
status checks and repeated initialization read current histories; startup
counters are never reused after runtime changes. Explicit `initSearchIndex()`
remains available for rebuilding the live index.

The existing TypeScript startup benchmark selects the combined initializer when
available and retains the older sequence for baseline builds. The signed
regression covers repaired and unchanged histories together, candidate-only
exclusion, nonempty structured queries, repeated startup, queued deletion,
controller removal, later status refreshes, and empty databases.

The initial TypeScript view-only change reduced the simulated upgrade from
132.1s to 88.4s with identical output, but publication still took 32.5s and the
overall startup remained above the health window. Startup publication therefore
uses bounded groups of 32 independent DID writes under the history lock. Each
group waits for all started writes to settle before propagating an error; a
failure cannot release the lock while another write is still active. Runtime
publication stays sequential. JSON/SQLite adapters retain their own serialization,
and Redis retains its per-history transaction. A failure regression verifies
lock retention and recovery from the durable journal on retry.

With bounded publication, the simulated TypeScript upgrade took **70.6s**, down
from **132.1s**. Publication fell from 66.1s in the baseline to 15.1s; the combined
search/status phase took 3.6s. Canonical persisted histories, status counts, all
five search sets, and the structured query matched the baseline exactly.

TypeScript measurements time the built package's service initialization sequence
(`checkDIDs()` plus `initSearchIndex()` in the baseline, `initialize()` in the
revision), using in-memory IPFS and the same full isolated Redis snapshot as the
Rust benchmark. They exclude IPFS readiness waiting, HTTP listener setup, and
service bootstrap overhead; they are not HTTP readiness measurements. The
snapshot contains original chain metadata and the durable rejected candidates.
All 719 TypeScript Gatekeeper tests passed across 32 suites, including the final
publication change, along with the package build and root typecheck. The Jest
run used a 20-second per-test timeout for the disk-backed recovery cases.

| TypeScript scenario | Baseline | Final | Reduction |
| --- | ---: | ---: | ---: |
| Simulated timestamp-repair upgrade | 132.1s | 70.6s | 47% |
| Unchanged startup | 53.4s | 42.7s | 20% |

Both scenarios retained identical canonical histories, status counts, and search/
query results. Local artifacts include `run-ts.py`, `ts-run.mjs`,
`compare-ts.py`, and `ts-{baseline,final}-{upgrade,unchanged}.{json,log}`.
The TypeScript timings leave approximately nine seconds of margin in the upgrade
simulation before accounting for service bootstrap; deployment timing on the
other affected hosts still needs confirmation.
