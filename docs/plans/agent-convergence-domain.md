# Agent convergence domain audit (A2)

This records work under A2 of the [fixed completion contract](protocol-convergence-completion.md).
It does not add roadmap criteria. A2 remains open; see the pin-receipt counterexample in the
[integrated agent model and signed bridge](agent-convergence-full-records.md).

## Reachable equal chain positions

The bundled chain mediators call `importBatchByCids` with ordinal
`[height, index]`; Gatekeeper appends the original operation-list index.
In the Solana mediator, `index` is the instruction index within each transaction,
not the transaction's block position. Distinct transactions in the same block
can therefore produce the same complete `[height, instruction, opidx]` ordinal.
No malformed operation or forged receipt clock is needed for this collision.
This is a protocol-reachable synthetic case, not a claim of an observed production fork.

The signed fixture contains genesis G, update P, and two competing children A/B.
The generator chooses canonical CIDs with `A < P < B`. P, A, and B have distinct
transaction/batch references but the same Solana-style ordinal. Both nodes retain
exactly the same five events: gossip G/P and the three anchors. Only G/P delivery
order differs.

Before the fix, ordered G/P hints make P available before A's anchor, so A wins.
Reversed hints initially defer P; sorted chain events visit A (still deferred),
then P, then B. On later passes, A cannot replace B at an equal ordinal. Ordinary
imports, duplicate delivery, and restart preserve these different histories.
TypeScript reproduced this with both proof formats, and Rust reproduced it with
the same modern signed fixture. The committed shared suite validates both proof
formats in both ports after the fix.

## Approved selection decision

On 2026-09-20 the maintainer approved canonical operation CID as the tie-breaker
for equally anchored competing operations, preserving ordinal precedence.
Both present ordinals are compared first; equal ordinals compare complete
canonical operation IDs in ASCII order. Repeated anchors of one operation and
missing-position behavior are unchanged in this increment. This permits a later
preferred sibling to replace the earlier branch and replay dependents.

`tests/convergence/generate-tied-anchor-vectors.mjs` deterministically generates
the real signed fixtures. Both ports run `tied-anchor-vectors.json` through their
ordinary importer, repeat delivery, and reconstructed storage, comparing selected
operation IDs, full selected events, and resolved data. Existing distinct-ordinal
cases continue to verify ordinal precedence.

## Integrated A2 interpretation

The integrated Lean bridge checks `RegistryCidRanks` against ordinal-plus-CID
order and quotients identical registry/position/operation keys. It checks both
proof formats with combined registry/key changes, deletion, return and unanchored
migrations, missing predecessors, and late genesis. The source model separates
receipt identity from node-local bookkeeping. The linked integrated audit states
the authoritative clock/registration contracts and their signed runtime checks.

## Required chain ordinals (supersedes the #1235 proposal)

The maintainer chose to require chain positions after tracing actual event
producers. Bitcoin, Zcash, Ethereum, and Solana mediators all pass `[height, index]`
to `importBatchByCids`, which appends the batch operation index. Public peer/export
imports strip chain authority and become Hyperswarm hints. The missing-position
counterexamples used the permissive core importer; no bundled mediator producing
such receipts or production occurrence was demonstrated.

The 2026-09-20 read-only audit of the local running Rust/Redis node found 292
accepted chain receipts and 295 retained chain candidates across BTC, ZEC, ETH,
and SOL registries. None had missing, null, empty, non-array, negative, fractional,
or unsafe-integer ordinal components. The scan covered `archon/dids/*` and
`archon/candidates`, excluding local/Hyperswarm/pin; it is a live local audit, not
an assertion about every database worldwide.

Both importers now require a nonempty ordinal array of nonnegative safe integers
for chain registry events, including before the CID importer appends an operation
index. Replay excludes absent/null/empty ordinal candidates in existing typed
journals; these remain retained but cannot enter accepted histories. Positioned
recovery remains possible. No compatibility decoder is added for malformed stored
field types that Rust could not previously load; the audit found none.
This supersedes retaining missing-position chain evidence via CID ranking and
choosing a time for repeated unpositioned receipts. No receipt-time fallback is
needed for this excluded input class. The proof domain must derive positioned
chain evidence from these validation rules, while retaining unpositioned gossip
and tied chain positions. This eliminates the demonstrated missing-position
counterexamples; it does not by itself finish A2–A4 or prove all receipt metadata
irrelevant to authorization.
