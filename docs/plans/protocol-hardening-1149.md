# Protocol hardening after #1173

The proof project now follows the [fixed protocol-convergence completion contract](protocol-convergence-completion.md). Its criteria A1–C3 supersede the historical rolling proof roadmaps below; universal implementation verification is separate.

Current status (2026-09-18): #1158 and #1159 are complete. #1156 is paused at
the maintainer's request. #1149 is complete through #1186. #1185 controller-version references were
closed as not planned; #1180 RFC 8785 alignment merged in #1191. #1178 was
closed as not planned and #1193 withdrawn after reviewing GC and ingress
deduplication. #1160 documentation consolidation is complete in #1194. Keep
independent work in separate PRs from main; do not merge without instruction.

## Work and acceptance criteria

- [x] #1158: Shared predecessor and registration validation merged in #1174 and
  #1181. Production audit supported the approved version-1 registration checks.
- [x] #1159: Rust size counting aligned with existing TypeScript in #1184; issue
  closed. Preserve the legacy UTF-16 code-unit rule. TypeScript `maxOpBytes`,
  transport settings, and protocol-version activation were explicitly left alone.
- [ ] #1156: Paused after the key-permission audit. 276 active agents lacked
  `capabilityInvocation`; migration/enforcement remains undecided. Do not resume
  implementation or activate a new protocol version without instruction.
- [x] #1149 (merged in #1186): Use each Hyperswarm operation's
  `proof.created` for historical cutoffs and update/deletion metadata, keeping
  `previd` ordering, operation bytes, and ordinals. Correct event envelopes in
  the mediator and Gatekeeper import/recovery, keeping resolution registry-neutral. Cover controller rotation/deletion,
  asset genesis and successors, arrival order, restart, and both proof formats in
  both ports. Keep chain/local behavior unchanged; add no speculative safeguards.
  See [the decision and production replay results](hyperswarm-time-1149.md).
- [x] #1160: Consolidated established transition rules in #1194, including #1149
  timing documentation, without introducing additional acceptance restrictions.
- [x] #1180 (merged in #1191): RFC 8785 in both ports, including
  UTF-16 code-unit ordering. Production audit found no affected genesis or
  signing bytes, and three numeric-key updates on two assets. Preserve existing
  content-backed aliases and test fresh-node import. See [audit and validation](canonicalization-1180.md).
- [x] #1185: Closed as not planned after #1186 addressed the motivating defect.
  Explicit controller-version references can be reconsidered for a concrete need.

## Validation and constraints

Use shared signed regression cases across TypeScript and Rust, test direct
submission/import/restart and verified resolution, and keep authorization at the
operation/event boundary rather than in cryptographic proof verification. Run
focused checks before broader suites; build packages before root typechecking.
Preserve the sovereign-node policy: unavailable batches are skipped and retried,
authorization is revisable with available evidence, and agents are self-controlled.
Keep populated-node startup/sync costs bounded; no new full-history scans in the
per-operation path. User confirmed #1173 DB check at 37.607 seconds on Redis.

## Initial assessment (2026-09-17)

At the initial assessment, five issues were open: #1149, #1156, #1158, #1159, #1160. #1158's original
accepted-until-restart description needs refreshing: direct updates now trigger
immediate reconciliation, but still append/queue before predecessor validation.
Closed #1150–#1152, #1157, #1164, #1166, #1168 and #1170 are covered by merged work.

## Approved compatibility policy

Preserve historical acceptance and explicitly version stricter key-permission and
byte-limit rules. Select any future policy from immutable creation version, not
mutable registration metadata, local receipt time, or node configuration. Version 2
remains reserved and disabled until its contract is complete.

Registration is the approved exception: on 2026-09-17, the user authorized version-1
checks after a clean production audit and confirmed that other nodes share the same
database. See the [registration decision](registration-hardening-1158.md).

