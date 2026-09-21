# Asset/controller convergence (B1–B3)

This work implements B1–B3 of the fixed [completion contract](protocol-convergence-completion.md). A1–A4 are merged in #1237. B1 is complete at the protocol-model boundary; B2/B3 remain open. C1–C3 remain separate fixed criteria.

## Architecture audit

Both Gatekeepers own historical controller selection in event authorization (`controllerForEvent` in TypeScript, `controller_for_event` in Rust). The low-level proof verifier receives the resulting document. Import, confirmation replacement, branch reorganization and verified replay share this path. Mediators supply chain receipts; they do not choose controller versions.

Selection first tries the receipt's authoritative chain context when registration metadata is present. Same-registry updates are bounded strictly by ordinal; other-registry updates are bounded inclusively by event time. Genesis is admitted independently of these cutoffs. Every successor must remain in the confirmed prefix, and traversal stops at the first excluded event; it never sorts or filters the history by proof time.

The candidate chain-bounded document supplies the registry used by `isAnchored`. Anchoring scans the *whole confirmed prefix*, not just that time-bounded prefix. A matching chain receipt without registration metadata defeats anchoring; a wrong-registry suffix cannot establish it. Local/Hyperswarm/pin registries cannot establish chain anchoring. If that test fails, selection is recomputed using the dependent operation's proof time. Hyperswarm/pin controller times have already been normalized at import/recovery.

Agent genesis and component tables come from A's validated signed graph. Missing controller evidence produces no document. Deletion produces an explicit deleted component state, which asset authorization must reject. The current implementations admit controller genesis even when the requested cutoff predates genesis; the model preserves that behavior.

Runtime recovery keeps rejected/deferred candidates in the journal and reconstructs agent histories before assets. Self-controlled agents have no external authority dependency; assets have only agent owners, including prospective owners after transfers. B2 must exploit that dependency ordering rather than assume asset verdicts are fixed initially.

## B1 model

`ControllerSelection.lean` implements the prefix, component execution, anchoring scan and proof-time fallback. `controller_selection_same_sources` composes these functions with A3's source-derived confirmed receipt-view equality. Its premises are the existing signed graph, source/clock projection contracts, ancestry bounds and equal source evidence; equal final controller documents and equal signature verdicts are not premises.

The receipt abstraction inherits A3's source contract: chain clocks/positions are authoritative shared chain facts, while unanchored clocks are derived from operation content. A `ControllerRequest.chain` denotes such a chain receipt, not arbitrary peer metadata claiming chain authority. Direct and unanchored requests use proof time. The model is a protocol proof, not general verification of JSON decoding or malicious admin-supplied source facts.

`ControllerSelectionExamples.lean` contains kernel-checked synthetic examples for strict same-chain ordinal and inclusive cross-chain time boundaries, nonmonotone times, confirmation gaps, missing metadata, migrations, deletion and missing evidence. These are rule examples, not the signed runtime bridge required by B3.
