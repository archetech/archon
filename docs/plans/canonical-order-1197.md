# Canonical provisional successor ordering (#1197)

## Decision

On 2026-09-19 the maintainer selected option 1: among competing valid provisional
successors of the same predecessor, choose the lexicographically smallest
canonical operation CID. Compare lowercase base32 strings in ASCII order. The
complete proof remains part of operation identity. No signed bytes, predecessor
references, genesis identifiers, or chain positions change.

A confirmation on the predecessor's expected chain registry takes priority over
provisional evidence. Two such confirmations retain the existing ordinal rule.
When neither event confirms on that registry, CID priority applies, including to
an anchor on a different registry. A signed import counterexample demonstrated
that excluding those foreign anchors would still allow arrival-dependent results.

This is an intentional version-1 ordering change. Both Gatekeepers implement it
in ordinary import, which is shared by replay. Operators must upgrade nodes to
get consistent selection of newly encountered forks. Losing evidence stays in
the candidate journal, and a changed controller branch replays dependent assets.

Replay retains its existing traversal order: globally sorting hints by CID would
randomize long predecessor chains and cause repeated passes. Sibling preference
belongs in the importer, independently of which candidate is processed first.

## Production evidence

An isolated copy of the local Redis database contained 25,956 candidate DIDs and
39,850 candidate events. The audit found 14,534 local/Hyperswarm successor events
and **no distinct competing unanchored children of a predecessor**. Operation
identity included the entire canonical operation; cached predecessor aliases were
normalized. This is evidence about this snapshot, not a claim about every node
or every operation ever produced.

Validation uses a read-only production snapshot restored into a separate Redis
container. No live node configuration, histories, queues, or services are changed.

## Executable model and tests

`tests/convergence/model.mjs` projects a restricted predecessor graph using an
explicit child-priority order. `generate-vectors.mjs` creates real signed
operations and delivery permutations; both ports consume the same fixtures.
The model deliberately excludes key changes, deletion, migration, aliases, and
missing content. Separate signed controller tests exercise rotation/deletion
forks and asset authorization changes with both proof suites.

The shared matrix covers local, Hyperswarm, mixed hint transports, hints for a
chain-registered DID, fixed chain anchors, and foreign-registry anchors. It tests
fresh and tied receipts, late genesis/predecessors, every permutation of the
small graphs, repeated batches, candidate retention, confirmed resolution, and
reconstruction with fresh in-memory state. Controller tests cover recovery of
previously rejected updates and removal of previously accepted updates after a
preferred controller fork arrives.

The HTTP parity harness exercises representative orders through both servers,
including CID batch ingress with real isolated IPFS storage. The complete parity
suite also checks existing confirmation, migration, authorization, and recovery
behavior.

These are finite executable checks, **not a Lean proof of full protocol
convergence**. A formal theorem still needs an explicit model of available
chain evidence, controller authorization, migrations, duplicate representations,
garbage collection, and a refinement argument connecting that model to both
implementations. Receipt metadata itself is not promised to converge.

## Initial validation and benchmark results

- TypeScript: 760 tests passed across the full Gatekeeper run and a separate
  recovery-suite rerun. Seven disk-recovery tests initially exceeded their
  five-second timeout while Rust tests ran concurrently; all 83 recovery tests
  passed separately with unchanged timeouts.
- Full TypeScript/Rust HTTP parity passed against isolated servers and real IPFS, including the new convergence scenarios and existing protocol coverage.
- Rust: 109 tests passed; three existing tests remained ignored.
- Both ports passed all 402 signed delivery traces (390 graph permutations and
  12 controller-dependent traces).
- Package/release builds, root typecheck, root lint (two existing warnings),
  deterministic fixture regeneration, and diff checks passed.
- The recovered production snapshot was identical before/after and across ports:
  24,996 accepted DIDs and 39,519 events. Status counts, five search queries, and
  the structured query also matched each port's baseline. Canonically serialized
  accepted-history SHA-256:
  `4fa6b43cdef8c4d9a0a736d4678c3c36d3ff80562aa0fb7cdc76d45f2ca65c83`.

| Isolated startup | Main | Canonical sibling selection |
| --- | ---: | ---: |
| TypeScript | 46.71 s | 45.96 s |
| Rust | 47.08 s | 46.87 s |

These are single serial runs on a shared host, not a statistical performance
claim. The same snapshot and persistence configuration were restored for each
run, and recovered outputs were captured before resetting benchmark storage.

## PR review: pin registry

Review found that the local/Hyperswarm receipt helper is not a chain-registry
predicate: `pin` is a supported DID registry but has no chain ordering. Four
signed permutation scenarios failed before the correction. The sibling comparison
now excludes `pin` from chain priority in both ports, without changing receipt
deduplication or pinning queue behavior. The shared matrix adds 120 delivery
traces for pin-only and mixed pin/local events, including fresh/tied receipts,
late predecessors, repeated batches, and reconstruction.

Follow-up validation: 124 focused TypeScript tests and both Rust convergence
tests passed, covering all 522 shared delivery traces. Builds, root typecheck,
lint (the same two existing warnings), and deterministic fixture regeneration
also passed. The full HTTP parity suite passed again with the new pin cases.
