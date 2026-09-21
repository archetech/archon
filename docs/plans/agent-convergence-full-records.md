# Integrated agent convergence (A2–A4)

This completes the agent-model integration criteria in the
[fixed completion contract](protocol-convergence-completion.md). The asset/controller
proof (B1–B3) is complete. C1–C3 are implemented in the [final theorem](protocol-convergence-theorem.md), including
the approved local-clock, unanchored controller-selection and richer-receipt
corrections. This is a proof of the
protocol model with a signed executable bridge, not universal verification of the
TypeScript or Rust programs.

## Pin-receipt audit and approved correction

The post-implementation audit found that the proposed unanchored operation-clock
table initially failed to model admitted `pin` receipts whose time differed from proof time.
`pin-receipt-counterexample.json` now covers both proof formats and the ordinary
importer: genesis G, parent P, a key rotation C, and an asset signed by the old key
at a time between two pin receipts of C. Both nodes retain exactly the same agent
candidate set. Their gossip order determines whether P is available when the
first C receipt is visited; an already selected pin receipt is not replaced by an
earlier one. One node retains C at September 2 and rejects the asset; the other
retains C at September 4 and accepts it. Reconstructed replay preserves the split.

Both TypeScript and Rust reproduce the split with identical retained candidate
sets. A read-only local audit of 25,956 candidate DIDs found 38 with pin-registration
candidates and zero retained pin receipts. This is an admitted-input counterexample,
not an observed production occurrence. Bundled
pinning/Filecoin mediators drain queues but do not emit pin confirmation receipts.
However, the documented protocol and earlier signed pin migration fixtures admit
those receipts. Lack of a bundled producer is insufficient to claim they are
forbidden. The maintainer approved normalizing pin receipts to `proof.created`,
matching Hyperswarm. Both Gatekeepers now do that at import and candidate recovery.
The signed regression checks equal rejected asset verdicts and repair of a stored
pre-fix projection that had incorrectly accepted the asset, in both proof formats.
Operation bytes, canonical IDs, and ordinals are preserved.

This closes the pin clock-contract gap. The later C2 audit identified a separate
local-receipt clock gap, now closed by the approved local import/recovery
normalization in #1241. Pin migration and repeated pin receipt cases
also participate in the integrated source/model/runtime bridge below.

## Result and dependencies

`Archon.integrated_agent_convergence` in `IntegratedAgentConvergence.lean` proves
that two finite delivery lists of the same protocol receipts reach equal agent
results and both stop on full record equality. The result contains canonical
operation history, complete component state (including deactivation), and the
confirmed receipt view used by controller authorization. Arrival order,
multiplicity, and arbitrary node-local bookkeeping can differ. Cold reconstruction
starts without a selected genesis or a previously accepted projection.

The proof combines these results:

- `InterleavedRecords.lean`: anchor improvements retain descendants, preferred
  siblings replace branches, and same-rank confirmation promotion settles.
  `ranked_full_converges` derives the metadata-only phase from complete rank
  selection and proves a full-record stop within `level(root) + 2` passes.
- `AgentFullRecords.lean`: A1's predecessor-document authorization and registry
  eligibility compose with this replay and the full component fold.
- `ColdInterleaved.lean` / `AgentColdRecords.lean`: a fresh virtual predecessor
  admits genesis through the ordinary selection model. The bound is
  `model.size + 3`; missing genesis yields an empty history, and an available
  genesis produces a successful component run. Unavailable predecessors cannot
  be confused with the virtual predecessor.
- `ReceiptViews.lean`: stopped records come from retained evidence. Equal rank
  availability and equal matching-rank availability give equal settled flags;
  extra nonmatching bookkeeping copies do not need equal multiplicities.
- `AgentSourceRecords.lean`: source identity contains operation, registry, and
  optional authoritative anchor class. Normalization contributes eligible chain
  ranks and provisional operation representatives. Equal source identity sets
  imply the required rank/matching sets; equal accepted histories or final
  authorization verdicts are not premises.
- `AgentReceiptViews.lean`: the resulting flags and ranks select the same
  authorization-relevant source facts. Genesis is admitted separately; the rest
  is the matching-registry prefix. An unconfirmed suffix cannot supply a cutoff.

All general results are in `AxiomAudit.lean`, with only `propext` and `Quot.sound`
allowed. The integrated theorem returns successful stopping witnesses, not merely
an equality between two optional computations that might both exhaust their fuel.
`integrated_agent_execution` establishes successful component execution when the
valid genesis is present. `agentResult` returns no component state for an empty
history.

