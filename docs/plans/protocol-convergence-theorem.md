# Protocol convergence: C1–C3

`Archon.protocol_convergence` in `ProtocolConvergence.lean` is the endpoint of the
[frozen completion contract](protocol-convergence-completion.md). It composes the
agent and asset proofs over an arbitrary finite family of DIDs. This is a theorem
about the protocol model, with signed TypeScript/Rust correspondence tests; it is
not universal verification of either implementation.

## Local receipt-clock correction

The C2 audit reproduced opposite asset verdicts from the same signed local
operations, with both proof formats and both Gatekeepers. A September 2 rotation
was retained with a September 4 receipt time in one delivery order, admitting an
old-key asset dated September 3; the other order rejected it. This was an admitted
input counterexample, not an observed production incident.

On 2026-09-21 the maintainer approved normalizing local receipt clocks to the
existing local producer rule: `operation.created` for creation and `proof.created`
for updates/deletions. Both ports enforce this in direct submission, import and candidate recovery,
then reconstruct histories and dependent asset authorization. Signed regressions
check actual retained agent operations, intrinsic clocks, deletion and recovery
from an old accepted projection. The creation fixture deliberately has different
creation and proof times. Operation bytes, IDs and ordinals remain intact.

The final model derives its unanchored clock with `protocolOperationTime` from
those complete-operation fields and the immutable creation/registry identity.
There is no independent receipt-clock table, root exception or assumed equality
of node-local timestamps in the final protocol input.

The clock table is read only for matching unanchored receipts. A matching
creation's receipt registry equals its genesis registry; all successor clocks
use proof time. `protocol_provisional_receipt_view` proves equivalence with
computing the clock from the actual source registry. A local receipt of a
chain-registered creation instead projects to `.unconfirmed`, without a cutoff
clock. Genesis remains admitted independently (including the runtime's public
`confirmed: true` convention); this projection flag records registry matching,
not that API flag. Both ports exercise a signed chain genesis with different
creation/proof dates through direct submission and recovery, and the generated
Lean boundary case checks its clock-free receipt view.

## Unanchored registration-metadata correction

After the clock correction, an additional signed ordinary-import audit found
that `controllerForEvent`/`controller_for_event` treated `registration` on a
local receipt as chain context. With an anchored controller, a local asset whose
creation preceded its proof time selected different historical keys depending
on whether the first retained receipt carries that field. The same signed asset
was rejected in one order and accepted in the other, persisting across replay.
`local-registration-counterexample.json` isolates the case with real signatures.

On 2026-09-21 the maintainer approved requiring an actual chain registry for
chain-based controller selection. Both Gatekeepers now use proof-time
authorization for local, Hyperswarm and pin receipts even when their envelopes
carry registration metadata. The fields remain retained; they confer no chain
authority. The signed regression rejects the old-key asset in both orders and
repairs a previously accepted projection on startup without changing its evidence.
This enforces the composed model's anchorless authorization boundary rather than
excluding the demonstrated input through a stronger premise.

## Repeated chain-receipt metadata correction

The signed `chain-registration-counterexample.json` audit supplies the same
controller genesis twice at the same BTC registry, time and ordinal, with identical
signed operation bytes. One copy omits event `registration`, which the documented
import format permits; the other includes it. Parent and rotation operations are
otherwise identical. A chain-anchored asset uses the old key at its earlier chain
position, while its proof time falls after the rotation.

TypeScript missing-metadata-first delivery makes the controller fail `isAnchored`
and rejects the asset at proof time; metadata-first uses chain authority and
accepts it. Rust exhibits the reverse order dependence. Both ports preserve their
opposite verdicts after reconstruction. Candidate merging and accepted-history
replay choose representations differently, without a shared deterministic policy. This is a signed admitted-input counterexample,
not an observed production incident. The fixed chain snapshot supplies the same
time and position in both orders; optional metadata completeness is the difference.

On 2026-09-21 the maintainer approved preferring the metadata-bearing copy at
the same operation/registry/chain position before authorization and replay.
Both Gatekeepers now preserve that preferred candidate during ingress and recovery,
reauthorize enriched confirmations, and prevent incomplete copies from erasing it.
Incomplete-only receipts remain admitted. Signed cases check both dependent-asset
recovery and rejection when the richer receipt is unauthorized; rejection cannot
fall back to the weaker receipt's proof-time context.

`ProtocolReceipts.lean` makes this preprocessing part of the proof input.
`ProtocolReceipt` exposes decoded chain headers separately from bookkeeping.
`ProtocolReceiptSources` binds registry/ordinal/time to the fixed chain facts and
binds canonical metadata presence to `metadataAvailable`, an existential over the
actual received copies. `normalizeProtocolReceipts` filters weaker copies before
controller/asset authorization. Same receipt evidence derives the same completeness
and normalized source keys. The public `protocol_convergence` requires that
binding and composes normalization with `protocol_normalized_convergence`; it no
longer assumes identical optional metadata presence on every raw copy.

