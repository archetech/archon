# Provisional agent-history convergence (#1199, #1201, #1203, #1205, #1207, #1209, #1211, #1213)

This Lean project proves a bounded specification and an operational replay
model of Archon's canonical-CID successor rule. It changes no runtime code. It uses Lean's standard library only;
there is no Mathlib dependency.

The main result is:

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

1. Add expected-chain evidence, repeated anchors, and registry migrations to
   the complete-component model. Future relationship enforcement requires its
   own protocol decision; #1156 remains paused.
2. Establish the concrete codec/normalization domain and general executable
   refinement. Serialized stopping transfer and signed per-pass correspondence
   are now proved/tested respectively; neither is a proof of the runtimes.
3. Extend resolved metadata and time/version-bounded queries.
4. Extend to assets, ownership transfers, and controller-dependent replay.
5. Model retention, restart, and garbage collection, then strengthen the bridge
   between the specification and both runtime implementations.

The full Archon convergence theorem remains open. The canonical projection and
its bounded full-event operational refinement are proved; general document/chain
semantics and the connection to the runtime implementations remain explicit
obligations.

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