## Source domain and interpretation

The operation table consists of immutable complete canonical operations, their
normalized predecessors, full documents, component patches, named methods, and
signature/key verification facts. Keys and methods decode from the same document
values used by component resolution. Eligibility follows predecessor state;
retained operation evidence is separate from the table, so unavailable ancestors
block selection even if descendant signatures can be described. The finite,
well-founded predecessor condition and agreed cryptographic/identity primitives
are the existing roadmap assumptions.

Receipt priority is registry-local ordinal followed by canonical operation CID.
`RegistryCidRanks` states that representation contract and
`registry_sibling_cid_priority` proves the sibling comparison. Equal registry,
ordinal, and operation keys share a rank, including repeated receipts. Registry
migration eligibility uses the predecessor's registry, not the proposed new one.
The signed bridge checks the order embedding instead of assuming distinct ordinals.

After #1236, chain events must have nonempty arrays of nonnegative safe integer
positions. Both ordinary import and replay validate that domain, and CID imports
validate the prefix before appending the source list index. Signed ordinal tests
cover rejection and recovery. The earlier missing-position fallback is superseded.
Local/Hyperswarm/pin evidence can have no position; it uses provisional CID order.
See the [producer audit](agent-convergence-domain.md).

The authorization-view tables have specific meanings:

| Input | Source | Why nodes can share it |
| --- | --- | --- |
| Operation clock | Complete operation content (local genesis `created`; normalized Hyperswarm/pin and local update/delete `proof.created`) | Complete proof is part of canonical identity, including the legacy proof format |
| Chain registry/ordinal/time | Fixed authoritative mediator/chain facts | Equal chain position classes use the same block time; receipt arrival is not the clock |
| Chain registration presence | Authoritative receipt metadata | Bundled chain mediators supply it; public relays strip chain authority |
| Confirmation flag | Receipt registry equals derived predecessor registry | Derived during normalization and settled by replay |

The view retains operation identity, matching status, chain registry/ordinal/time,
and registration presence. Those are the selected-receipt inputs read by confirmed
controller-history selection and anchoring detection. Full documents and registry
migration state are in the component result. Transaction/batch labels and other
arrival bookkeeping are excluded; they are not read by these selection rules.

This does not give arbitrary administrator-supplied envelopes authoritative status
in the model. Chain source facts come from the agreed chain view. Hyperswarm and pin
normalize to the operation clock; peer/export relay strips chain authority. The
pinning mediators consume queue entries but do not produce chain confirmations.
The model's source tables express these producer contracts; the signed bridge
checks their translation. General refinement of all ingress/codec behavior is the
separate project explicitly excluded from the frozen roadmap.

Synthetic provisional representatives cannot outrank an eligible matching chain
anchor. They establish operation ordering and do not invent additional real chain
receipts. The bridge checks the final view against the actual selected event
headers in both ports; it does not assume that arbitrary stored payload fields
are irrelevant simply because the mathematical view omits them.

## Signed bridge (A4)

`integrated-agent-vectors.json` has both proof formats and 42 scenarios, each in
three delivery orders (including duplicate delivery and genesis-last), followed
by repeat and restart phases. It combines key/registry replacement, component
replacement/carry-forward, return, Hyperswarm, and pin migrations, deletion, rejected
retired/proposed keys, rejected post-deletion updates, competing branches,
wrong-chain hints, repeated/earlier anchors with different block times, equal-position CID ties, absent
predecessors, provisional-only evidence, and an unconfirmed gap before an anchored
suffix.

`IntegratedAgentFixtures.lean` derives source, authorization, component, registry,
position, and clock tables from those signed operations. It checks source
normalization, instantiates the general integrated theorem, and independently
computes the expected cold/warm histories, components, and receipt views. Source
bookkeeping differs across the Lean delivery lists. No `native_decide` is used.

TypeScript and Rust import the same signed events and compare actual accepted
histories, full components, deactivation, and selected authorization views with
those expected values. Bridge tests reorder the operation and receipt tables,
reject detached operations and invalid authorization/registration tables, reject
missing chain positions, and reject conflicting times within one authoritative
receipt class. The latter is a source-contract test, not evidence of a reachable
mediator bug. CI regenerates the source and Lean translation and runs both ports.

B1 will derive concrete controller cutoff selection from this converged view.
That derivation and the dependent asset verdicts are not assumed or proved here.