## Exact claim

Fix complete canonical operation content, normalized predecessor references,
protocol configuration, and an authoritative chain snapshot. For any finite
retained evidence set satisfying the source contracts below, there is exactly one
semantic result. Every enumeration with the same decoded receipt identities/headers, irrespective
of order, repetition or first-observation bookkeeping, reconstructs to that result
and stops. Previously published histories are not inputs to authorization.

The semantic result is indexed by DID and contains:

- ordered canonical operation identities;
- complete document, data and registration values;
- deactivation, distinguished from an unavailable genesis;
- the confirmed receipt prefix, including operation identity, matching status,
  and the registry/ordinal/time/registration facts used for historical authority.

Agents decode full documents through the same document-to-method projection that
supplies verification keys. Method identity is distinct from public-key identity.
Assets return their owner together with the rest of the complete document.
Deletion clears document/data, preserves registration, and has explicit deleted
state. Missing genesis produces no resolved component state. IDs and opaque JSON
values are represented by shared numeric atoms; equality transfers through their
shared decoding, not through equality of JSON serialization or database layouts.

`protocol_eventual_convergence` allows evidence to change before a settlement
point. Every subsequent complete reconciliation of equivalent snapshots has the
same result. Actual eventual execution and successful storage are liveness
premises; the theorem does not promise delivery or chain finality.

## Actual modeled execution

`ProtocolModel` has a finite typed DID table. A slot is an agent, an asset, or an
absent specification. Only agent slots can enter the controller table; unknown
owners and asset DIDs cannot authorize assets. Agent graphs have self-controlled
predecessor-key authority and no external controller dependency.

`normalizeProtocolEvidence` first selects the richer copies; `reconcileProtocol` then executes every agent replay with `collectFinite`, then executes
every asset replay using **the histories that the agent phase returned**. Each
replay starts empty and uses the existing full-record `stopWhenStable` loop,
including late genesis, suffix replacement, confirmation changes and duplicate
receipts. An exhausted stop returns failure for the whole phase; it is never
silently replaced with an empty history. The theorem proves successful completion
for every slot, not merely equality of two failed computations.

`protocol_views_from_phase` identifies the produced controller views with A3's
source reconstruction. `protocol_controllers_agree` derives their equality from
shared evidence. B1 then derives historical controller selection; B2 reevaluates
every retained asset receipt in its own authorization context before ranking it.
There is no premise asserting equal controller documents or equal contextual
signature verdicts.

`protocol_stable` proves each completed phase is a full-record fixed point.
`protocol_agent_execution` and `protocol_asset_guarantees` establish successful
component execution when a valid/authorized genesis is present. The latter also
establishes retained-source provenance, reconsideration of newly authorized
candidates, and actual winner ordinal/CID ordering under the completed agent
phase. `protocol_results_agree` composes complete agent and asset meanings;
`protocol_convergence` derives the unique result constructively from one actual
execution. No choice axiom is needed.

## C2 premise audit

These contracts describe decoded protocol evidence. They are not arbitrary
administrator-supplied envelopes, an accepted-history oracle, or assumptions that
one finite fixture happens to satisfy.