The 2026-09-18 Hyperswarm decision separately changes historical time selection
under version 1: replay uses proof times and may revise accepted asset history.
The [#1149 replay report](hyperswarm-time-1149.md) records the observed additions
and invalidated deletions. This does not authorize stricter key permissions,
new size limits, or a controller-version protocol change.

## First implementation step

Merged #1174 added a shared predecessor check before direct submission writes/queues.
Signed modern-suite regressions reproduced false success for missing, malformed,
unknown, and stale predecessors before that fix and now verify their rejection.
Imports must still retain successors whose predecessors are not yet available and reconsider them later.
This step does not activate version 2 or close the registration-validation portion
of #1158. Registration is completed by #1181 under the audited version-1 policy above.
Key permissions and byte limits remain separate, with #1160 documenting the contract.

## Progress after #1179

- #1174 merged the shared predecessor check before direct submission writes. The
  historical reproduction in the initial assessment above predates that fix.
- #1179 merged the narrow Rust repair for TypeScript numeric-key predecessor
  references. It did not change generated IDs. Broader CID consistency is tracked
  separately in #1180 and is not a prerequisite for registration enforcement.
- PR #1181 now enforces the [registration contract](registration-hardening-1158.md)
  in version 1 in both ports. A production audit found no malformed registrations;
  the user confirmed the other nodes share the database and approved enforcement
  without introducing version 2. This supersedes the earlier versioned-only
  decision for registration, not for key permissions or byte limits.
- Shared signed fixtures cover submission, import, resolution, restart, and repair
  of malformed old projections. Production-copy replay checks accepted histories
  before/after enforcement. Version 2 remains disabled.
- Subsequently, #1156 was paused and #1159 closed through the narrow Rust parity
  repair in #1184. No new protocol version was enabled.
- On 2026-09-18 the maintainer selected proof-time resolution for Hyperswarm
  (#1149), retaining predecessor order. #1185 records that explicit controller
  references are a separate option. Legacy unsigned proof times remain accepted;
  this is a shared historical-selection rule, not a new trusted chronology claim.

## Documentation consolidation — #1160

The scheme now centralizes established version-1 behavior in a transition table:
whole-component replacement, immutable genesis fields, prior-owner transfers,
old-registry confirmation of migrations, and terminal deletion on an accepted
branch. The resolution narrative follows predecessor-linked available history,
including Hyperswarm proof-time cutoffs and later revalidation. Asset key
publication does not grant independent signing authority. The service contract
links to the table and corrects stale key-selection and byte-count descriptions.

Source review covered TypeScript `authorizeOperation`, `resolveDIDAt`,
`updateDIDOnce`, `importEventOnce`, and `verifyDbOnce`, plus Rust
`authorization.rs`, `events.rs`, `resolver.rs`, and `history.rs`. Existing signed
fixtures in `transition-predecessor`, `registration-transition`,
`history-recovery`, `hyperswarm-time`, and `operation-size` record those contracts.
This documentation work introduces no acceptance changes. #1156 remains paused;
#1128's worked proof examples remain separate. RFC 8785 compatibility wording now
reflects merged #1191 instead of the intermediate Rust-only repair.

#1178/#1193 were closed without rejected-branch classification: successful GC
clears active pending work but retains batch-ingress deduplication in that process,
while durable candidates for retained DIDs remain replayable. Restart and disabled
or failed GC qualify that lifecycle. No live missing intermediate was recovered
by closing the issue, and no new rejection policy was adopted.

## Canonical unanchored branch ordering — #1197

On 2026-09-19 the maintainer selected canonical-CID priority for competing
unanchored successors. The earlier #1149 decision only changed historical time
selection; this separately replaces receipt-order fork selection. Apply the same
preference in import and replay, preserve chain ordering and signed bytes, and
audit production evidence before rollout. See the [implementation and validation
record](canonical-order-1197.md). #1156 remains paused.

## Bounded formal convergence proof — #1199

The first Lean specification proves unique complete provisional histories for
one fixed-authorization agent with finite acyclic predecessor evidence. It
covers arbitrary delivery permutations and duplicates, with a checked bridge to
420 existing signed traces. This proves the abstract canonical projection, not
the optimized TypeScript/Rust replay loops. The next obligation is to refine
those loops to this specification before expanding authorization and chain
semantics. See [the theorem, assumptions, and reproduction instructions](../../proofs/agent-convergence/README.md).

## Operational replay refinement — #1201

The bounded Lean insertion model now refines the canonical projection: duplicate
checks, predecessor deferral, append, and smaller-CID suffix replacement converge
under repeated full passes. Warm replay reaches a stable canonical suffix within
`level(root) + 1` passes; cold replay adds a genesis-loading pass and handles
late genesis. The proof covers arbitrary finite retained evidence with fixed
authorization and acyclic predecessor edges, not only the fixtures. The bridge
checks canonical, cold-replay, and duplicate-replay outcomes for 420 signed traces.

This proves refinement between Lean models. Actual Gatekeeper loops compare full
event records, while the model compares canonical operation-ID paths; event
representation, metadata, I/O, and source/compiler refinement remain outside the
proof. Runtime code is unchanged. See [the operational model and proof boundaries](../../proofs/agent-convergence/README.md).

## Settled-path event representation proof — #1203

The next bounded Lean result covers duplicate representations on an already
settled operation path. One complete journal scan settles every event record;
the next scan is unchanged, including opaque metadata. Four shared signed cases
check full event records in both Gatekeepers through imports, duplicates, and
startup recovery, with 12 corresponding Lean equalities. First expected-registry
receipts can differ across delivery orders even when operation paths agree.

This is a separate phase theorem, not yet a proof of the combined full-event
replay loop. The next obligation is to prove its operation-ID projection and
compose branch-changing passes, genesis initialization, and metadata replacement,
then connect structural equality to runtime serialization. Key rotation, deletion,
chain priority, assets, and executable refinement remain open. Runtime code and
protocol acceptance are unchanged. See the [proof boundaries](../../proofs/agent-convergence/README.md#full-event-records-after-path-selection--1203).

## Combined full-event replay proof — #1205

The Lean importer now combines metadata promotion with predecessor lookup,
append, and canonical-CID branch truncation. Its ID projection is proved equal
to the earlier importer. Completeness proves that later scans only change
metadata, composing the path and record results without assuming the boundary.
Full-record equality replay terminates within `level(root) + 2` warm passes or
`level(root) + 3` cold passes, including late genesis. Different receipts may
produce different metadata; equal operation evidence still gives equal ID paths.

The bridge adds 840 full-event ID projections with synthetic metadata and six
full signed-record cold examples, including displaced promoted branches and
reverse predecessors. Both Gatekeepers exercise the shared signed cases through
imports, duplicate delivery, and restart. Runtime code is unchanged.

This closes the model-level composition obligation from #1203. Runtime
serialization/normalization and executable refinement remain open, alongside
key rotation, deletion, chain priority, controller-dependent assets, and retention.
See [the combined theorem and boundaries](../../proofs/agent-convergence/README.md#combined-full-event-replay--1205).

## Serialized replay and runtime pass correspondence — #1207

The Lean proof now covers a single cold loop including the first comparison from
empty state. Flattening optional genesis/suffix state to the runtime-shaped array
is proved lossless. A serialized stopping check preserves the convergence result
when its codec reflects equality; a decoder round trip along reachable replay
states is a sufficient, explicit premise. The proof does not establish that premise for every runtime JSON value.

Ten signed traces per port check actual replay importer routines against the
Lean-checked cold/warm pass states, through the first unchanged scan. They verify
observed serialization round trips and stopping decisions, including metadata
promotion without ID changes and late genesis. CI runs the TypeScript bridge and
Rust convergence tests and triggers on implementation changes. Runtime behavior
is unchanged.

General codec/normalization and executable refinement remain open; finite trace
checks are implementation evidence, not source verification. Key rotation,
deletion, chain priority, controller-dependent assets, and retention remain
separate extensions, with fixed-agent key rotation/deletion the next model step.
See the [serialized stopping contract](../../proofs/agent-convergence/README.md#serialized-stopping-and-runtime-pass-bridge--1207).

## Predecessor-key authorization — #1209

The agent model now derives authorization from immutable predecessor chains,
including single-key rotation and deletion. Lean proves that canonical replay
executes valid transitions and converges to the same ID history and final
key/deletion state for equal retained evidence. Deleted predecessors cannot
have accepted successors; preferred siblings can replace a deleted branch.

456 new signed delivery traces exercise both proof formats in TypeScript and
Rust, with repeated delivery and restart. Lean checks their reconstructed states
and replay outcomes. No runtime behavior changes. Valid genesis, signature/method
verification, finite acyclic predecessor graphs, and agreement on the operation
snapshot remain explicit premises. General agent documents/multiple methods,
concrete codec/executable refinement, chain priority, assets, and retention
remain follow-ups. See the [authorization proof scope](../../proofs/agent-convergence/README.md#predecessor-key-authorization--1209).

## Multiple verification methods — #1211

The authorization model now selects the method named by the proof from the
predecessor's ordered method list, with separate method and public-key identities.
Lean transfers canonical replay, full-record stability, and final method-list /
deletion agreement to this model. 612 additional signed traces per runtime cover
second-key signing, removal, same-name replacement, competing documents, and
invalid/missing methods, including repeats and restart. Version-1 relationship
membership is not enforced, matching both implementations; #1156 stays paused.

The bridge derives document actions/genesis from operation records and checks
reordering and unsupported inputs. All proof/cryptographic/normalization and
retention assumptions stay explicit. Remaining document components, combined
updates, chain priority, assets, retention, and executable refinement are open.
No runtime changes. See [scope and theorem](../../proofs/agent-convergence/README.md#multiple-verification-methods--1211).

## Complete agent document components — #1213

Lean now carries complete DID-document values, data, and registration through
predecessor-authorized replay. Supplied components replace whole components;
omitted components carry forward. Combined updates and deletion are explicit.
The proof establishes successful execution and equal final component triples for
equal retained evidence, with a separate full-document/method-projection contract.

456 new signed traces per runtime compare complete components after ordinary
imports, repeats, and restart. They include data/member removal, services and
relationships, combined rotation/data changes, and unchanged registration
replacement. JSON codecs, executable validation, metadata, and chain/migration
semantics remain outside this step; the bridge rejects registry changes. #1156
remains paused. No runtime changes. Next: expected-chain ordering/repeated anchors
and registry migrations, followed by assets, retention/GC, and stronger executable
refinement. See [the component theorem](../../proofs/agent-convergence/README.md#complete-document-components--1213).

## Expected-chain audit — #1215 / correction #1216

Before extending the proof to chain priority, signed ordinary-import tests exposed
a counterexample in both Gatekeepers. Reversing two controller gossip hints made
replay retain either an early or late anchor of the same key rotation; the chosen
position changed whether a subsequently anchored asset was authorized. Identical
retained evidence produced different accepted asset histories even after restart.

#1216 repairs duplicate confirmation selection: an earlier expected-chain ordinal
can replace an already-confirmed copy after authorization at that position.
Local/Hyperswarm/pin and tied/missing-position behavior stay unchanged. Shared
fixtures cover both proof formats, six delivery orders, repeats, restart, durable
candidate retention, dependent asset recovery, and rejection of an earlier invalid
asset anchor. Existing candidate replay supplies dependent invalidation/repair.

This is a demonstrated runtime correction, not a completed chain convergence
proof. #1215 remains open for further chain/migration analysis and formalization;
asset and metadata proof obligations also remain open.


### Conditional anchor-selection proof — #1215

After #1217 repaired the signed counterexample, `ChainAnchors.lean` proves the
next isolated obligation: fixed authorization on a settled operation path gives
order- and multiplicity-independent earliest-valid-anchor selection, including
cold scans, different valid warm starts, and repeated scans. The shared fixture
bridge instantiates the theorems for 36 controller-operation/delivery-order cases.

This does not close #1215. Remaining work is to compose anchor selection with
chain successor/path selection and migrations, then dynamic controller/asset
authorization, metadata, and retention. Ordinal ties, absent positions, full
payload equality, and executable refinement are outside this increment.


### Successor replay after settled chain priorities — #1215

Compose the anchor scan with the operational predecessor replay model: anchored
ordinals precede provisional CID ranks, and signed predecessor IDs determine the
compiled graph. The new conditional theorem proves equal decoded operation paths
for equal anchor/operation evidence sets, with cold initialization and
stop-on-unchanged replay. Shared signed fork/descendant fixtures provide 36 traces
per runtime, plus generated Lean cases and source-table reorder checks.

The runtime audit passes; no runtime changes are required by these cases. The
remaining phase obligation is to prove that live interleaved anchor and branch
replay reaches this compiled state. Then connect full document authorization and
registry migrations before dynamic assets, metadata, and retention. #1215 remains
open; this increment is not the general Archon convergence theorem.


### Interleaved next-event settlement and transition bridge — #1215

The new model interleaves duplicate anchor promotion and sibling replacement.
Lean proves that a complete scan settles the next event once its predecessor is
fixed, including different valid retained warm heads and tails. Duplicate
promotion preserves descendants; a preferred sibling truncates the old branch.

The shared signed fixture bridge checks 764 transitions and 100 passes in Lean
and both runtimes, comparing complete event records and serialized stopping.
This strengthens the runtime correspondence beyond final-path tests without
changing runtime behavior. The universal whole-path induction remains open:
prove stable-prefix preservation, suffix progress, and the stop-on-unchanged
bound. Fixed authorization/registry assumptions, migrations, assets, metadata,
and retention are still explicit remaining obligations.


### Whole-path interleaved convergence and stopping bound — #1215

The fixed-authorization interleaved model now proves stable-head preservation,
suffix progress, and whole-path convergence from any valid retained initial path.
Strictly decreasing operation levels bound convergence by `level(parent)` scans,
plus at most one scan detecting stability. Equal retained event sets give equal
complete ranked paths regardless of order, duplicates, or initial valid branch.

Signed fixtures instantiate the level condition and theorem at 100 cold/warm
pass starts. All 764 per-event runtime comparisons remain, with actual stopping
checked against the four-pass fixture bound; two cases reach that bound. No
production loop limit or other runtime behavior changes.

This closes the universal interleaving argument in the current model. The next
connections are full document/key authorization, followed by registry migrations,
dynamic assets, metadata/codecs,
and retention. Universal executable correspondence remains open; #1215 stays open.

### Interleaved/settled-priority equivalence — #1215

The local representation contract now connects the two replay models: preferred
copies preserve eligibility, compiled candidates are sound retained evidence,
and selected ranks identify canonical representatives. Lean derives equal
successors and ranked histories, including genesis and the stopping loop, without
assuming history equality. All six signed graphs satisfy the contract; 36 delivery
orders instantiate the result. The existing per-transition runtime tests cover
these same graphs. No runtime changes are needed.

Next connect full document/key authorization to this model. Registry migrations,
dynamic controller/asset authorization, metadata/codecs, retention, and universal
executable correspondence remain open; #1215 is still the tracking issue.

### Document-authorized interleaved replay — #1215

#1222 merged the interleaved/settled-priority connection. The next increment derives
interleaved event authorization from signed predecessor documents, rather than an
opaque fixed predicate. Lean proves decreasing levels, decoded path validity,
successful execution with successive documents, and equal method/deletion results
for equal retained event sets. Genesis is already admitted; event registry and
position eligibility remain fixed inputs, and cryptographic verification is an
oracle. This is self-controlled agent authorization, not dynamic asset authority.

The two existing signed document graphs instantiate the proof over 612 delivery
orders, with current TypeScript/Rust public-import, repeat, and restart coverage.
Combined repeated-chain-anchor/key-rotation transition fixtures and connection of
this derived predicate to the settled-priority projection are the next step.
Migrations, assets, full components/metadata/codecs, retention, and universal
executable correspondence remain open under #1215.

### Combined chain/document projection and transition bridge — #1215

#1223 merged after Copilot completed without findings and all required checks
passed. The next increment composes its derived predecessor-document predicate
with the settled-priority projection, proving that the canonical ranked suffix
is executable with the correct documents and, with the admitted genesis, equals
the compiled cold replay. Root ownership explicitly connects the decoded compiled
genesis to the document genesis; the theorem also exposes decoded-history equality.
Delivery-order coverage counts distinct permutations. The local projection contract is
checked for four signed mixed gossip/chain graphs, across 24 delivery orders.

Both ports check 920 individual transitions and 68 pass/stopping decisions;
public imports, repeat imports, and restarts check the same cases. Fixtures include
competing keys under one method name, earlier repeated anchors, an anchored
wrong-key candidate, invalid ancestry, deletion, and a post-deletion candidate.
Genesis is seeded for transition traces and may arrive late in public-import
traces. Registry eligibility remains fixed, and no runtime code changes.

Next audit registry-migration eligibility/ordering before extending that part of
the model. Assets, full component/metadata/codecs in the combined loop, retention,
and universal executable correspondence remain open under #1215.

### Registry-migration ordering audit — #1215

#1224 merged the combined chain/document proof. The next audit traces direct
submission (queue the predecessor registry), mediator envelopes, durable candidate
keys, expected-registry selection in both importers, and replay after late history.
The migration itself uses the old registry; its successors use the new one.

Signed fixtures cover competing BTC-to-ZEC/BTC-to-ETH migrations, return to BTC,
wrong-chain receipts, earlier repeated anchors, and late predecessors under two
proof formats and six distinct orders each (24 traces). An independent ancestry
projection supplies expected full event histories and final registration. Both
ports check ordinary imports, repeat imports, and restart, retaining all evidence.
No runtime changes or new Lean theorem are part of this audit.

Next formalize expected registry from signed predecessor ancestry, prove its
agreement with a valid selected prefix, then compose it with authorization and
priority selection. Unanchored-registry migrations, assets, ties, retention,
metadata/codecs, and universal executable correspondence remain open.

Audit result: all 24 signed delivery traces pass in both implementations through
repeat import and restart, including complete stored event equality. No runtime
correction is needed for this tested domain.

### Registry ancestry/prefix agreement — #1215

#1225 merged the signed migration audit. The next Lean increment proves that a
valid predecessor-linked prefix's registry fold agrees with independent signed
ancestry evaluation. The next operation uses that prefix's registry before its
own change; its resulting state governs its children. Receipt registry equality
is connected to the same rule without treating every matching registry as a chain.

The unchanged four signed graphs instantiate 144 predecessor-prefix obligations
and 24 final-prefix states over 24 distinct evidence orders, plus 66 receipt
checks. All branches are covered and source-table reordering leaves proofs
unchanged. General theorem assumptions include finite bounds, increasing ancestry
depth, and an admitted genesis. Existing TypeScript/Rust migration tests cover the
same source vectors; no runtime or fixture payload changes.

Next compose derived registry state with anchor/sibling priority in the replay
model. This increment assumes a valid prefix; it does not establish selection of
that prefix under migration. Assets, unanchored-registry migration policy, deletion,
metadata/codecs, retention, and universal executable correspondence remain open.

### Migration-aware anchor selection — #1215

#1226 merged registry ancestry/prefix agreement. The next increment derives the
anchor filter from that ancestry and proves its agreement with a valid prefix,
order/multiplicity-independent cold selection, and agreement from valid retained
anchors. Competing siblings have the same expected registry; their eligible
anchors therefore belong to the same chain even if their destinations differ.
Ranks preserve ordinal order within each chain, without assigning meaning to
relative positions across chains.

The unchanged migration vectors instantiate 168 cold and 180 retained-anchor
selections across 24 distinct orders, including gossip and wrong-chain receipts
in the Lean input. Selected receipts are checked against the runtime fixtures'
expected histories, and table reordering preserves generated proofs. Signature
and chain-position acceptance remain explicit abstract inputs. No runtime or
signed-source changes.

Next compose this filter with migration-aware sibling ordering and interleaved
replay, checking the rank representation and authorization contracts. This step
proves anchor selection, not complete migration convergence. Unanchored registry
policy, deletion, dynamic assets, metadata/codecs, retention, and universal
executable correspondence remain open.

### Migration sibling priority and compiled replay — #1215

#1227 merged migration-aware anchor selection. This increment proves that anchored
sibling priority agrees with complete chain ordinal comparison, under an explicit
rank representation contract checked by Lean for the shared fixtures. Eligible
siblings are already proven to share a registry, so the proof never compares
positions across chains.

Priority compilation preserves acyclicity; bounded increasing ancestry depth
supplies termination. The compiled replay theorem derives equal decoded histories
from equal receipt and authorized operation sets, independent of order and
multiplicity. The unchanged migration graphs instantiate 24 sibling comparisons
and 24 compiled replay histories, with full ordinal arrays, wrong-chain receipts,
source-table reordering, and a negative test changing actual winning-anchor
metadata while retaining the old expected branch.

Next connect this compiled result to raw interleaved migration replay through the
local priority projection and predecessor-document authorization. Multiple
provisional/wrong-chain representations need an explicit correspondence. This
step assumes already authorized create/update operations and abstract receipt
signature/position validity. Unanchored registry policy, deletion, assets,
metadata/codecs, retention, and universal runtime refinement remain open.
