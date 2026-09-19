# Provisional agent-history convergence (#1199, #1201, #1203)

This Lean project proves a bounded specification and an operational replay
model of Archon's canonical-CID successor rule. It changes no runtime code. It uses Lean's standard library only;
there is no Mathlib dependency.

The main result is:

> For one fixed agent model with finite, acyclic authorized predecessor edges,
> the same retained operation evidence determines the same unique complete
> canonical history, regardless of delivery order or duplicate deliveries.
> The modeled insertion/repeated-pass replay loop terminates with that complete
> history, including when genesis or another predecessor arrives late.

The result quantifies over arbitrary finite models and evidence lists. It is not
limited to the four-operation test graphs.

## Assumptions and exact meaning

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

The output is the accepted operation-ID path, including genesis. The theorem
makes no claim that receipt timestamps, queues, counters, or all resolution
metadata become identical.

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
Concrete examples use kernel-checked `decide`.

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

**This proves refinement between two Lean models, not verification of the actual
TypeScript or Rust executables.** Their duplicate paths can replace event
representations, and their loop compares serialized event records, while this
model compares operation-ID paths. Registry/receipt metadata is handled separately
by the settled-path result below; queues, caches, I/O failures, and concurrent
publication are not modeled. The proven pass bound
therefore applies to the Lean operation-path model, not every runtime event-row
transition. Source inspection and shared signed fixtures connect these models
to Gatekeeper behavior, but are not a formal compiler/source refinement proof.

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
conditions for the combined runtime replay loop. In particular, the earlier
operation-path theorem cannot simply be reused as a theorem about full events
without proving the projection and phase-composition obligations.

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

## Reproduce

Install Elan using the [official Lean instructions](https://lean-lang.org/install/manual/).
The committed `lean-toolchain` pins Lean 4.34.0; Lake downloads that version.

From the repository root:

```sh
node proofs/agent-convergence/generate-fixtures.mjs --check
node proofs/agent-convergence/generate-record-fixtures.mjs --check
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
git diff --exit-code -- tests/convergence/vectors.json
node --test proofs/agent-convergence/generate-fixtures.test.mjs
node proofs/agent-convergence/generate-fixtures.mjs --check
node proofs/agent-convergence/generate-record-fixtures.mjs --check
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

1. Compose the operation-path replay and settled-path record results into one
   event importer, including branch truncation, late genesis, and representation
   replacement in the same passes. Then connect structural record equality to
   each runtime serializer. Separate phase theorems do not prove that composition.
2. Extend agent authorization to key rotation and deletion, preserving the
   predecessor-selected authorizing document.
3. Add expected-chain evidence, repeated anchors, and registry migrations.
4. Extend to assets, ownership transfers, and controller-dependent replay.
5. Model retention, restart, and garbage collection, then strengthen the bridge
   between the specification and both runtime implementations.

The full Archon convergence theorem remains open. The canonical projection and
its bounded operational refinement are proved; expanded authorization/chain
semantics and the connection to the runtime implementations remain explicit
obligations.