| Premise | Meaning and justification |
| --- | --- |
| Finite well-founded predecessor graphs | The frozen claim is conditional on finite, acyclic canonical predecessor references. Depth/parent/root bounds implement this assumption. Missing receipt evidence is permitted, including late genesis and unavailable predecessors; a graph table is not an accepted history. Abstract graph nodes can describe unreceived predecessors without retaining a receipt for them. No source means no selection. |
| Canonical identities and component decoding | Complete proofs belong to operation identity. Content-backed predecessor aliases resolve before the graph is built. Numeric operation order embeds canonical base32 CID ASCII order. Opaque data/registration atoms decode whole JSON values; omitted patches carry forward rather than merge. These are the agreed identity/codec primitives in the frozen contract. |
| Cryptographic primitives | Per-operation/per-key validity is shared. Predecessor history chooses the key, named-method lookup chooses the method, and historical controller selection chooses the owner version. Neither accepted operations nor final authorizations are supplied. Legacy and DataIntegrityProof formats share this boundary; complete proof bytes remain part of canonical identity even where legacy signatures do not cover proof configuration. |
| Genesis and immutable kind | Valid agent creation is self-signed, starts active and has no predecessor. Asset creation has no update proposal/deletion. Context-free malformed shapes do not acquire graph authority. The typed table fixes the genesis kind, and only agents appear in owner lookup. This is enforced in both Gatekeepers' operation authorization. |
| Document projection | `ProtocolAgentDomain.methods` connects the complete document returned in the result to the exact method list used by authorization. Asset owner and document payload come from the same `AssetDocument`. Registration-name lookup uses the same full registration values returned by the component fold. |
| Authoritative chain facts | Registry, complete nonempty ordinal and block time belong to the fixed chain view. Optional registration presence is derived from received copies before authorization. The receipt-class registry/position projections are checked. Same registry/ordinal/CID is one ordering class with the same authoritative clock/position, not a uniqueness assumption about ordinals; raw copies may differ in metadata completeness. Conflicting chain views are different input snapshots. |
| Ordinal admission | Both ordinary import and replay require nonempty chain positions after #1236. `ProtocolSources` checks that an anchor is in range, belongs to the source operation and registry, and denotes a chain registry. Unpositioned local/Hyperswarm/pin remain permitted. A chain relay is downgraded to a gossip hint before this domain. Wrong-chain positioned receipts remain permitted provisional evidence. |
| Receipt ordering | `RegistryCidRanks` and `AssetCidRanks` interpret registry-local ordinal then canonical CID. Tied positions for distinct operations are admitted. Repeated identical operation/position classes share ranks; different anchors remain distinct. Only predecessor-registry anchors receive chain priority. Unanchored and wrong-chain evidence uses canonical CID priority. |
| Unanchored clock | Hyperswarm and pin clocks are normalized to `proof.created` at import and retained-candidate recovery. Local producer clocks are operation-intrinsic: creation `created`, update/deletion `proof.created` (Gatekeeper specification §8.1–8.2). This does not assume equal local arrival times. Both ports now enforce the local clock rule at ordinary import and recovery too; unanchored registration metadata cannot select chain authority. Agent/asset receipt clocks are derived from creation and proof fields, including genesis. |
| Registry configuration | Nodes agree on registry-name projection and classification; these are not a closed supported-chain allowlist. The `localRegistry` atom is the shared name decoder's image of the literal `local` registry (the signed bridge uses `names.indexOf('local')`). Local/Hyperswarm/pin have no chain priority. The separate local-owner/nonlocal-asset creation restriction remains active. |
| Same retained evidence | Same decoded operation/registry/anchor-class/header sets per DID, including the available completeness observations. Arrival order, duplicate count and arbitrary bookkeeping may differ. The source-admission contract is preserved by this equivalence. Candidate retention is separate from accepted projection: rejected/deferred evidence is reconsidered. Equal operation bytes with different known anchors do not meet this premise. |
| Complete reconciliation | Independent agents precede assets; assets cannot control agents or other assets. The theorem executes this schedule over any finite family and proves termination. Dynamic imports must eventually invoke complete reconciliation after evidence settles. |

The local-clock condition now follows from the approved import/recovery normalization as well as the documented direct-operation producer: TypeScript `createDID`/`updateDID` and Rust's
matching producer paths set those intrinsic values. Public relays normalize
exported events to Hyperswarm hints; Hyperswarm and pin normalize their clocks at
Gatekeeper. The signed local counterexample is repaired rather than excluded as privileged input. The fixed authoritative-chain
premise likewise does not authenticate an arbitrary submitted timestamp.

The implementation architecture remains the audited A/B architecture: mediators
produce chain positions; Gatekeeper normalizes and journals candidates; event
authorization selects historical controllers; low-level verification receives the
selected document; reconstruction publishes agents before dependent assets.
The three approved runtime corrections normalize local clocks, require an actual
chain registry for chain-based controller selection, and select richer same-position
receipts before authorization.
The paused #1156 relationship-permission rule remains paused.

## C3 checked bridge and CI

`ProtocolFixtures.lean` is generated from the same signed source vectors used by
B3. It builds finite typed families containing both agents, the asset and a missing
owner slot, checks complete graph/document/receipt/source contracts, and applies
`protocol_convergence` to all 70 evidence stages. Each stage includes metadata-free copies of its complete chain receipts in both
copy orders, in Lean and both runtime ports. It checks three delivery orders
per stage and evaluates every DID’s full semantic result in every order against the independently
stopped A/B components, including agent documents/deactivation and both receipt views. This ties execution of the agent phase to
asset execution, not just two unrelated result tables. Agent migrations and the
broader 42 A4 scenarios retain their existing integrated signed bridge.

The existing TypeScript and Rust suites exercise those signed scenarios through
ordinary import, repeat import and actual JSON-storage reopen, including dependent
revocation/recovery. Generator rejection tests remain part of the bridge. CI also regenerates
reordered operation/event tables and compiles all three resulting Lean modules,
so successful string generation alone does not establish the reordering contract. CI regenerates signed vectors, checks generated Lean files, runs both
ports, builds the final theorem and audits its transitive axioms. Only `propext`
and `Quot.sound` are allowed; no `sorry`, `native_decide` or choice axiom is used.

Finite runtime correspondence is not universal implementation refinement. General
JSON/HTTP codec correctness, cryptographic proofs, storage/concurrency correctness,
network liveness, arbitrary external query equality and GC information preservation
remain the explicitly separate projects in the frozen contract. They do not add
new completion steps to C1–C3.
