# Sidetree and Archon: A Deep Dive Comparison

Archon was inspired by Sidetree, but it is not a Sidetree implementation.
Both systems solve the same broad problem - decentralized identifier state
without putting every DID operation directly on a blockchain - and both use
content-addressed data plus ordered anchoring. They differ in where they draw
the method boundary, how much protocol machinery is standardized, how they
model mutable DID state, and what kind of operator experience they optimize
for.

This document compares the Sidetree design, as represented by the DIF Sidetree
specification and the historical `decentralized-identity/sidetree` repository,
with Archon's `did:cid` protocol and node architecture as implemented in this
repository.

## Summary

| Dimension | Sidetree | Archon |
| --- | --- | --- |
| Primary abstraction | A protocol for DID methods that batch off-chain operations and anchor commitments in a ledger | A `did:cid` method and runtime stack for content-addressed DIDs, local resolution, P2P synchronization, and optional anchoring |
| Creation | Create operations are part of the Sidetree operation model and become resolvable through Sidetree CAS plus ledger-ordered batches | Create operations deterministically produce the DID CID and are immediately usable once the create object is available through IPFS/Gatekeeper |
| Pre-anchor use | Long-form DIDs can carry initial state before anchoring | The CID-derived DID can resolve locally as soon as the create operation is stored |
| Updates | Update, recover, and deactivate operations are ordered by Sidetree transaction/batch files | Update and delete operations are appended to a per-DID event log, distributed through a configured registry, and replayed by Gatekeeper |
| Recovery model | Explicit recovery keys and recover operations are central to the protocol | No separate recovery operation in the core DID log; recovery is handled at the wallet/Keymaster layer and DID delete is final |
| Mutation granularity | Delta-based document patches | Signed operation documents that replace the submitted document-set fields during replay |
| Anchoring | A DID method chooses a single anchoring system, such as Bitcoin for ION | A DID records a registry such as `hyperswarm`, `BTC:*`, `ZEC:*`, `ETH:*`, `SOL:*`, or `pin`; mediators implement each network |
| Registry changes | Generally a DID is bound to the method/network's anchoring stream | The registration registry can be changed by a valid update when the new registry is supported |
| Write control | Can include protocol-level mechanisms such as value locking or writer locks | Primarily node, admin, queue, registry, and mediator policy |
| Data storage | CAS stores Sidetree core/provisional/chunk/delta objects; services typically externalize application data | IPFS stores operations, batch assets, and arbitrary DID-linked data; `didDocumentData` is a first-class Archon extension |
| Node role | Sidetree nodes process ledger transactions and CAS objects to construct DID state | Gatekeeper owns local DID state and APIs; mediators synchronize with networks; Keymaster owns wallet/private-key workflows |
| Compatibility goal | Interoperable Sidetree methods that share the Sidetree processing rules | Drop-in service parity across Archon implementations, plus W3C DID resolution compatibility for `did:cid` |

## What Sidetree Contributed

Sidetree's core insight is that a decentralized identifier method does not
need to write every DID document mutation into an expensive global ledger.
Instead, a node can publish operation data into content-addressed storage and
write a compact commitment to a decentralized anchoring system. Other nodes can
read the same anchor stream, fetch the referenced CAS objects, validate the
operation chain, and derive the same DID state.

The Sidetree protocol standardized a layered flow:

1. Clients submit DID operations to Sidetree nodes.
2. Nodes batch many operations together.
3. Batch metadata and operation payloads are written to content-addressed
   storage.
4. A compact anchor is written to a ledger or other consensus system.
5. Resolvers replay ordered operations according to Sidetree rules.

That model strongly influenced Archon. In Archon, operations are still
content-addressed, operation history is replayed to resolve the current DID
document, and expensive ledgers are used for batched anchoring rather than for
full DID documents. The important shift is that Archon narrows and reshapes the
model around `did:cid`: the create operation itself is the DID's content
address, while later operations are routed through an explicit registry
selected at creation time.

## Architecture

### Sidetree

Sidetree is primarily a protocol layer for DID method implementers. A concrete
method, such as ION, chooses a DID method name, a ledger, CAS details, operation
limits, and deployment parameters. A Sidetree node then combines several
responsibilities:

- accept and validate operations;
- batch operations into Sidetree files;
- publish batch files to CAS;
- anchor batch commitments into a ledger;
- read the ledger in canonical order;
- fetch CAS data referenced by anchors;
- resolve DID state from the resulting operation stream.

Sidetree's design is intentionally method-template-like. The same processing
model can back multiple DID methods, as long as each method defines its
parameters and anchoring network.

### Archon

Archon splits the same responsibilities into explicit services:

