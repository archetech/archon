# Agent convergence domain audit (A2)

This records work under A2 of the [fixed completion contract](protocol-convergence-completion.md).
It does not add roadmap criteria. A2 is still in progress.

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
missing-position behavior were unchanged in that increment. This permits a later
preferred sibling to replace the earlier branch and replay dependents.

`tests/convergence/generate-tied-anchor-vectors.mjs` deterministically generates
the real signed fixtures. Both ports run `tied-anchor-vectors.json` through their
ordinary importer, repeat delivery, and reconstructed storage, comparing selected
operation IDs, full selected events, and resolved data. Existing distinct-ordinal
cases continue to verify ordinal precedence.

## Approved missing-position decision

The documented import event allows an omitted ordinal. The same signed A/P/B
counterexample also diverged when chain receipts omitted their ordinals. On
2026-09-20 the maintainer approved: matching-chain known positions first, canonical
operation CID otherwise. Positioned duplicates may replace an unpositioned
receipt of the same operation; they still undergo predecessor authorization.
Bundled chain mediators normally supply ordinals, but the admitted import domain
cannot silently exclude their absence.

`missing-position-vectors.json` uses the same signed operations and covers absent
ordinals, positioned versus unpositioned siblings, positioned duplicate recovery,
and wrong-chain positions. Both ports exercise import, repeat delivery, and
restart, checking the full chosen receipt as well as the operation path.

## Remaining A2 audit

The integrated Lean rank representation must account for the approved
ordinal-plus-CID comparison, including duplicate positions of the same operation.
The known-position/CID policy now resolves missing ordinals at runtime; its Lean
representation and combined-domain bridge still need to be completed.
The combined domain still needs signed coverage of unanchored/return migrations,
missing predecessors, late genesis, rotations and deletion under the integrated
A1 theorem. Semantic receipt metadata and actual stopping remain A3; the full
integrated signed translation is A4.
