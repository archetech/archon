# Rejected-branch retry classification — #1178

The ordinary importer retains every candidate before deciding acceptance. Both
ports previously deferred a successor whenever its predecessor was absent from
accepted history, including when replay had already rejected that branch.

## Implementation

- Keep operation verification and branch selection unchanged. Record outcomes of
  the final stable replay pass, grouped by complete operation CID across anchors.
- Accepted operations take precedence. A nonaccepted operation with an unresolved
  anchor remains pending unless its known predecessor is currently rejected.
  Propagate rejection through known descendant edges once during reconciliation.
- Publish the derived in-memory rejection index after durable history publication.
  Rebuild it on startup and affected-history reconciliation; clear it on removal
  or database reset. There is no new durable format or protocol version.
- Unchanged rejected imports return from the index before operation verification
  or replay. New evidence still enters the ordinary journal/replay path.
- Direct submissions also replay their own target when it has known rejected
  candidates, so a newly accepted predecessor can recover retired descendants.
- Active queues drain these descendants as rejected. Continue processing when a
  pass rejects work, since a later item can settle a descendant visited earlier.
  Pending counts and pending batch lists then exclude the retired work.
- The original journal, signed predecessors, and anchoring metadata survive. A
  different winning anchor or controller history can accept retained descendants
  without mediator resubmission.

## Coverage

Shared signed fixtures cover Bitcoin and Ethereum controller registries, a
competing branch, direct and transitive descendants, an unseen intermediate,
missing controller evidence, controller rotation/removal/recovery, and a distinct
earlier anchor making the losing branch win, and a direct submission recovering
retired descendants. The Bitcoin case signs a legacy
numeric-key predecessor alias. Both ports exercise disk persistence and restart.
Unchanged retries are checked for absence of replay; TypeScript also checks that
operation verification is skipped. HTTP parity covers CID/batch ingress, queue
ordering, pending batch completion, and recovery through a new anchor.

## Production-example boundary

This does not infer ancestry from unavailable operations. The original Bitcoin
example in #1178 lacked a provenance-backed intermediate migration event. It
must remain pending until that evidence arrives; the correction does not claim
to clear that specific live event or all seven originally deferred events.
No production queue or journal was changed for this task.

## Validation

- Full TypeScript Gatekeeper run: 735 passed, one disk recovery test exceeded its
  five-second timeout during concurrent work. The isolated recovery/new-case run
  passed 87/87. Final CRUD/sync/API/rejected-branch tests passed 169/169.
- Full Rust suite passed 109 tests, with 3 existing ignored. The final focused run
  passed 4 tests, including the subsequently added direct-submission case.
- Full HTTP parity passed against the final TS server and Rust release binary,
  including batch/CID ingress, same-call pending batch completion, earlier-anchor
  recovery, and direct-submission recovery.
- Gatekeeper package/server builds, Rust release build, root typecheck and lint
  passed. Shared fixtures regenerate identically.

An isolated Redis instance with AOF enabled was restored from the saved production
snapshot before each comparison. No live service or database was changed. All
four runs recovered the exact same accepted histories: 25,296 DIDs and 39,816
events. Each port's before/after status counts and search/query results match.

| Measurement | Main baseline | Change |
| --- | ---: | ---: |
| TypeScript initialization | 46.9 s | 47.3 s |
| Rust HTTP readiness | 51.6 s | 50.1 s |

These are single runs on a shared host, not statistical estimates. TypeScript
measures the service's initialize sequence with memory IPFS, excluding HTTP/IPFS
connection setup; Rust measures process start to HTTP readiness. Compare each
port with its own baseline. The snapshot was taken earlier than these tests;
the comparison concerns preservation relative to baseline replay, not a claim
about the live node's current pending queue.