- **Gatekeeper** is the local DID authority. It validates operations, stores
  per-DID event logs, resolves DID documents, exposes IPFS helpers, manages
  outbound queues, and serves the HTTP API.
- **Keymaster** owns wallets, private keys, signing, identity aliases,
  credentials, assets, vaults, and higher-level user workflows.
- **Mediators** connect Gatekeeper queues to networks. Hyperswarm provides P2P
  gossip. Satoshi, Zcash, Ethereum, and Solana mediators provide chain
  anchoring. Filecoin and pinning mediators consume the `pin` queue for storage
  durability rather than acting as canonical DID anchors.
- **Wallet services** isolate chain-specific signing and transaction handling
  from anchoring mediators.

The practical consequence is that Archon treats "DID protocol" and "network
adapter" as separate concerns. Gatekeeper can resolve the same operation model
while different mediators provide different trade-offs for propagation,
ordering, confirmation, and cost.

## DID Creation

Sidetree DID creation is decentralized, but it is still part of the Sidetree
operation pipeline. A create operation introduces a suffix data commitment and
initial state. The operation is included in Sidetree's batch/CAS/anchor flow,
and resolution depends on the Sidetree method's operation processing rules.
Sidetree also supports a long-form DID pattern where the initial state is
carried with the identifier, allowing pre-anchor use before the abbreviated DID
is anchored in the method's canonical operation stream.

Archon makes creation more directly content-addressed. A `did:cid` DID is
derived from the canonical create operation:

1. canonicalize the create operation;
2. hash it with SHA-256;
3. wrap the digest as a CIDv1 JSON multicodec value;
4. prefix it as `did:cid:<cid>`.

Because the DID is the CID of the create object, creation can be immediate and
zero-fee. The create event is stored locally and can be propagated through IPFS
and peer networks without waiting for a blockchain. The registry named in the
create operation controls where later updates are expected to appear.
Archon does not need a separate long-form identifier for pre-anchor use because
the method identifier already is the content address of the create operation.

This is one of the sharpest differences between the systems. Sidetree uses CAS
to scale a ledger-rooted operation log. Archon uses CAS as the root of identity
itself, then uses registries for mutable history.

## Operation Model

Sidetree defines four major operation families:

- **create**: establish the DID and initial document commitments;
- **update**: mutate document patches under an update authority;
- **recover**: rotate the recovery authority and replace state after key loss
  or compromise;
- **deactivate**: permanently terminate the DID.

The separate recovery operation is a defining Sidetree feature. It gives a DID
two authority tracks: one for routine updates and one for recovery. This adds
protocol complexity but also gives method-level protection against lost or
compromised update keys.

Archon uses a smaller core operation set:

- **create**: create an agent or asset DID;
- **update**: merge a new DID document, `didDocumentData`, or registration
  payload into the current state;
- **delete**: deactivate the DID and clear document/data contents.

Sidetree updates are delta-based: operations carry patches that add, remove, or
replace pieces of the DID document while advancing the commitment chain. Archon
updates are coarser. During Gatekeeper replay, any top-level document-set field
present in `operation.doc` replaces the corresponding field on the running
document. Clients therefore usually resolve the current document, modify the
parts they intend to change, and submit the resulting update with the current
`previd`.

Archon recovery is intentionally handled above the DID event log. Keymaster
supports HD wallets, encrypted backups, identity recovery, seed-bank workflows,
and wallet DID backups. In other words, Sidetree makes recovery a consensus
operation; Archon makes recovery primarily a wallet and operational-control
workflow. That makes the core event replay simpler, but it also means a deleted
Archon DID is final at the DID layer.

## State, Documents, and Data

Sidetree's DID document state is built from operation deltas. The protocol is
optimized around the DID document as a key and service-endpoint document. Larger
application data normally belongs outside the DID document and is referenced by
service endpoints, linked resources, credentials, or application storage.

Archon expands the DID document set with `didDocumentData`, an application data
container carried beside the W3C DID document and DID metadata. This extension
is used for Archon-native assets, groups, encrypted messages, credential
manifests, schemas, polls, node metadata, batch assets, and other higher-level
objects.

That choice changes the feel of the system:

- Sidetree is more conservative about the DID document boundary.
- Archon treats DIDs as signed, versioned, content-addressed containers for
  both identity control material and application data.

The trade-off is explicit. Archon gains a uniform object model - assets,
credentials, batches, and node announcements can all be DIDs - but implementers
must be careful about operation size, privacy, and data lifecycle. Archon
therefore keeps operation size limits, supports encrypted payload patterns, and
uses pinning or registry choices to separate persistence cost from identity
control.

## Anchoring and Registries

Sidetree's anchoring model is method-specific. ION, the best-known Sidetree
method, anchors into Bitcoin. A different Sidetree method can choose another
ledger, but the method definition typically binds resolution to one canonical
ledger stream.

