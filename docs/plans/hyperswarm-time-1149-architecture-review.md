# #1149 architecture review (2026-09-18)

This review motivated the revision of PR #1186 from resolver overrides to event
construction and import/recovery normalization. The implementation follows the
recommendation below; it has not been merged or deployed.

## Event ownership and actual paths

- `services/mediators/hyperswarm/src/hyperswarm-mediator.ts`, `shareDb`:
  gossip distributes operations only, stripping the exported event envelopes.
  Initial synchronization and subsequent gossip both reach `mergeBatch` and
  `importBatch`. The latter creates Hyperswarm events with local receipt time
  and ordinal `[receiptMilliseconds, batchIndex]`.
- Blockchain mediators supply chain time and chain positions through
  `importBatchByCids`. For example, the Satoshi mediator supplies `item.time`
  and `[item.height, item.index]`. Event construction belongs to the mediator.
- `packages/clients/src/gatekeeper-client.ts`, `importBatch`: Hyperswarm submits
  its envelopes through `/batch/import`. The TypeScript HTTP route calls
  `importRelayedBatch`; Rust calls `relay_hints` before batch import.
- Gatekeeper also constructs Hyperswarm hints: HTTP batch import and DID
  export/restore import downgrade relayed chain events to Hyperswarm and remove
  chain registration evidence, but currently retain the supplied time/ordinal.
  These paths do not pass through the Hyperswarm mediator.
- Direct create/update submissions initially write `local` events. They already
  use operation creation/proof time and are separate from the Hyperswarm fix.

## Why changing the mediator alone does not repair existing data

Both implementations retain durable candidates separately from accepted history.
Hyperswarm candidate identity excludes receipt time; candidate retention keeps
the first observation. Import also returns merged for operations already
confirmed on their expected registry, without replacing their event envelope.
Consequently, receiving the same operation again with a corrected time does not
repair its existing timestamp. This is current code behavior, not a hypothetical
input concern.

At startup both implementations load the candidate journal and accepted
histories, retain candidates, then rebuild accepted histories. Repairing only
accepted rows is insufficient: old candidate timestamps can restore the problem.
Recovery is the existing place to correct old envelopes before replay. No extra
full-database replay mechanism is needed.

References: TypeScript `retainCandidates`, `importEventOnce`,
`ensureHistoryReady`, `rebuildHistories` in `packages/gatekeeper/src/gatekeeper.ts`;
Rust `history.rs` candidate retention/recovery and `events.rs` duplicate import
handling.

## Isolated experiment

Used the saved September 17 production snapshot, including candidates, with the
pre-change TypeScript resolver (`event.time` selection). In memory only, changed
Hyperswarm envelope times to their operations' `proof.created`, then ran existing
startup recovery. Operation payloads, IDs, ordinals, and sequence order were
unchanged. No live database writes or service restarts occurred.

Result: 25,536 accepted histories and 40,054 accepted events, with **zero
differences in accepted operation sequences** compared with PR #1186's resolver
override on the same snapshot. Thus the observed authorization failures do not
require a Hyperswarm exception in the resolver. This comparison does not assert
full document equivalence or Rust equivalence for every timestamp representation.

Artifacts: `/tmp/1149-replay/check-normalized.mjs`, `normalized.json`,
`normalized.log`; comparison target `after.json`.

The previously documented impact remains: three blocked creations and their five
successors become accepted, along with three other deletions; five previously
accepted deletions become invalid. Moving the fix does not remove those semantic
consequences.

## Revision

1. Correct Hyperswarm event construction in the mediator to use proof time.
2. Apply the same envelope rule where Gatekeeper constructs/imports Hyperswarm
   hints, including restored histories and envelopes from older mediators.
3. Correct stored Hyperswarm candidate envelopes during existing startup
   preparation and let normal replay rebuild accepted history.
4. Remove registry-specific timestamp selection from the resolvers. Keep signed
   operation bytes, IDs, predecessor order, local/chain rules, and existing
   ordinals unchanged; changing conflict order is outside this fix.
5. Test producer/import/recovery behavior, duplicate reimports, and the observed
   authorization case, rather than testing only resolver output.

Timestamp representation also required explicit verification:
At review time Rust's event cutoff used string comparison, while TypeScript compared
Date instants. The snapshot includes proofs with microsecond precision, so
representation is not merely hypothetical. Existing accepted timestamp grammar
also permits offsets/leap seconds. The revision compares event and cutoff instants at millisecond precision in both
ports, including offsets, and tests existing microsecond proof timestamps.
Proof acceptance grammar is unchanged.

## Process lesson

Before implementing a protocol fix, trace the producer, transport, every importer,
durable evidence, and replay boundary. Identify which component owns the faulty
value and test a correction there before introducing a resolver exception.
Passing resolver tests establishes behavior, not architectural placement.
