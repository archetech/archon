# Archon protocol convergence

The [frozen completion contract](../../docs/plans/protocol-convergence-completion.md)
has A1–A4, B1–B3 and C1–C3 implemented. The approved clock, chain-context
and richer-receipt corrections resolve the signed C2 counterexamples; see the
final audit below. `Archon.protocol_convergence` proves a unique complete semantic result and
actual terminating reconstruction for any finite family of agents and assets
with the same retained protocol evidence. Arrival order, duplicate count,
first-observation bookkeeping and previously published projections may differ.

The result includes operation histories, complete DID components, deactivation
and the authorization-relevant receipt view. Assets consume the histories returned
by the completed agent replay phase. `protocol_eventual_convergence` covers
reconciliation after evidence settles. See the [final theorem and premise audit](../../docs/plans/protocol-convergence-theorem.md)
for the exact contracts, dependencies and signed runtime bridge. CI builds the
endpoint and permits only `propext` and `Quot.sound` transitively.

The sections below retain the earlier theorem inventory and historical limits.
Their “next” lists are historical, not additional completion criteria. Universal
TypeScript/Rust refinement and the other explicitly separate projects remain
outside the protocol-proof scope.

The model assumes each DID has one content-addressed genesis and every receipt
belongs to its operation's target. Issue #1248 found that runtime envelope routing
did not enforce that admission boundary: misaddressed signed genesis operations
could produce order-dependent histories. Both importers now reject contradictory
targets before deduplication and apply the same check during replay. The final
agent/asset fixture bridge checks explicit envelope targets as well as its existing
genesis and signed-successor identity checks; negative generator tests cover all
three operation kinds. Shared signed `event-target-vectors.json` exercise ordinary
imports, direct submission, replay, custom prefixes and durable
restart in both ports. These admission tests close the demonstrated runtime gap;
they do not turn the existing protocol theorem into universal runtime refinement.

## Earlier agent-only results

This Lean project proves a bounded specification and an operational replay
model of Archon's canonical-CID successor rule. The original agent-only increments changed no runtime code. The final protocol
composition includes the approved local receipt-clock correction. It uses Lean's standard library only;
there is no Mathlib dependency.

The original agent-only result is:

> For one fixed agent model with finite, acyclic authorized predecessor edges,
> the same retained operation evidence determines the same unique complete
> canonical history, regardless of delivery order or duplicate deliveries.
> The modeled insertion/repeated-pass replay loop terminates with that complete
> history, including when genesis or another predecessor arrives late.
> The combined event model also terminates when equality compares all record
> fields, with metadata promotion and branch replacement in the same passes.
> This result transfers to serialized equality when the modeled codec has a
> decoder round trip; that codec premise remains explicit.

The result quantifies over arbitrary finite models and evidence lists. It is not
limited to the four-operation test graphs.

## Assumptions and exact meaning