Archon exposes the anchoring choice as `didDocumentRegistration.registry`.
Examples include:

- `local` for non-networked local state;
- `hyperswarm` for fast P2P gossip;
- `BTC:mainnet`, `BTC:signet`, and `BTC:testnet4` through the Satoshi
  mediator;
- `ZEC:mainnet` and `ZEC:testnet` through the Zcash mediator;
- `ETH:*` and `SOL:*` through chain-specific mediators;
- `pin` for auxiliary storage pinning and, when enabled, DID registration.

This registry is not only creation-time metadata. A valid Archon update can
include a new `didDocumentRegistration.registry`, and Gatekeeper's replay logic
uses that registration history to decide which registry is expected for later
events. That gives Archon a migration path between supported registries. A
Sidetree DID method is usually defined around one canonical anchoring stream, so
moving an existing DID to a different ledger is not a native operation in the
same way.

For Bitcoin-family anchoring, Archon does not put the whole operation batch in
the transaction. The Satoshi mediator writes each operation JSON to IPFS,
creates a batch asset DID whose `didDocumentData.batch.ops` array lists the
operation CIDs, and broadcasts an `OP_RETURN` containing the batch DID. Importing
nodes scan blocks, resolve the batch DID, hydrate the operation CIDs, and feed
them back into Gatekeeper with block and transaction metadata.

This is recognizably Sidetree-shaped, but more Archon-native:

- the on-chain anchor references an Archon DID, not a Sidetree batch file;
- the batch object is itself a DID asset;
- chain scanners are mediators, not part of Gatekeeper itself;
- Gatekeeper can also accept non-chain registries with different finality
  properties.

## Resolution Semantics

Sidetree resolution is defined by the Sidetree operation rules for a method:
read the ordered anchor stream, fetch CAS objects, validate operation hashes and
commitments, apply operations in canonical order, and return the resulting DID
document and metadata.

Archon resolution is Gatekeeper event replay:

1. load the per-DID event log;
2. start with the create event's initial document;
3. replay updates/deletes in event order;
4. optionally stop at a `versionTime` or `versionSequence`;
5. optionally require confirmation;
6. optionally re-verify every signature and `previd` link;
7. include timestamp bounds when registry block metadata is available.

The `confirm` flag is important. Archon can keep both local/unconfirmed and
registry-confirmed events in the same local database. A caller can ask for the
latest local view or for the view constrained to confirmed registry history.
That lets Archon serve fast UX and stronger audit workflows from the same API.

## Trust and Security Model

Both systems rely on three security pillars:

- cryptographic authorization of operations;
- content addressing for off-chain payload integrity;
- an ordered external signal for conflict resolution and timestamping.

Sidetree emphasizes protocol-level commitments. Operation data is arranged into
defined file types and hashes. Update and recovery commitments prevent a CAS
observer from learning future keys before use, and the recovery path is part of
the method's consensus semantics.

Archon emphasizes direct operation signatures and local replay. Operations use
canonical JSON, SHA-256, secp256k1 ECDSA proofs, and `previd` links. Create
operations are self-certifying through their CID-derived DID. Updates and
deletes are verified against the current controller. Registry metadata adds
ordering and timestamp evidence without replacing signature verification.
This makes Archon's operation chain easier to inspect, but it also means it
does not inherit Sidetree's commitment-reveal protection for future update or
recovery keys. Archon's main conflict guard is the `previd` hash chain plus
registry ordering: an update is only valid when it points at the current
version.

The resulting posture differs:

- Sidetree is stronger as a reusable, ledger-anchored DID method protocol with
  built-in recovery semantics.
- Archon is stronger as an application platform where identity, data,
  messaging, credentials, wallet control, and multiple propagation networks live
  in one coherent runtime.

## Cost and Latency

Sidetree reduces cost by batching many DID operations into one ledger
transaction. Its user experience still depends on the selected method's
anchoring cadence and ledger confirmation policy. A method can expose
unpublished or pending operations, but the globally canonical result comes from
the anchored stream.

Archon separates the cost and latency profile by operation type:

- create: local/IPFS-derived, immediate, zero-fee;
- `hyperswarm` update: fast P2P gossip with best-effort peer synchronization;
- blockchain update: queued, batched, and confirmed according to the mediator's
  chain rules;
- auxiliary pinning: opt-in, registry-controlled persistence work.

This means an Archon DID can be created and used before any blockchain fee is
paid. Later updates can pay for stronger ordering only when the DID's chosen
registry requires it.

## Interoperability

Sidetree interoperability is primarily among Sidetree-based methods and nodes.
A Sidetree implementer can share the same operation processing model while
changing method parameters and anchoring networks.

Archon interoperability is centered on:

