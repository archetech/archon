# Provisional agent-history convergence (#1199)

This Lean project proves a bounded specification of Archon's canonical-CID
successor rule. It changes no runtime code. It uses Lean's standard library only;
there is no Mathlib dependency.

The main result is:

> For one fixed agent model with finite, acyclic authorized predecessor edges,
> the same retained operation evidence determines the same unique complete
> canonical history, regardless of delivery order or duplicate deliveries.
> The abstract replay function terminates with that complete history.

The result quantifies over arbitrary finite models and evidence lists. It is not
limited to the four-operation test graphs.

## Assumptions and exact meaning

- Both nodes know the same valid genesis/root and use the same model. The theorem
  describes final evidence after genesis is available, including deliveries in
  which genesis arrived last; it does not model intermediate unknown-DID replies.
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
  order or multiplicities. Missing evidence, garbage collection, network delivery
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

**It does not prove the production replay loop implements this specification.**
TypeScript and Rust incrementally insert candidates, replace branches, and repeat
passes until unchanged. The abstract `reconcile` function directly computes the
canonical projection and ignores its stale input. Its convergence theorem does
not establish termination, fairness, pass bounds, or correctness of those
optimized insertion loops. That refinement proof is the next gap to close in
this same bounded domain, before claiming either implementation formally verified.

`generate-fixtures.mjs` bridges the existing
[shared signed fixtures](../../tests/convergence/vectors.json) into Lean:

1. Require exactly one genesis, locate its operation index, and require every
   successor document to contain exactly `didDocumentData`.
2. Sort complete canonical CIDs in ASCII order and assign numeric ranks.
3. Translate predecessors and derive a finite depth witness from the graph.
4. Generate a checked acyclicity proof for every fixture model.
5. Generate 420 concrete history equalities for the eligible delivery traces,
   using the expected histories already checked by both Gatekeepers.

The bridge excludes chain/foreign-anchor scenarios and controller-fork fixtures.
It does not recheck signatures: the existing TypeScript/Rust tests do that. The
bridge is test evidence connecting the model to implementations, not a formal
proof of the generator, CID-ranking abstraction, or either runtime.

## Reproduce

Install Elan using the [official Lean instructions](https://lean-lang.org/install/manual/).
The committed `lean-toolchain` pins Lean 4.34.0; Lake downloads that version.

From the repository root:

```sh
node proofs/agent-convergence/generate-fixtures.mjs --check
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

1. Relate ordinary insertion and repeated replay passes to this unique complete
   projection, proving termination and recovery of late predecessors in the
   bounded fixed-authorization domain.
2. Extend agent authorization to key rotation and deletion, preserving the
   predecessor-selected authorizing document.
3. Add expected-chain evidence, repeated anchors, and registry migrations.
4. Extend to assets, ownership transfers, and controller-dependent replay.
5. Model retention, restart, and garbage collection, then strengthen the bridge
   between the specification and both runtime implementations.

The full Archon convergence theorem remains open. This project proves its first
bounded mathematical component and makes the remaining implementation obligation
explicit.