These are the original fixed-key model assumptions. The [authorization extension](#predecessor-key-authorization--1209) replaces the fixed-key restriction with predecessor-selected rotation and deletion. The [document extension](#multiple-verification-methods--1211) then adds multiple methods; their respective boundaries are stated below.

- Both nodes agree on the same unique valid genesis/root ID and use the same
  model. The root has no predecessor and is eventually included in retained
  evidence. Cold replay starts without an accepted genesis and installs it only
  when its candidate is processed. Genesis signature/type validation is assumed;
  HTTP unknown-DID replies are not modeled.
- Each distinct canonical operation CID is represented by its rank in ASCII CID
  order, from zero to `size - 1`. This mapping is injective and order preserving.
  `size` is a sentinel, never an operation. Canonicalization, hashing, signatures,
  collision resistance, and retrieval aliases are outside the proof.
- Successors are data-only updates for one self-controlled agent with a fixed
  signing key. `authorized` is a fixed Boolean predicate, shared by both nodes.
  The model can ignore unauthorized evidence, but does not implement signature
  verification or prove that either Gatekeeper's authorization verdict is correct.
- `parent` is the normalized signed predecessor relation. Each eligible edge
  strictly decreases a natural-number `level`. This is an explicit finite acyclic
  graph assumption, independent of CID priority. We do not infer acyclicity from
  numerical CID order or claim to prove it cryptographically.
- All competing events are provisional for sibling ordering, including local,
  Hyperswarm, and pin evidence. There are no competing expected-chain
  confirmations, registry migrations, key changes, deletions, asset controllers,
  time-bounded queries, or representation-dependent authorization decisions.
- Evidence is retained. The two lists need the same membership, not the same
  order or multiplicities. An unavailable predecessor can be absent from that
  evidence; its candidate stays deferred. Garbage collection, network delivery
  guarantees, storage failures, and concurrent publication are outside the model.

The cross-node invariant is the accepted operation-ID path, including genesis.
The combined model also proves full-record stability within each replay, but
makes no claim that receipt timestamps, queues, counters, or all resolution
metadata become identical across nodes.

## What Lean checks

| Declaration | Result |
| --- | --- |
| `winner_member`, `winner_le_member` | A selected child is retained and eligible, and no eligible retained child has a smaller ID. |
| `winner_same_evidence` | Sibling selection depends only on evidence membership. |
| `history_delivery_permutation` | Reordering deliveries does not change the selected history. |
| `history_duplicate_delivery` | Delivering the entire journal again does not change the history; `history_same_evidence` covers arbitrary duplicates. |
| `suffix_complete` | The depth bound is sufficient to reach a terminal branch, rather than truncate a still-extendable history. |
| `complete_unique` | There is only one complete canonical successor path for a given root and evidence. |
| `terminal_histories_agree` | Any complete canonical selections from the same evidence agree, not just two executions of one function. |
| `convergence` | Abstract reconciliation gives equal complete histories from the same evidence, regardless of the previous projection. |
| `import_eq_insert` | Duplicate-checking, early-return predecessor lookup agrees with the simpler path-scanning insertion used by the proof. |
| `rounds_eq_suffix` | From any retained valid path, full replay passes reach the canonical suffix within the graph-level bound. |
| `operational_replay_converges` | Warm replay's stop-on-unchanged loop terminates within `level(root) + 1` complete passes and returns the canonical suffix. |
| `cold_replay_converges` | Cold replay, including late genesis, returns the canonical history within `level(root) + 2` passes. |
| `cold_replay_same_evidence` | Operational cold replay agrees for any two evidence lists with the same membership, including different orders and multiplicities. |

`winner` folds over the actual evidence list, taking the minimum eligible ID.
`suffix` repeatedly selects a child. Its recursion terminates on a depth bound;
`suffix_complete` proves that the explicit level assumption prevents this bound
from hiding further eligible successors. `Complete` itself has no fuel parameter.

The main theorems depend only on `propext` and `Quot.sound`, standard Lean logical
axioms. `AxiomAudit.lean` is a default build target: it uses Lean's transitive
axiom collector to reject any dependency outside that allowlist. The audit is
therefore enforced by `lake build`, not just printed for manual inspection.
There are no project axioms, admitted proofs, or `native_decide` shortcuts. All
Lean modules treat warnings as errors, so unfinished proofs fail the build.
Concrete examples use kernel-checked `decide`, reduction, and the proved
iteration-to-fixed-point theorem.

## Relationship to Gatekeeper

The specification models the decision in
[`importEventOnce`](../../packages/gatekeeper/src/gatekeeper.ts) and
[`import_event_once`](../../rust/services/gatekeeper/src/events.rs): among eligible
provisional siblings, keep the smallest canonical CID. It also models retained
candidates and reconstructing the accepted projection from that evidence.

`OperationalReplay.lean` models the importer separately from the canonical
projection. Its executable insertion/replay functions never call `winner`,
`suffix`, or `history`. They perform duplicate detection, predecessor lookup,
append, smaller-CID sibling replacement with suffix truncation, and repeated
complete scans with the stop-on-unchanged check.

| Implementation behavior | Operational model |
| --- | --- |
| Duplicate operation ID leaves the selected operation path unchanged | `importCandidate` membership check |
| No accepted predecessor defers the candidate | `lookupInsert` reaches the end without a matching predecessor and leaves the path unchanged |
| A successor of the current tip appends | `lookupInsert` matching leaf |
| A preferred sibling discards the displaced suffix | `lookupInsert` smaller-ID branch |
| Startup starts with an empty accepted history | `coldPass` starts at `none`; only the root candidate creates a history |
| A whole candidate pass repeats until the history is unchanged | `untilStable`; cold replay accounts separately for the first genesis-loading pass |

The proof first relates an easier path-scanning insertion to early-return
predecessor lookup on valid acyclic paths. A full pass installs the minimum
retained eligible child. Once installed, that child cannot be displaced, so
subsequent passes work on its suffix. Induction on the explicit graph level
proves a pass bound. Reaching the canonical path also makes the next pass
unchanged, so the stopping loop cannot exhaust its bound or stop on a different
history. `untilStable` returns `none` on bound exhaustion, rather than a
successful truncated path. Cold replay also returns `none` when genesis is
absent; the cold convergence theorem requires genesis in retained evidence.

**This proves refinement between Lean models, not verification of the actual
TypeScript or Rust executables.** `OperationalReplay` compares operation-ID
paths; `FullReplay` below extends the result to structural equality of full
records. Runtime serialization, queues, caches, I/O failures, and concurrent
publication are outside these proofs. The pass bounds apply to these Lean models.
Source inspection and shared signed fixtures connect them to Gatekeeper behavior,
but are not a formal compiler/source refinement proof.

The same complete finite evidence list is scanned on every pass. The theorem
allows any ordering and duplicates in that list; it assumes processing completes,
without interleaved evidence mutation. Runtime partial/incremental evidence is
covered only when a reconciliation has its complete retained snapshot.

`generate-fixtures.mjs` bridges the existing
[shared signed fixtures](../../tests/convergence/vectors.json) into Lean:

1. Require exactly one genesis, locate its operation index, and require every
   successor document to contain exactly `didDocumentData`.
2. Sort complete canonical CIDs in ASCII order and assign numeric ranks.
3. Translate predecessors and derive a finite depth witness from the graph.
4. Generate a checked acyclicity proof for every fixture model.
5. For each of 420 eligible delivery traces, check the canonical projection,
   operational cold replay, and cold replay with the evidence repeated in reverse
   order against the expected history already checked by both Gatekeepers. This
   gives 1,260 kernel-checked history equalities.
6. Check the full-event cold replay's ID projection twice for each trace: once
   with opaque nonpreferred receipts, and once with reversed preferred duplicates
   appended. These are synthetic metadata stress cases, not translations of the
   runtime receipts; they add 840 checked projections (2,100 total). The separate
   record bridge below checks actual complete signed event payloads.

The bridge excludes chain/foreign-anchor scenarios and controller-fork fixtures.
It does not recheck signatures: the existing TypeScript/Rust tests do that. The
bridge is test evidence connecting the model to implementations, not a formal
proof of the generator, CID-ranking abstraction, or either runtime.

## Full event records after path selection — #1203

`EventRecords.lean` proves the duplicate-replacement phase separately. For an
already settled operation path and fixed authorization/registry expectations,
a complete journal scan settles every representation. A second scan leaves the
**entire record** unchanged. The stop-on-record-equality loop therefore returns
within two scans. Once settled, any subset, permutation, or repetition of the
same evidence is inert.

`EventRecord` contains an operation ID, a Boolean indicating equality to the
expected registry, and an arbitrary payload representing all other event fields.
An expected-registry record stays unchanged; otherwise a matching, authorized
expected-registry receipt replaces it. A different operation ID cannot replace
that record. Expected registry does not mean blockchain confirmation: `local`,
Hyperswarm, and `pin` can be the expected registry too.

| Declaration | Result |
| --- | --- |
| `settled_scan_unchanged` | After one complete per-record scan, any further scan of retained evidence is inert. |
| `record_pass_eq_map` | Scanning events over a fixed history equals independently settling each record. |
| `record_pass_preserves_path` | Representation changes preserve every selected operation ID. |
| `record_pass_idempotent` | A second complete scan preserves all record fields. |
| `record_loop_terminates` | The full-record equality loop terminates within two passes in this phase. |

The model assumes unique operation IDs in the accepted path, as in Gatekeeper;
its map then updates the same single record as the duplicate lookup. It assumes
all modeled promotions pass authorization, fixed registry expectations, and no
candidate can append, replace a sibling, or remove a selected operation. Events
outside the selected path are inert in this phase. It does not establish these
conditions for the combined runtime replay loop. `FullReplay` now proves the
projection and composition for its bounded Lean importer, as described below;
that additional proof is necessary before combining the two phase bounds.

The shared `tests/convergence/record-cases.json` references real signed operations
from `vectors.json`. Both ports check complete records after ordinary imports,
reverse duplicate delivery, and startup recovery. The cases cover promotion of
both genesis and an update, nonpreferred receipts, and competing receipts from
the expected registry. The generator maps those complete JSON event payloads to
Lean strings and checks 12 full-record equalities across four cases. JSON strings
are opaque payloads here; their generation and equivalence to either runtime's
serialization are tested abstraction boundaries, not formally proved ones.

Two cases deliver the same local receipts in different orders. Their operation
paths agree, but their retained ordinals differ: the first expected-registry
receipt wins. Thus stability within one replay must not be described as identical
metadata across nodes. This result introduces no new protocol behavior.

## Combined full-event replay — #1205

`FullReplay.lean` executes duplicate promotion, predecessor lookup, append, and
smaller-CID suffix truncation in the same scan. It never calls the canonical
projector. A warm history contains a genesis record and a successor list; cold
replay starts at `none` and accepts the unique valid genesis only on its arrival.
The stopping loop compares the entire history structurally, including arbitrary
payloads, rather than comparing operation IDs.

| Declaration | Result |
| --- | --- |
| `event_import_ids`, `event_pass_ids` | Projecting the full-event importer and scans to IDs gives exactly the earlier operational importer and scans. |
| `event_pass_complete` | A complete canonical path admits only metadata changes, so its event scan equals the already-proved record scan. |
| `valid_path_nodup`, `history_step_genesis` | Valid acyclic paths have unique IDs; a duplicate genesis can promote its own record but cannot change successors. |
| `full_warm_converges` | From a valid retained successor path, the full-record loop terminates within `level(root) + 2` passes with canonical successors, unchanged genesis ID, and a fixed full history. |
| `full_cold_converges` | With genesis retained, cold replay terminates within `level(root) + 3` passes, with the complete canonical ID history and fixed full records. |
| `full_cold_same_operations` | Equal operation-ID evidence membership gives equal final ID paths, despite different receipt order, multiplicity, or representations. |

The proof first lifts the old path bound through the exact projection lemma.
After at most `level(root)` warm scans, the selected path is complete. The
complete-path lemma proves that only metadata can change from then on. One scan
settles those records, and one unchanged scan detects the fixed point. The
stopping-loop proof also rules out stopping early at a different fixed point.
Cold replay adds the initial genesis-loading scan. These are upper bounds, not
new runtime iteration limits, and no oscillation safeguards are introduced.

This composes the previously separate phase results. The fixed-authorization,
provisional-only, fixed-registry, finite-evidence and acyclic-edge assumptions
remain. Signature validity, receipt-dependent authorization, and canonical CID
identity are still supplied by the model rather than proved. Incoming and stored
records carry the fixed expected-registry classification; the model does not
compute registration policy or implement chain confirmation priority. Warm
canonical-genesis interpretation requires the supplied genesis record to have
the root ID; cold replay establishes that condition itself.

The record bridge now checks full cold replay against six signed receipt cases,
including promotion followed by branch truncation and reversed predecessors with
late genesis. Both ports check their complete records through imports, duplicate
delivery, and restart. The six additional cold equalities plus the original 12
settled-path equalities give 18 full-record examples. They use the checked
iteration-to-fixed-point theorem and kernel reduction. Complete JSON strings
are defined as opaque payload constants: the proof preserves those exact values
without reducing their bytes during concrete stopping-loop elaboration. Named
expected pass states let the kernel check one scan at a time instead of repeatedly
expanding nested scans. These states are checked equalities, not
assumptions. This adds no axioms or assumptions about payload equality.

Runtime serialization and implementation refinement remain explicit boundaries.
The next result below formalizes the required codec condition and strengthens the
runtime pass bridge without claiming to verify either JSON implementation.

## Serialized stopping and runtime pass bridge — #1207

`SerializedReplay.lean` proves the serialized stopping check equivalent to
structural stopping when equality of encodings implies equality of modeled
states. A partial decoder round trip is sufficient to establish this property.
The proof also removes the separate-first-pass wrapper: a single loop starts
empty, performs the initial equality check, and reaches the same canonical
history within `level(root) + 3` passes.

| Declaration | Result |
| --- | --- |
| `encode_reflects_of_roundtrip` | A decoder that recovers every modeled state from its encoding establishes equality reflection. |
| `encoded_stop_eq`, `encoded_stop_eq_on_orbit` | Faithful encoded comparison and structural comparison have the same result at every fuel bound; the latter needs reflection only between adjacent states of this replay. |
| `full_cold_loop_converges` | One structural stopping loop, starting empty and including its first comparison, terminates with canonical IDs and fixed full records. |
| `history_wire_roundtrip` | The empty/root-first array representation preserves the modeled optional genesis/suffix state exactly. |
| `serialized_array_converges` | Array serialization with a decoder round trip along the replay preserves the full cold convergence bound and result. |

`historyWire` maps `none` to an empty array and an accepted history to its genesis
followed by successors. This layout conversion is proved lossless. The subsequent
serializer/parser round trip is a **premise on reachable replay states**, not
a proved fact about JavaScript, RFC 8785, or serde. No codec law is required for
arbitrary records with inconsistent derived fields or non-JSON payloads. In particular, arbitrary
JavaScript objects, prototypes, `undefined`, and alternate JSON text formatting
must not be silently treated as distinct modeled states that JSON preserves.
The TypeScript bridge compares JSON values after omission/normalization, not
JavaScript object identity or prototypes.

The shared signed record cases now drive ten per-pass traces in each port:
six cold traces and four warm metadata-only traces. Tests call the exact
`importEventOnce` / `import_event_once` routines invoked inside production replay,
scan the fixed fixture order, and compare complete histories with the pass states
already checked by Lean. They check the final unchanged pass using the actual
TypeScript `canonicalizeJSON` and Rust `serde_json::to_string` calls, verify decoder
round trips for observed states, and compare each serialization stop decision
with record equality. Warm promotion exercises a change in metadata while IDs
remain unchanged; late genesis exercises multiple changed scans before stopping.

These tests establish correspondence for those traces. They do not prove the
codec premise for every possible record, extract either runtime into Lean, or
exercise the production candidate sorter/overlay in isolation. The existing
public import, reverse-duplicate, and restart tests continue to cover that outer
path. The formal model permits arbitrary fixed scan order. Canonical identity,
authorization, normalization of all possible candidates, storage, and concurrency
remain explicit implementation obligations.

CI runs the TypeScript pass bridge alongside the proofs and runs Rust convergence
unit tests with the production Rust 1.90.0 toolchain. The workflow now also triggers
on Gatekeeper implementation and bridge-test changes. Runtime code is unchanged.

## Predecessor-key authorization — #1209

`AgentAuthorization.lean` extends the model to a self-controlled agent with one
active verification method/key, key-preserving updates, replacement of that key,
and deletion. Authorization is derived recursively from the signed predecessor
chain. A rotation must pass verification with the predecessor's key before its
new key takes effect; a deleted predecessor authorizes no successor. A preferred
sibling can still replace a deleted branch through its live predecessor.

The graph has a finite operation domain and a topological depth witness. Both
nodes agree on the graph, valid genesis, and the signature/method-validation
oracle (`validBy`). Key identities include method identity and permissions. The
oracle is fixed for these immutable operations, but the key checked at each
operation is derived from its predecessor, not fixed across the history.
`agent_authorization_matches` proves that the derived predicate used by replay
agrees with that state transition. `valid_agent_path_runs` proves that replay's
accepted path can actually execute those transitions in sequence.

`rotating_agent_converges` instantiates full-event replay with this derived
predicate: replay terminates at a fixed full-record history, its IDs are the
canonical path, and its final active key or deleted state agrees with predecessor
reconstruction. `rotating_agent_same_evidence` proves equal ID histories **and**
equal final key/deletion states for the same retained operation membership,
regardless of order or duplicates. These statements quantify over arbitrary
finite graphs satisfying the premises, not just the fixtures.

The signed bridge adds 456 delivery traces across legacy and modern proofs.
Both ordinary runtime importers check competing rotations, stale update/delete
keys, a proposed key signing its own rotation, an invalid ancestor, wrong-branch
keys, a child of deletion, and replacement of a deleted branch. They compare ID
histories and final key/deletion states after delivery, reversed repeats, and
restart. The generator derives signature validity using the real verifier and
maps CIDs to sorted ranks. Lean independently checks all 24 reconstructed
operation states and all 456 replay results from those tables. The bridge derives
the unique genesis, initial key, predecessors, and update actions from operation
records, rejects shapes outside this single-key subset, and cross-checks stored
graph annotations. Generator tests cover reordered tables and unsupported shapes.

This does not prove cryptography, arbitrary DID-document updates, multiple
simultaneous verification methods, capability-permission migration, assets, or
chain-priority behavior. The oracle and mapping to executable validation remain
explicit abstraction boundaries. Runtime tests provide finite correspondence
evidence; the TypeScript/Rust source is not formally verified. No runtime code
changes are needed.

## Multiple verification methods — #1211

`DocumentAuthorization.lean` lifts the previous state/replay proof to an active
verification-method list. An active index now selects an immutable document
snapshot, and a `rotate` action replaces that list. Method names and public keys
have separate identities: replacing the public key under the same method name
changes which signature verifies. `documentKey` selects the first method whose
normalized ID matches the proof, exactly as both runtime lookups do.

`document_replacement_uses_predecessor` proves that introducing or replacing
methods requires authorization by the predecessor list. `document_replay_converges`
proves a canonical ID path, full-record replay stability, and successful sequential
authorization. `document_same_evidence` additionally maps the final active index
to the method list: equal retained evidence produces the same history and final
method list (or deletion), regardless of order or duplicates. The inherited
finite acyclic graph, agreed snapshot, valid genesis, and retained-evidence
premises remain explicit.

This models version 1 as implemented: the proof names a method and verification
uses its key. Accepted proof-purpose labels **do not** enforce membership in the
`authentication`, `assertionMethod`, or `capabilityInvocation` arrays. #1156 is
still paused; the proof introduces no stricter rule. Well-formed admitted proof
formats and public keys, signature verification, and normalization/injective
encoding of method IDs and keys remain bridge assumptions. The model includes
ordered method lists, not arbitrary malformed method objects.

612 additional signed delivery traces cover both proof formats, second-key
signing without relationship membership, removal, same-name public-key
replacement, competing document branches, missing methods, deletion, and a new
method trying to authorize its own introduction. Both runtimes compare accepted
IDs and full verification-method arrays after ordinary imports, repeated
delivery, and restart. Lean checks 26 reconstructed states and the same 612
replay results. The structural bridge derives genesis, document snapshots,
actions, and predecessor edges from operation records; reordering and negative
tests keep that translation checked. These finite tests do not prove executable
correctness or cryptography.

The final-state claim concerns verification methods. Other agent-document
components and general combined updates, expected-chain priority, asset
controllers, retention, and executable refinement remain open. No runtime
behavior changes.

## Complete document components — #1213

`AgentComponents.lean` adds the three resolved payload components:
`didDocument`, `didDocumentData`, and `didDocumentRegistration`. Active document
indices now decode to complete immutable DID-document values, with an explicit
contract that their method-list projection agrees with the authorization model.
Both component convergence theorems require that agreement, and component
execution uses methods decoded from the same full-document values returned by
resolution (`decodedComponentGraph`). The fixture module proves the projection
for every document index and instantiates `component_document_authority`; it
does not assume agreement between independent tables. Data and registration are arbitrary opaque
values in Lean. The JSON encoding/decoding contract remains outside the proof.

`componentStep` first authorizes against the predecessor document, then replaces
supplied components and carries forward omitted components. It does not merge
members inside a supplied component. A document change can accompany a data or
registration change in the same operation. Deletion returns the DID-only document,
clears data, and preserves registration; metadata is modeled separately in future
work. `component_run_authority` proves that carrying the other components does
not change the authorization run. `component_replay_converges` proves successful
full-component execution of the canonical fixed-point history, and
`components_same_evidence` proves equality of the final decoded component triple
for equal retained evidence, regardless of delivery order or duplicates.

The general component fold permits registration values, but the sibling-order
model remains provisional. Registry migrations and changes to admission policy
are not established by this theorem. The signed bridge therefore permits only
unchanged registration replacement. Immutable agent kind, admitted operation
shapes, consistent full-document/method projection, signature validity, the finite
acyclic graph, and retention remain explicit assumptions.

456 additional signed traces per runtime check combined key/document/data updates,
service and relationship replacement, removal of old data members, carry-forward
of omitted components, competing combined branches, rejected proposed-key updates,
deletion, and empty method lists. Both ports compare the complete three components and independently check
deactivation after imports, repeats, and restart. Lean checks the same 456 component results and
24 reconstructed authorization states. Fixture JSON values are interned as opaque tokens; Lean checks each token
against its JSON string and checks component-token triples for every trace. This
avoids repeating large string reductions and does not verify a general JSON codec. Bridge tests
cover table reordering, replacement versus carry-forward, and excluded inputs.
The representative document fields include services and aliases; arbitrary
malformed JSON and executable acceptance validation are not proved.

No runtime changes or stricter key-purpose rules are introduced. Expected-chain
ordering, registry migrations, controller-dependent assets, retention/GC, metadata,
and executable refinement remain open.

## Reproduce

Install Elan using the [official Lean instructions](https://lean-lang.org/install/manual/).
The committed `lean-toolchain` pins Lean 4.34.0; Lake downloads that version.

From the repository root:

```sh
node proofs/agent-convergence/generate-fixtures.mjs --check
node proofs/agent-convergence/generate-record-fixtures.mjs --check
node proofs/agent-convergence/generate-agent-fixtures.mjs --check
node proofs/agent-convergence/generate-document-fixtures.mjs --check
node proofs/agent-convergence/generate-component-fixtures.mjs --check
cd proofs/agent-convergence
lake build
```

Those commands check the committed inputs without an npm installation or package
build. To check the full source-to-proof chain, use the root-pinned npm version
and regenerate the signed source vectors first:

```sh
npm ci
npm run build -w @didcid/common
npm run build -w @didcid/cipher
npm run build -w @didcid/ipfs
node tests/convergence/generate-vectors.mjs
node tests/convergence/generate-agent-vectors.mjs
node tests/convergence/generate-document-vectors.mjs
node tests/convergence/generate-component-vectors.mjs
git diff --exit-code -- tests/convergence/vectors.json tests/convergence/agent-vectors.json tests/convergence/document-vectors.json tests/convergence/component-vectors.json
node --test proofs/agent-convergence/generate-fixtures.test.mjs proofs/agent-convergence/generate-agent-fixtures.test.mjs proofs/agent-convergence/generate-document-fixtures.test.mjs proofs/agent-convergence/generate-component-fixtures.test.mjs
node proofs/agent-convergence/generate-fixtures.mjs --check
node proofs/agent-convergence/generate-record-fixtures.mjs --check
node proofs/agent-convergence/generate-agent-fixtures.mjs --check
node proofs/agent-convergence/generate-document-fixtures.mjs --check
node proofs/agent-convergence/generate-component-fixtures.mjs --check
```

Run that block from the repository root. CI performs it before building Lean and
triggers on the model, generator, input vectors, and package sources. Bridge tests
cover empty update documents, missing/multiple genesis, and an operation-table
reordering that must preserve the generated model and every expected history.
To update concrete examples intentionally, regenerate source vectors, run the
bridge without `--check`, inspect both diffs, then rebuild.

CI installs Elan 4.2.4 only after checking the archive against the committed
`elan-v4.2.4-linux-x86_64.sha256`. That digest was matched against the upstream
GitHub release asset digest and the downloaded archive. An installer-version
update must also update and verify the committed checksum.

## Follow-up proof work

Use the [completion contract](../../docs/plans/protocol-convergence-completion.md)
for the target theorem, evidence definition, audited proof inventory, and fixed
acceptance criteria A1–C3. The remaining deliverables are integrated agent
convergence, asset/controller convergence, and composition of the protocol-wide
theorem. Universal implementation refinement is a separate project, not another
condition for completing this protocol proof.

The chronology below remains useful evidence of each increment's scope. It does
not replace or expand the completion contract.

## Expected-chain audit — #1215 / #1216

The first signed chain audit found a runtime counterexample: two gossip orders
could retain different anchors of one controller rotation, changing dependent
asset acceptance even after restart. #1216 lets an earlier valid expected-chain
anchor replace a later accepted copy, using the existing predecessor authorization
and dependent replay. The shared `chain-anchor-vectors.json` fixtures exercise both
ports, including an earlier invalid asset anchor that must not replace its valid
later anchor. The full asset/controller scenarios remain runtime regression tests. The controller
anchor projections now also instantiate the conditional position-selection proof
below; #1215 remains open for the broader expected-chain/migration proof.


## Repeated expected-chain anchor selection — #1215

`ChainAnchors.lean` proves that, for a settled operation path with fixed
per-anchor authorization and expected registry, one complete scan selects the
earliest valid retained anchor position. Scans may start cold or from different
valid retained anchors. Equal evidence sets give equal selected positions,
regardless of order or multiplicity, and repeating the scan is idempotent.
The proof reuses the finite minimum lemmas through `AnchorModel`: here `parent`
identifies the operation owning an anchor and `level` is unused. It does not
reuse the predecessor-graph interpretation of those fields.

The bridge maps source events to the paired operation/canonical-ID table and
derives the controller path from genesis and signed predecessor IDs. Reordering
either source table preserves the generated proof. It ranks complete chain
ordinals lexicographically and rejects ties,
missing positions, foreign registries, and migrations. It projects the controller
anchors from the signed #1216 fixtures: both proof formats, six delivery orders,
and three operations give 36 cases, each checking cold and all eligible warm
starts. Generated examples invoke the general scan theorems. CI checks the
projection, regeneration, Lean build, axiom allowlist, and existing cross-port
signed regressions.

This theorem covers positions under fixed authorization, not full event payloads
or general chain replay. The bridge assumes the controller anchors are authorized
once their signed predecessor path is settled; both runtimes check that fact in
the shared regression tests, but Lean does not verify the signatures or the
TypeScript/Rust importers. The invalid asset anchor is deliberately outside this
projection: proving changing controller cutoffs requires the asset model.
The successor composition below discharges the next conditional obligation.
The live interleaving, registry migrations, dynamic asset authorization, metadata,
and retention/GC still require further proof.

To check this increment from the repository root:

```sh
node --test proofs/agent-convergence/generate-chain-anchor-fixtures.test.mjs
node proofs/agent-convergence/generate-chain-anchor-fixtures.mjs --check
cd proofs/agent-convergence
lake build
```


## Chain successor selection after anchor settlement — #1215

`ChainSuccessors.lean` composes the anchor scan with the existing operational
predecessor replay model. An operation's earliest eligible expected-chain anchor
sets its priority; operations without one follow in canonical-CID order. The
compiled graph maps signed predecessor IDs to those priorities. Lean proves
that encoding preserves operation identity, that expected-chain anchors precede
provisional candidates, and that equal retained anchor and operation sets give
equal decoded paths regardless of scan order or duplicates. The existing cold
importer and stop-on-unchanged loop compute that path under the compiled graph's
acyclicity and genesis assumptions.

The explicit boundary is anchor settlement with fixed authorization and registry
eligibility. The runtime interleaves anchor selection and branch replay; this
increment does not prove that interleaving reaches the compiled state. It also
does not yet connect chain priorities to the complete-document authorization
model. Migrations, changing controller/asset authorization, full event metadata,
ordinal ties/missing positions, and retention remain open.

Shared signed fixtures exercise both proof formats and six delivery orders in
three cases: provisional CID preference, anchored ordinal preference overriding
CID preference, and an earlier repeated anchor changing the winning branch.
Competing branches have descendants to exercise suffix replacement. Both
runtimes check all 36 traces through ordinary imports, repeated imports, and
restart, including verified final data and retained candidate counts.

The bridge derives genesis and predecessor edges by canonical ID, checks the
same-key data-update domain, ranks complete ordinals, and instantiates the general
convergence theorem in 36 generated cases. Paired operation-table and event-table
reorderings preserve its full output. Signature verification and general runtime
refinement remain separate from this Lean model.

```sh
node --test proofs/agent-convergence/generate-chain-successor-fixtures.test.mjs
node proofs/agent-convergence/generate-chain-successor-fixtures.mjs --check
cd proofs/agent-convergence
lake build
```


## Interleaved replay: next-event settlement and transition bridge — #1215

`InterleavedReplay.lean` models one event at a time, with no preselection of the
operation's anchor. A duplicate representation can improve its priority while
preserving descendants; a preferred sibling replaces the displaced suffix.
The head of an interleaved scan provably equals the anchor-minimum scan from
#1218. Consequently, once a predecessor is fixed, one complete scan settles its
next event from any valid retained warm head or an empty suffix. Equal retained
evidence gives equal next events even from different heads and tails.

This is the local lemma needed for a whole-path induction, not yet a proof of
termination or convergence of arbitrary interleaved histories. Authorization,
expected-registry eligibility, and signed predecessor edges are fixed. The model
uses ordinal/CID priority ranks and omits event payloads; a virtual predecessor
admits genesis in concrete cold-start cases. Tied/missing ordinals, multiple
provisional representations of one operation, migrations, and dynamic document
or asset authorization remain outside this fixture domain.

The bridge reuses the signed successor fixtures and their canonical-ID-derived
graph. Lean checks 764 individual transitions and 100 complete passes across 36
cases. Both runtime tests invoke the same per-event routine used by history
replay, compare complete stored event records after every event, and check the
serialized stop-on-unchanged decision after every pass. Public-import/restart
coverage remains in the existing successor suite. These traces connect concrete
interleavings to the model; they are not a universal implementation proof.

The following whole-path theorem lifts this local result over predecessor depth.
Document authorization, registry migrations, and general executable correspondence
remain separate obligations.

```sh
node --test proofs/agent-convergence/generate-interleaved-fixtures.test.mjs
node proofs/agent-convergence/generate-interleaved-fixtures.mjs --check
cd proofs/agent-convergence
lake build
```


## Whole-path interleaved convergence and stopping bound — #1215

`InterleavedBound.lean` proves whole-path convergence for the fixed-authorization
interleaved event model. Every eligible signed predecessor edge must strictly
decrease an operation-level natural-number measure. The initial path must consist
of eligible retained events linked by their predecessor operations; the empty
cold-start path satisfies that requirement automatically.

A selected minimum head is preserved while the same scan operates on its suffix.
Induction over the decreasing measure proves that `level(parent)` complete passes
reach the canonical ranked path. One further pass suffices to observe stability.
The stop-on-unchanged loop returns that path even if it stops earlier. Equal
retained event sets therefore give equal complete ranked paths regardless of
scan order, duplicate deliveries, or different valid warm initial histories.

The signed fixture bridge derives operation levels from predecessor IDs, includes
the virtual genesis predecessor, and proves the decreasing-edge condition in
Lean for each graph. It instantiates the whole-path theorem at every recorded
pass-start state (100 cold/warm instances), preserving all 764 transition checks.
Both runtimes check complete event records and stopping within the generated
bound. Two cold cases reach the fourth and final allowed pass. This replaces the
fixture generator's arbitrary attempt limit with the instantiated theorem bound;
it does not introduce a production replay limit.

The theorem now closes whole-path interleaving **in this model**. Authorization
and expected-registry eligibility are still fixed, event identity/ordering is
abstracted by ranks, and the bridge is finite testing rather than a universal
proof that either runtime implements the model. Connecting full document/key
semantics, registry migrations, dynamic
controller/asset authorization, complete metadata/serialization, and retention
remain open. #1215 stays open for those connections.

## Interleaved and settled-priority agreement — #1215

`PriorityProjection.lean` connects whole-path interleaved replay to the prior
settled-priority model. Its local representation contract requires every eligible
raw event to have an eligible preferred copy ranked no later; compiled candidates
must be retained raw evidence and canonical representatives with in-scope owners.
The proof derives equal minimum successors, then equal complete ranked suffixes.
With genesis and depth alignment, the terminating interleaved loop and the
compiled cold replay return the same ranked history, including from valid warm
interleaved paths. Equality of histories is a conclusion, not a premise.

`PriorityFixtures.lean` checks that contract for all six signed successor graphs,
then instantiates the agreement theorem across their 36 delivery orders. Source
operation/event table reorderings leave this bridge unchanged. The existing
764-transition runtime bridge supplies finite implementation evidence for these
same graphs; this addition changes no runtime code or source vectors.

Full document/key authorization, registry migrations, dynamic assets, complete
metadata/codecs, retention, and universal executable correspondence remain open.
The theorem still assumes fixed eligibility and a common ranked evidence model.

```sh
node --test proofs/agent-convergence/generate-priority-fixtures.test.mjs
node proofs/agent-convergence/generate-priority-fixtures.mjs --check
```

## Document authorization in interleaved replay — #1215

`InterleavedAuthorization.lean` replaces the raw event model's opaque operation
acceptance predicate with the existing predecessor-document evaluator. Each event
rank decodes to an operation, whose signed predecessor supplies its authorizing
document. Named verification methods are looked up in that document; replacement
uses the old document, and deletion makes further operations ineligible. Version-1
relationship-permission policy is unchanged. Signature validity remains an input.

For a fixed decoded operation graph and signature-validity table, the proof
derives the interleaved decreasing measure from signed predecessor depth, and proves that decoding any valid event path yields an executable
operation path. The bounded interleaved loop therefore returns a canonical ranked
path whose successive document authorizations succeed and whose final state
agrees with ancestry evaluation. Equal retained event sets give equal ranked
paths and decoded verification-method/deletion results, including valid warm
starts. Event ranks may represent repeated anchors of one operation; their
registry/position eligibility remains fixed input.

The new bridge instantiates these theorems with the existing two signed document
graphs and 612 delivery orders. It checks ancestry/depth assumptions in Lean and
uses the universal convergence result before calculating the expected path and
final state. These are hyperswarm fixtures covering multiple methods, same-name
key replacement, missing/removed methods, invalid ancestry, and deletion. Existing
TypeScript and Rust import/repeat/restart tests check the same signed cases.
They do not yet provide combined chain-anchor/document-rotation transition traces.

Genesis is admitted separately, and the modeled loop starts at its document.
This closes the self-controlled document-authorization connection in the event
model, not a general proof of the executable importer. Next connect this derived
predicate to the settled-priority projection with signed chain/rotation cases.
Registry migrations, assets, full component/metadata/codec equality, changing
retained evidence, and general runtime correspondence remain open.

## Chain priorities with document authorization — #1215

`ChainDocuments.lean` composes the document-authorized interleaved theorem with
`PriorityProjection`. Under the local representative/eligibility contract, the
interleaved loop returns the settled-priority suffix, and that decoded suffix
executes using successive predecessor documents to the ancestry-derived final
state. With genesis ownership and depth alignment, prepending the selected genesis
rank identifies that result with the compiled cold replay. Decoding through the
event owner function gives the document genesis followed by the executed path. The fixture bridge checks
these conditions and the compiled decreasing-edge condition in Lean. Operation
authorization is derived, not supplied as an unrelated table;
registry/position eligibility and cryptographic signature validity remain inputs.

Four signed graphs combine two proof formats with competing document branches,
same-name methods holding different keys, descendants arriving first, repeated
anchors promoting an earlier branch, an earlier anchored operation signed by the
wrong branch's key, invalid ancestry, deletion, and a post-deletion candidate.
Lean checks the projection contract for each graph and the composed convergence
result for 24 delivery orders. The bridge also checks 920 individual transitions
and 68 passes. Both runtime tests compare complete stored event records after
each transition and the serialized stop decision after each pass. Public-import,
repeat, and restart tests check the selected path, active methods or deletion,
and candidate retention for the same signed graphs.

The transition bridge starts with the preferred genesis anchor already admitted,
matching the suffix theorem's boundary. The public-import tests also exercise
late genesis. Registry stays `BTC:signet`; hints are provisional and complete,
untied anchor ordinals supply priority. These finite traces strengthen the bridge
but do not prove either runtime implements the model for every input.

Next audit registry-migration eligibility and ordering. Dynamic asset/controller
authorization, full component/metadata/codec equality in the combined loop,
changes in retained evidence, and universal executable correspondence remain
open. This increment changes no production behavior.

## Registry-migration audit — #1215

The next phase starts with signed executable evidence; this audit adds no Lean
migration theorem. `tests/convergence/migration-model.mjs` independently derives
each operation's expected registry from its signed predecessor ancestry. It
selects matching-chain anchors and competing siblings within that registry,
without simulating Gatekeeper's insertion loop or comparing cross-chain ordinals.

Four signed graphs (two proof formats, two branch outcomes) exercise BTC-to-ZEC
versus BTC-to-ETH migrations, a return to BTC, successors arriving before their
predecessors, and an earlier repeated migration anchor displacing a branch.
Misleading migration receipts on the destination chain and successor receipts
on the old chain must not confer priority. Each graph has six distinct delivery
orders. Both ports check ordinary imports, repeats, and startup recovery against
independently selected IDs, complete event records, registration, and retained
candidate counts. All operations are signed by one unchanged agent key and all
operations have an expected-chain anchor; ties, unanchored registry migrations,
assets, missing evidence, and changing key permissions remain outside this audit.

The runtime selection rule is predecessor-based: a migration is confirmed on its
old registry, while its children use the resulting new registry. Gatekeeper owns
this decision; mediators attach discovery registry/position metadata. Durable
candidates preserve distinct anchors and replay can revisit them after a late
predecessor. A return migration does not make old-chain positions globally
comparable to the intervening chain's positions.

Next derive this expected-registry function in Lean and prove agreement with
selection on a valid path before incorporating migration eligibility into the
combined authorization/priority proof. Passing these finite signed cases is not
a universal migration-convergence claim.

Audit result: all 24 signed delivery traces pass in both implementations through
repeat import and restart, including complete stored event equality. No runtime
correction is needed for this tested domain.

## Registry ancestry agrees with a valid prefix — #1215

`RegistryAncestry.lean` models a fixed finite create/update graph with registry
replacement or omission at each operation. Strictly increasing predecessor depth
justifies ancestry evaluation; valid paths enforce operation bounds and signed
predecessor edges. A reconstructed root supplies the initial registry.

The general theorem proves that folding changes along any valid prefix produces
the same registry as independently evaluating the tip's ancestry. Consequently,
the next operation's expected registry is the fold of that preceding prefix,
excluding its own proposed change. Its resulting state includes the change and
is used by its children. Registry receipt equality agrees with this prefix rule;
it does not by itself establish chain priority for local, hyperswarm, or pin.

The bridge reuses the unchanged signed migration vectors from #1225. Across four
graphs and 24 distinct evidence orders, it instantiates 144 predecessor-prefix
obligations, 24 selected-prefix final states, and 66 receipt-registry checks.
Every branch's signed edges are checked, including displaced branches. Operation
and receipt table reordering preserves the generated Lean proof. Existing
cross-port import/repeat/restart coverage applies to these same source vectors.

This proves registry reconstruction and expected-registry selection given a valid
prefix. It does not yet prove that the importer chooses that prefix when registry
changes affect chain priority. Next compose this rule with migration-aware anchor
and sibling selection, keeping authorization, genesis, and event/operation
identity contracts explicit. Deletion, unanchored-registry migration policy,
assets, full metadata/codecs, retention, and universal executable correspondence
remain separate obligations. No runtime or signed-fixture changes are needed.

## Migration-aware anchor selection — #1215

`RegistryAnchors.lean` composes predecessor-derived registry matching with the
minimum-anchor scan. An eligible receipt must be accepted by the abstract
signature/position predicate, belong to a chain-enabled registry, and match its
operation's derived expected registry. The filter agrees with the registry at
any valid predecessor prefix. Cold scans with the same receipt set agree across
order and multiplicity; a valid retained anchor cannot bias reconstruction.

Competing siblings have the same expected registry even when their proposed
migration destinations differ. Eligible sibling anchors therefore belong to one
chain. Numeric receipt ranks must preserve ordinal order within each chain; the
relative layout of different chains does not define a cross-chain height order.

The unchanged four signed migration graphs now instantiate 168 cold selections
and 180 retained-anchor selections across 24 distinct delivery orders. All
receipts enter the Lean model, including gossip and misleading chain receipts.
The bridge checks selected receipts against the runtime fixtures' expected full
histories, checks sibling registry agreement, and remains invariant under paired
operation-table and receipt-table reordering. Structural negative tests alter
actual receipt metadata as well as expected-receipt summaries.

This is anchor selection for fixed ancestry and accepted evidence. It does not
compose migration-aware sibling choice with interleaved replay yet. Signature
and chain-position validity remain abstract predicates; cryptography, canonical
ID derivation, and universal runtime correspondence are not proven. The existing
cross-port signed tests cover these same payloads through import, repeat, and
restart; production code and signed sources are unchanged. Next connect this
filter to the combined document/priority replay theorem, including a checked
rank representation for migration-aware sibling ordering. Unanchored migrations,
deletions in this model, assets, retention, and full metadata/codecs remain open.

## Migration-aware sibling priority and compiled replay — #1215

`RegistryPriority.lean` connects the ancestry-derived anchor filter to sibling
ordering and the settled-priority replay model. `RegistryOrdinalRanks` requires
that eligible receipts on the same chain preserve the complete lexicographic
ordinal order. The sibling-order theorem consumes this contract and proves that
comparing compiled priorities is equivalent to comparing their selected chain
ordinals. The earlier sibling-registry theorem justifies that comparison; no
cross-chain position ordering is assumed.

A general lemma proves that priority compilation preserves acyclicity. Bounded,
increasing predecessor depth supplies that property for the registry graph. The
compiled replay theorem consequently derives termination from ancestry and proves
equal decoded operation histories for equal receipt and authorized operation sets,
regardless of either delivery order or multiplicity. Genesis has no predecessor
and is present in the delivered operation set.

The unchanged migration vectors instantiate 24 sibling-order comparisons and 24
compiled replay histories. Lean checks the ordinal-rank contract against every
eligible receipt pair using the source's complete ordinal arrays. The bridge
retains misleading and gossip receipts, derives operation identity from paired
CID tables, and checks the expected branches for competing migrations and return
migration. Source-table reordering remains invariant. A negative test changes the
actual winning receipt's ordinal while retaining the old expected branch.

This phase assumes an already authorized create/update graph; receipt signature
and position validity remain abstract. It does not yet establish that raw
interleaved migration replay computes this compiled history. Next connect the
migration filter and checked ordering to the local priority projection and
predecessor-document authorization, including provisional/wrong-chain duplicate
representations. The existing shared signed runtime tests remain finite evidence,
not universal refinement. Unanchored migrations, deletion in the registry model,
assets, full metadata/codecs, and retention remain open. No runtime changes.

## Interleaved registry ordering and receipt projection — #1215

`RegistryInterleaved.lean` connects interleaved ordering to compiled registry
replay under the local `PriorityProjection` contract. Predecessor depth gives the
stopping measure; admitted genesis identity is preserved in the decoded history.
The theorem covers any valid retained suffix in a fixed, already authorized
create/update graph. It does not derive signature validity or evolving controller
authorization.

The new bridge projects each matching-chain receipt to its own ordinal rank.
Gossip and wrong-chain receipts share one provisional CID rank per operation.
Sharing an ordering rank does not equate receipt metadata: the trace generator
retains the first provisional receipt until an eligible anchor replaces it.
Lean checks the representative/soundness/canonicality contract for every delivery
order and the same-chain ordinal-rank contract against complete source ordinals.

The four existing signed migration graphs supply 24 audit orders plus four
explicit wrong-chain-first orders. Across these 28 distinct orders, Lean checks
1,225 event transitions and 74 passes, and proves decoded agreement with compiled
replay. TypeScript and Rust execute the same traces through their per-event
importers, comparing the selected stored event records after every import and
the serialized selected history at each stopping decision. Tests exercise
provisional duplicates in both arrival directions and preserve results under
operation/event-table reordering.

These transition traces seed the preferred genesis separately. The existing
public-import/repeat/restart migration tests still cover late genesis and durable
candidate handling. Shared signed operation payloads are unchanged. Projected
ordering equality is proved generally; selected-history stopping agreement and
full receipt/candidate metadata remain finite runtime evidence only. Next
compose registry reconstruction and this representation with
predecessor-document authorization. Unanchored-registry migration policy, deletion
in this model, dynamic assets, full metadata/codecs, retention, and universal
runtime correspondence remain open. No production behavior changes.


## Integrated component and registry eligibility — A1, #1215

`AgentRegistry.lean` supplies the first part of A1 in the [fixed completion contract](../../docs/plans/protocol-convergence-completion.md).
`componentRegistry` derives ancestry and registration changes from the same
`DocumentGraph` and `ComponentPatch` used by component execution. The general
step/fold proofs establish that this registry reconstruction equals the executed
component's registration, including carry-forward and deletion. Full-document
methods can be supplied through `decodedComponentGraph`, as in the examples.

`componentAnchors` combines that registry with document-derived authorization.
Its receipt-admission input represents chain admission only; predecessor-key
verification is computed separately from named methods and the fixed
operation/public-key signature matrix. `component_anchor_from_history` derives
the predecessor component state from a valid document-authorized history and
proves that anchor eligibility is equivalent to receipt admission, chain policy,
matching owner and predecessor registry, and successful component execution.
A migration uses the old registry and old methods; its proposed replacements
apply to subsequent operations. No final authorizing state or accepted-operation
set is supplied to the theorem.

The premises still include an admitted bounded genesis, ordered predecessor
ancestry, a valid prefix under the derived document predicate, and an incoming
operation linked to that prefix. Registry-name decoding, chain-admission facts,
and cryptographic signature validity are abstract inputs. This is a local
eligibility/composition result, not a theorem that arbitrary raw evidence yields
that prefix or that full protocol reconciliation converges.

`AgentRegistryExamples.lean` checks combined key/registry changes, data carry,
return migration, deletion, post-deletion rejection, misleading registry receipts,
repeated anchors, and rejection of retired/proposed-key signatures. It instantiates
the general prefix theorem using methods decoded from full document values.
These are hand-written abstract Lean examples, not signed cross-port fixtures;
A4 remains open. These modules run in the default CI build, and all six general theorems in
`AgentRegistry.lean` are checked against the existing axiom allowlist. The next
section completes A1 with the event projection and seven additional audited lemmas.


## Derived event projection and integrated agent replay — A1

`AgentEventProjection.lean` closes the A1 model-integration boundary. It derives
`PriorityProjection` rather than taking its representative/soundness/canonicality
fields as premises. Eligible retained anchors keep their ranks; each retained
operation also has a provisional CID representative. A selected anchor precedes
that fallback. Receipt ownership must point to retained operations; this is an
input identity contract, not agreement of accepted operations or histories.

The projection proves that removing nonpreferred representations preserves the
selected suffix. `component_interleaved_replay` instantiates it with the derived
`componentAnchors` predicate, then proves that interleaved normalized-event replay
agrees with compiled priority selection and executes to a complete component
state. Document methods are checked against the full-document decoding contract.
Genesis is admitted separately, predecessor ancestry is ordered and bounded,
and a supplied warm suffix is valid under the derived predicate; cold replay
uses the empty suffix. Rejected operations can remain in the retained inputs.

The examples instantiate the projection and integrated theorem on simultaneous
key/registry changes, return migration, deletion, and rejected competing updates.
All seven new general lemmas enter the axiom audit. This completes **A1**, not
A2–A4: ranks still need their protocol-domain/ordinal interpretation; complete
semantic metadata and stopping remain to be composed; signed cross-port fixtures
must validate normalization. The normalized list is an ordering representation,
not a claim that every synthetic provisional event exists as a stored receipt.

## Controller selection (B1)

`ControllerSelection.lean` derives historical controller components and named-method authorization from A3’s converged confirmed receipt view. It models strict same-chain ordinals, inclusive cross-chain time, whole-prefix anchoring, selected-registry fallback, genesis admission and missing/deleted controllers. `controller_selection_same_sources` composes selection with shared source evidence, without assuming equal authorizing documents. See the [B1–B3 audit](../../docs/plans/asset-controller-convergence.md). B1 is merged in #1238. B2 is merged in #1239; the B3 bridge is described below. C1–C3 are implemented in #1241 with receipt normalization and the final audit.

## Asset reconciliation (B2)

`integrated_asset_convergence` reconstructs controller histories from A3 source evidence, proves those reconstructions terminate, and consumes the ordinal/CID ordering contract in the asset result theorem. Equal authorizing histories/verdicts are not endpoint premises.

`AssetAuthorization`, `AssetComponents`, `AssetReplay`, `AssetExecution` and `AssetPriority` derive receipt-specific owner authorization, complete asset components and registry priority, then prove full-record reconciliation termination and unique results from converged agent histories. `asset_source_execution` proves successful nonempty execution from an actually authorized retained creation. `asset_selected_authorized` traces every selected record to a valid retained source; `asset_reconsidered` covers recovery of earlier rejected/deferred evidence. All named results are axiom-audited. The [B1–B3 audit](../../docs/plans/asset-controller-convergence.md) records source, shape, signature and component-decoding contracts. The signed B3 bridge is described below; protocol-wide C1–C3 are implemented in #1241 with receipt normalization and the final audit.


## Signed asset/controller bridge (B3)

`AssetControllerFixtures.lean` and `AssetFixtures.lean` derive agent/controller and
asset inputs from `tests/convergence/asset-vectors.json`, generated from public
synthetic signing keys in both proof formats. The kernel reconstructs controller
histories, checks every retained asset source verdict and complete replay result,
and instantiates `integrated_asset_convergence` without an accepted-history oracle.
TypeScript and Rust run the same 70 evidence scenarios and 10 staged recovery cases
in three delivery orders, including repeated import and real JSON database reopen.
Generator rejection/reordering tests protect the translation. CI regenerates signed
sources and checks both generated modules. B1–B3 are complete at this boundary;
C1–C3 are implemented in #1241 with receipt normalization and the final audit. See the [audit](../../docs/plans/asset-controller-convergence.md)
for source-decoding, signature and finite-correspondence assumptions.
