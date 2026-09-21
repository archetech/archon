# Protocol convergence: completion contract

Baseline: 2026-09-20, merged through #1228; #1229 is pending review/merge.
Tracking: [#1215](https://github.com/archetech/archon/issues/1215).
This document supersedes the rolling “next steps” lists in the proof README and
hardening chronology. It defines the remaining work for the protocol proof, not
universal verification of the TypeScript or Rust programs.

## Target claim

> After two nodes have the same finite retained protocol evidence and that
> evidence stops changing, completing protocol reconciliation yields the same
> accepted operation history and protocol-selected DID state for every DID,
> regardless of evidence arrival order, duplicates, or previously published
> projections. Reconciliation terminates. A later change of evidence may revise
> the result; the same claim then applies to the new settled evidence.

“Protocol-selected DID state” means the ordered canonical operation IDs, the
resolved `didDocument`, `didDocumentData`, `didDocumentRegistration`, deactivation,
and the authorization-relevant anchoring/cutoff view. Nodes need not have equal
candidate-row layouts, first-receipt bookkeeping, queues, counters, or JSON bytes.
An excluded field must be proved irrelevant to selection/authorization; calling
it metadata does not establish that. Selected operation IDs alone are not enough
if different retained receipts can change an asset's authorizing controller.

“Same evidence” includes complete operation content (including proofs), canonical
identity and predecessor aliases resolved from content, and the same authoritative
registry anchors, chain positions, and block/time facts used by authorization.
The same operation bytes with different known anchors are NOT the same premise.
Missing operations are allowed: nodes must share the available evidence, not
possess an unknowable complete history. Local arrival order and receipt clocks
must not be smuggled into the shared-evidence premise to assume convergence.

The Lean endpoint is a top-level protocol theorem, provisionally named
`protocol_convergence`, that proves a unique semantic result `Canon(E)` exists
and the modeled reconciliation algorithm terminates at it for every permitted
finite delivery enumeration of `E`. Defining `Canon` alone, assuming equal final
authorization, or proving only that a chosen fuel returns a prefix does not count.
Reconciliation reconstructs from retained candidates, so a stale published
projection is not an authorization premise. Eventual convergence follows when
nodes eventually perform a complete reconciliation after the last evidence change;
this does not promise delivery, content availability, or blockchain finality.

## Fixed scope and assumptions

- Current version-1 agent and asset semantics: self-controlled agents, agent-only
  asset owners, transfers, create/update/delete, named verification methods,
  whole-component replacement/carry-forward, and existing registry migrations.
  No activation of the paused #1156 key-permission policy.
- Both proof formats; provisional CID ordering for local/Hyperswarm/pin and
  wrong-chain hints; matching-chain priority and repeated anchors; predecessor
  registry selection; missing predecessor/controller evidence and reconsideration.
- A finite predecessor graph with an explicit well-foundedness condition;
  consistent canonical identity, normalization, and protocol configuration.
  Hash collision resistance and cryptographic verification are abstract agreed
  primitives. History-dependent authorization must be derived, not an oracle.
- A fixed authoritative chain view during reconciliation. Reorganizations or
  restored/removed evidence create a new input snapshot. Successful storage and
  fair eventual reconciliation are premises, not claims about network/disk failure.
- All forms admitted by the chosen protocol domain must be accounted for. The
  strict ordinal/no-tie and all-operations-anchored restrictions of current
  migration fixtures are NOT automatically assumptions of the final theorem.
  Prove an omitted form unreachable under protocol rules, handle it, or report
  a demonstrated counterexample and the necessary protocol decision.

The 2026-09-20 chain-receipt decision requires nonempty ordinals for authoritative
chain events. Bundled mediators already produce them; public relays become
unconfirmed hints. A2 must derive this domain restriction from importer and replay
validation, rather than assuming it silently. Unpositioned local/Hyperswarm/pin
hints and tied chain positions remain in scope. See the
[producer and production audit](agent-convergence-domain.md#required-chain-ordinals-supersedes-the-1235-proposal).
This supersedes the proposed missing-position fallback in #1235, including the
receipt-time fallback for repeated unpositioned copies. The approved pin proof-time rule closes the separate receipt-clock gap. A2–A4 are completed below.

## Evidence audit

These are reusable results, not independently completed versions of the target.

| Existing result | What is established | Remaining integration boundary |
| --- | --- | --- |
| `AgentConvergence`, `OperationalReplay` | Unique canonical path and terminating cold/warm replay for a fixed acyclic authorization graph | Derive that graph from the complete protocol rules |
| `DocumentAuthorization`, `AgentComponents` | Predecessor-key/method authorization, deletion, full component fold | Component proof uses provisional ordering; general migration composition is absent |
| `ChainAnchors`, `ChainSuccessors`, `InterleavedBound`, `PriorityProjection` | Anchor minima, ranked branch selection, interleaved termination, local representation contract | Eligibility/representation premises must follow from integrated protocol semantics |
| `ChainDocuments` (#1224) | Interleaved chain priority composed with predecessor-document authorization | Registry/position eligibility is still a fixed input |
| `RegistryAncestry`, `RegistryAnchors`, `RegistryPriority` (#1226–#1228) | Predecessor registry, valid-prefix agreement, matching anchors, sibling order and compiled replay | Registry model assumes already authorized create/update operations |
| `RegistryInterleaved` (#1229, pending) | Interleaved/compiled decoded ordering agreement under a local projection contract | No derived document authorization; preferred genesis seeded in transition fixtures |
| `FullReplay`, `SerializedReplay` | Full-record stability and serialized stopping in earlier bounded models | These do not yet establish full-protocol reconciliation stopping or metadata independence |
| Shared signed TS/Rust fixtures | Finite import/replay/restart and selected-record transition correspondence | Tests do not establish universal executable refinement or convergence of candidate databases |

## Frozen deliverables

There are **three deliverables and ten acceptance criteria**, all open at this
baseline. These are completion criteria, not a promised number of PRs. Subsequent
proof PRs must identify which criterion they discharge or advance. Smaller lemmas
and regression cases stay underneath these criteria rather than becoming new
roadmap stages.

### A. Integrated agent convergence

- [x] **A1 — Derived eligibility:** one agent model combines predecessor-document
  authorization, complete component updates, registry ancestry, and per-anchor
  eligibility. Shared tables have proved identity/projection contracts; accepted
  operation sets and final authorizing documents are not assumed equal.
- [x] **A2 — Complete transition domain:** cover create/update/delete, key changes,
  competing branches, provisional and anchored evidence, return/unanchored
  migrations, missing predecessors, repeated receipts, and late genesis together.
  Resolve tied/missing ordinal and receipt-time cases against actual protocol
  admissibility rather than inheriting exclusions from the current fixtures.
- [x] **A3 — Agent result and termination:** prove unique agent histories, complete
  resolved component/deactivation state, and the authorization-relevant view.
  Prove modeled reconciliation reaches that result and really stops, including
  any selected-record changes its stop predicate observes. Establish which
  first-observation fields may vary without affecting this result.
- [x] **A4 — Agent bridge:** shared signed cases exercise the integrated theorem's
  contracts and both ports for combined key/registry changes, deletion, forks,
  earlier anchors, provisional duplicates, and cold/late-genesis reconstruction.
  General statements remain Lean proofs; these tests validate the translation.

A1 is **complete** at the model-integration boundary:
`Archon.component_anchor_from_history` in `AgentRegistry.lean` derives predecessor components and
matching-anchor eligibility; `Archon.component_event_projection` in `AgentEventProjection.lean`
proves the local representation contract from receipt ownership and normalization;
`Archon.component_interleaved_replay` composes that contract with document authorization,
interleaved/compiled ordering, and complete component execution. Methods decode
from the same full-document values returned by the component model. No equal
accepted-operation set or final authorizing document is assumed.

A2–A4 are **complete at the protocol-model and signed-bridge boundary**:
`Archon.integrated_agent_convergence` in `IntegratedAgentConvergence.lean` derives
same source rank/matching evidence, actual cold full-record stopping, and equality
of operation history, complete component state, and confirmed receipt view.
`integrated_agent_execution` gives successful component execution with an available
genesis. `RegistryCidRanks` covers ordinal/CID order including tied positions;
#1236 and its producer/import/replay audit exclude missing chain positions.

The [integrated audit](agent-convergence-full-records.md) records the source-table
contracts, receipt-field interpretation, theorem dependencies, and signed bridge.
Forty-two signed scenarios exercise both proof formats, migrations, deletion,
forks, repeated/earlier/tied anchors, missing predecessors, unconfirmed suffixes,
and cold/late-genesis replay in both ports. The signed pin audit led to the approved proof-time normalization rule; both ports
now converge on asset verdicts and repair stored pre-fix projections. Lean checks source normalization and
independently evaluates the expected components and authorization views. General
runtime refinement remains outside this contract. B is completed below; C remains open.

### B. Asset/controller convergence

- [x] **B1 — Controller selection:** derive the authorizing agent version from the
  converged agent history using same-chain ordinal, cross-registry block-time,
  and operation-proof-time fallback rules. Include confirmed-prefix selection,
  controller rotation/deletion, and missing controller evidence. Historical
  cutoffs needed for authorization are in scope even though general HTTP query
  behavior is not.
- [x] **B2 — Asset result and termination:** prove asset create/update/delete and
  transfer authorization from the predecessor owner and prospective-owner rules;
  derive the unique asset history and full component/deactivation state. Include
  replay of previously rejected/deferred candidates when evidence becomes
  available. Establish termination using self-controlled agents and agent-only
  owners; do not assume all dependent operations already have fixed verdicts.
- [x] **B3 — Asset bridge:** shared signed cross-port cases instantiate these rules,
  including transfers, late rotations, earlier anchors, revocation/recovery of
  previously accepted/rejected candidates, and restart from retained evidence.

B1 is implemented in `ControllerSelection.lean`: the confirmed-prefix and
historical cutoff rules derive controller components from A3's source result,
including the whole-prefix anchoring check and proof-time fallback. Named-method
verification rejects missing/deleted controllers. The [architecture audit](asset-controller-convergence.md)
records both ports and the existing source contracts.

B2 is implemented by `integrated_asset_convergence`, `asset_source_execution`,
and the authorization/provenance/component/priority lemmas in `Asset*.lean`.
The endpoint derives controller histories from shared A3 source evidence and requires
the ordinal/CID ordering contract. Asset verdicts are derived per receipt from B1 and the signed predecessor owner;
reconciliation considers the whole retained journal and proves actual full-record
stopping and successful component execution. The signed B3 bridge is completed below;
synthetic kernel examples are not runtime correspondence proofs.

B3 is complete at the signed-bridge boundary: `AssetControllerFixtures.lean` and
`AssetFixtures.lean` instantiate source reconstruction, receipt authorization,
complete asset results and `integrated_asset_convergence` from shared signed
operations. Seventy evidence scenarios plus ten staged recovery cases run in both
ports across three delivery orders, repeated import and actual JSON-storage reopen.
Coverage includes transfer, late rotations, earlier/tied anchors, missing/deleted/
nonagent owners, relative secondary methods, migration, provisional gossip,
terminal deletion, and the local-controller restriction. CI regenerates signatures
and checks the bridge before building Lean. This is finite runtime correspondence,
not universal executable refinement. See the [audit](asset-controller-convergence.md).

### C. Close the protocol theorem

- [ ] **C1 — Composition:** compose A and B into `protocol_convergence` over any
  finite set of agent/asset DIDs. Prove uniqueness, complete modeled reconciliation
  termination, arrival-order/duplicate independence, and reconstruction independent
  of a stale accepted projection. State the eventual-settled-evidence corollary.
- [ ] **C2 — Assumption/domain audit:** every premise is an explicit primitive or
  justified protocol condition. No circular shared-authorization assumption, hidden
  unique-anchor restriction, unexplained local timestamp equality, or fixture-only
  restriction may substitute for a missing argument. Any reachable protocol
  counterexample blocks completion until resolved; it is not renamed a limitation.
- [ ] **C3 — Release the claim:** CI checks the top-level theorem with the existing
  `propext`/`Quot.sound` allowlist and no admitted proofs. Document its exact inputs,
  output equality, assumptions, theorem dependencies, and finite runtime bridge.
  Close #1215 when A1–C3 are satisfied; do not hold it open for the separate work below.

## Separate work, not prerequisites for this claim

Universal refinement of TypeScript/Rust code, proof of cryptographic primitives,
general JSON/HTTP codec correctness, byte-for-byte API-response equality, arbitrary
external time/version queries, durable-storage/concurrency correctness, and the
network/mediator liveness model are separate projects. So are proving the GC
policy preserves information and convergence when nodes retain different evidence.
Their absence must remain documented, but must not silently extend this roadmap.

This separation does not excuse behavior needed by the target: controller cutoffs
belong to B1; metadata that affects authorization belongs to A3/B1; the modeled
stop predicate belongs to A3/C1. Restart is tested as reconstruction from the same
retained evidence; it is not a proof of every database recovery path.

## Scope-change rule and status reporting

Report the same criterion IDs on each update: completed / in progress / open,
plus the PR or theorem that supports a status change. Do not replace completed
items with newly invented “next steps” or quote a percentage from PR counts.
A newly discovered missing argument is recorded under the criterion it blocks.
If it requires changing the target, premises, protocol behavior, or these ten
criteria, record the concrete reason and ask for that scope decision explicitly.
Do not add speculative safeguards; establish protocol reachability with real
signed operations and ordinary ingress before proposing a behavior change.