- the W3C DID Core document and resolution model;
- the `did:cid` method specification;
- stable Gatekeeper and Keymaster HTTP APIs;
- parity between TypeScript, Rust, and Python service implementations;
- mediator contracts for each network.

Archon DIDs are not automatically resolvable by a Sidetree node, and Sidetree
DIDs are not automatically replayable by Gatekeeper. The systems are
architectural relatives, not wire-compatible peers.

## Operational Model

Sidetree nodes tend to be full protocol processors: they monitor the ledger,
publish and fetch CAS data, maintain queues, and answer resolution requests.
Deployment complexity is concentrated in the Sidetree node and its selected CAS
and ledger integrations.

Archon is more explicitly service-oriented. A local node can be small or large:

- Gatekeeper plus Keymaster for local DID and wallet workflows;
- Hyperswarm mediator for P2P synchronization;
- Bitcoin/Zcash/Ethereum/Solana mediators for anchored registries;
- chain wallet services for transaction construction and signing;
- Herald, Drawbridge, Lightning, Filecoin, pinning, and UI clients as needed.

This composition gives operators more knobs. It also makes compatibility tests
and service contracts more important, because different language/runtime
implementations must remain substitutable.

## Design Trade-offs

### Sidetree advantages

- Mature protocol model for batching DID operations over a ledger.
- Explicit recovery operation with separate recovery authority.
- Commitment-reveal key rotation avoids publishing future update and recovery
  keys before they are used.
- Delta-based operation patches can be compact for DID document changes.
- Clear separation between DID protocol machinery and application data.
- Strong fit for a DID method that wants one canonical anchoring network.
- Existing lineage through ION and the broader decentralized identity
  ecosystem.

### Sidetree costs

- More protocol machinery: suffix data, commitments, deltas, CAS file types,
  batch files, and recovery rules.
- DID creation and global resolution are tied more closely to batch processing
  and anchoring.
- Application-level data usually needs additional conventions outside the core
  DID document.
- Multi-registry behavior is a method design problem rather than a native
  per-DID registry abstraction.
- Protocol-level write controls, file limits, compression, and commitment
  tracking add operator and implementation surface area.

### Archon advantages

- Immediate, content-addressed DID creation through `did:cid`.
- Small core operation set and direct event replay in Gatekeeper.
- First-class `didDocumentData` for assets, credentials, messages, groups,
  polls, batches, and node metadata.
- Pluggable registries with different cost/finality profiles.
- Registry changes can be expressed as signed DID updates when both registries
  are supported.
- Service separation: Gatekeeper, Keymaster, mediators, and wallet services can
  evolve or be replaced independently.
- Local UX can be fast while confirmed resolution remains available for
  stronger audit requirements.

### Archon costs

- Not Sidetree wire-compatible.
- Recovery is not a separate consensus operation; wallet backup and recovery
  hygiene matter more.
- No Sidetree-style commitment-reveal chain for future update/recovery keys.
- Coarser update documents can be less compact than small delta patches.
- Rich `didDocumentData` makes privacy, size limits, pinning, and retention
  policy more central to application design.
- Multi-registry flexibility increases operator configuration and mediator
  surface area.
- Cross-implementation parity has to be maintained across TypeScript, Rust,
  Python, and chain-specific services.

## When Each Model Fits

Sidetree is a strong fit when the goal is a DID method with a single canonical
anchor network, standardized recovery semantics, and conservative DID document
scope. It is especially attractive when interoperability with existing
Sidetree-derived work, such as ION-style anchoring, is more important than
application object modeling.

Archon is a strong fit when the goal is a complete decentralized identity
runtime: instant local identity creation, rich DID-backed assets, wallet-owned
workflows, peer synchronization, optional blockchain finality, and multiple
runtime flavors behind stable HTTP contracts.

The simplest framing is:

- Sidetree is a general batching and anchoring protocol for DID methods.
- Archon is a content-addressed DID method plus an application/runtime stack
  that borrows Sidetree's batching instinct but chooses a different boundary
  between identity creation, mutable history, storage, and network mediation.

## References

- [DIF Sidetree Protocol specification](https://identity.foundation/sidetree/spec/)
- [Historical `decentralized-identity/sidetree` repository](https://github.com/decentralized-identity/sidetree)
- [Sidetree reference implementation repository](https://github.com/decentralized-identity/sidetree-reference-impl)
- [ION repository](https://github.com/decentralized-identity/ion)
- [Archon whitepaper](WHITEPAPER.md)
- [Archon `did:cid` method specification](scheme.md)
- [Gatekeeper service specification](services/gatekeeper/README.md)
- [Satoshi mediator service specification](services/mediators/satoshi/README.md)
- [Hyperswarm mediator service specification](services/mediators/hyperswarm/README.md)
