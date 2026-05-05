# did:cid Technical Presentation

## Checklist

- [x] Frame the identity problem for a technical audience.
- [x] Explain the core `did:cid` design: content-addressed creation, registry-backed updates.
- [x] Cover agent DIDs, asset DIDs, create/update/delete operations, and resolution.
- [x] Call out proof verification, key rotation, temporal resolution, and registry trade-offs.
- [x] Include a demo-ready flow using Archon components.
- [ ] Add final screenshots, architecture diagrams, or live demo captures for the target event.
- [ ] Decide target duration and trim slide count accordingly.
- [ ] Review terminology against the latest protocol spec before presenting.

## Audience

This deck is for engineers, architects, and technical product leaders who already understand public-key cryptography, content addressing, distributed systems, or decentralized identity at a high level. The goal is to make the `did:cid` method concrete enough that they can reason about its security model and implementation trade-offs.

## Core Message

`did:cid` separates identity creation from identity mutation.

Creation is instant and free because the DID is derived from the CID of a canonicalized create operation stored in IPFS. Updates are ordered and confirmed by a registry selected at creation time, such as `hyperswarm` for fast peer gossip or Bitcoin registries for stronger finality. Resolution reconstructs the current or historical DID document by combining the immutable IPFS seed with valid registry events.

## Suggested Slide Outline

### 1. Title

**did:cid: Content-addressed decentralized identifiers**

Speaker note:
Introduce `did:cid` as the DID method implemented by Archon. The technical thesis is simple: identifiers can be self-certifying at creation while still supporting mutable, verifiable identity history.

### 2. The DID Problem

- DIDs need global uniqueness without a central authority.
- Identity creation should be cheap enough for people, services, credentials, schemas, and other assets.
- Updates need ordering, finality, replay resistance, and auditability.
- Key rotation and revocation must not break historical verification.

Speaker note:
Most DID methods pay the same cost for every lifecycle stage. `did:cid` treats creation and updates as different distributed-systems problems.

### 3. The Main Design Split

| Lifecycle stage | Requirement | did:cid mechanism |
| --- | --- | --- |
| Create | Fast, free, decentralized | Canonical JSON operation pinned to IPFS; CID becomes DID suffix |
| Update | Ordered, auditable, replay-resistant | Signed operation anchored to selected registry |
| Resolve | Deterministic reconstruction | Seed + ordered valid updates |
| Verify | Historical key correctness | Resolve signer at `proof.created` |

Speaker note:
The important move is avoiding a blockchain write for the initial identity. The initial DID is a content address, so the identifier itself commits to the creation operation.

### 4. DID Format

```text
did:cid:<cid>[;service][/path][?query][#fragment]
```

Example:

```text
did:cid:bagaaieratxbzo7e4dqup37h7j6hs7kzpamevy4qud4psj23p3r3grzd2rjca
```

Key properties:

- Method prefix: `did:cid`
- Suffix: CIDv1 in standard base32 encoding
- Optional DID URL components follow DID Core syntax

Speaker note:
The suffix is not an arbitrary identifier. It is a content identifier for the canonicalized create operation.

### 5. Two DID Subject Types

| Type | Has keys? | Controlled by | Typical uses |
| --- | --- | --- | --- |
| Agent | Yes | Its own private key holder | users, services, issuers, verifiers, nodes |
| Asset | No | A controller agent DID | credentials, schemas, files, groups, challenges, responses |

Speaker note:
This is an important modeling choice. Not everything needs to sign. Assets are addressable, resolvable, and controllable without pretending every object is an autonomous principal.

### 6. Agent DID Creation

Create operation ingredients:

- `type: "create"`
- `registration.version: 1`
- `registration.type: "agent"`
- `registration.registry`, such as `hyperswarm` or `BTC:signet`
- `publicJwk` with secp256k1 public key material
- `created` timestamp
- `proof` signed by the corresponding private key

Node behavior:

- Verify the create proof.
- Canonicalize the JSON operation.
- Store or pin it through IPFS.
- Return `did:cid:<cid>`.

Speaker note:
For an agent create operation, the proof uses `#key-1` as a relative verification method because the DID does not exist until after the CID is computed.

### 7. Asset DID Creation

Asset create operation ingredients:

- `type: "create"`
- `registration.type: "asset"`
- `controller: "did:cid:..."`
- non-empty JSON `data`
- proof from the controller key

Node behavior:

- Resolve or otherwise identify the controller key.
- Verify the controller proof.
- Canonicalize and pin the seed.
- Return the asset DID.

Speaker note:
Asset DIDs make credentials, schemas, group definitions, vault metadata, and similar objects first-class identity-layer objects.

### 8. Updates

Update operation ingredients:

- `type: "update"`
- `did`
- `doc`, containing any changed document fields
- `previd`, the previous operation CID or version identifier
- optional `blockid` for blockchain anchoring context
- proof from the controller at that time

Validation checks:

- The proof is valid for the DID controller.
- `previd` matches the latest known version.
- The new document is valid.
- The operation is recorded or queued for the DID's registry.

Speaker note:
`previd` gives each update a parent. The registry gives ordering and confirmation. Together, they make replay and fork handling explicit.

### 9. Delete / Revocation

Delete is a terminal update:

- `type: "delete"`
- `did`
- `previd`
- controller proof

Resolution after revocation:

- Returns DID metadata with `deactivated: true`.
- Clears active document data.
- Does not allow future recovery through another update.

Speaker note:
Revocation is intentionally final. If you need recoverability, solve key recovery before deletion, not after deletion.

### 10. Resolution Algorithm

Pseudocode:

```text
resolve(did, versionTime = now):
  cid = suffix(did)
  seed = ipfs.get(cid)
  registry = seed.registration.registry
  events = registry_events_for(did, registry)
  doc = document_from_seed(seed)

  for event in chronological(events):
    if event.time > versionTime:
      break
    if valid_proof(event, doc) and valid_previd(event, doc):
      doc = apply(event, doc)

  return doc
```

Speaker note:
Resolution is deterministic reconstruction, not a database lookup of the latest blob. A resolver can answer "what is true now?" and "what was true then?"

### 11. Temporal Proof Verification

When verifying a signed object:

```text
verifyProof(object):
  signerDid = proof.verificationMethod.did
  signerDoc = resolve(signerDid, versionTime = proof.created)
  publicKey = signerDoc.verificationMethod[keyId]
  verify signature with publicKey
```

Why it matters:

- Key rotation does not invalidate old credentials.
- A signature made before compromise can still verify against the historical key state.
- A signature claiming an impossible key state can be rejected.

Speaker note:
This is the security detail worth slowing down for. The verifier must resolve the signer at the proof time, not only at the current time.

### 12. Registries

| Registry | Strength | Latency | Cost | Best fit |
| --- | --- | --- | --- | --- |
| `local` | Local-only | Immediate | Free | development, isolated testing |
| `hyperswarm` | Peer-distributed eventual consistency | Seconds | Free | fast P2P environments |
| `BTC:signet` / `BTC:testnet4` | Blockchain-style ordering for test networks | Block cadence | Test funds | staging and protocol tests |
| `BTC:mainnet` | Bitcoin-anchored ordering and timestamping | Block cadence | Batch fee | high-value updates |

Speaker note:
`did:cid` does not make every identity pay for maximum finality. The registry is selected based on the risk and cost profile.

### 13. Archon Node Architecture

Core services:

- Gatekeeper: validates operations, stores DID events, resolves DIDs, proxies IPFS.
- Keymaster: manages wallet keys and signs operations.
- Mediators: move operations between Gatekeeper and registries.
- IPFS: stores content-addressed seed objects and other payloads.
- Client apps and CLIs: expose wallet, identity, credential, and admin workflows.

Speaker note:
Gatekeeper is the protocol enforcement point. Keymaster is the private-key boundary. Mediators are how registry-specific networking stays modular.

### 14. Demo Flow

Minimal technical demo:

```bash
./archon create-id --registry hyperswarm alice
./archon resolve-id
./archon create-schema --registry hyperswarm ./schema.json
./archon rotate-keys
./archon backup-wallet-did
```

Alternative API-level demo:

```text
POST /api/v1/did/generate  -> deterministic DID preview
POST /api/v1/did           -> create/update/delete operation
GET  /api/v1/did/:did      -> resolution
GET  /api/v1/registries    -> supported registries
```

Speaker note:
Pick one path. CLI demos are easier for flow; API demos are better if the audience wants implementation details.

### 15. Security Model

Security relies on:

- Canonical JSON producing stable bytes for CID and signature verification.
- secp256k1 ECDSA proofs over canonical operation data.
- Controller-key validation per operation type.
- `previd` continuity across updates and deletes.
- Registry ordering for update history.
- Historical resolution for proofs created before key rotation.

Speaker note:
This is where to be precise: IPFS gives content integrity and retrieval; registries give update ordering and finality; signatures give controller authorization.

### 16. Trade-offs

Strengths:

- Free and fast DID creation.
- Flexible finality choices.
- Stable identifiers with mutable documents.
- Historical verification and key rotation.
- Assets and agents share one DID method.

Trade-offs:

- Operation availability depends on connected Archon nodes receiving and storing gossip/sync traffic; IPFS peering and pinning still matter for content-addressed payload retrieval.
- Registry choice changes security and latency.
- Resolvers must implement canonicalization, event ordering, and historical validation correctly.
- Bitcoin anchoring is naturally batch-oriented for cost control.

Speaker note:
This is not magic decentralization dust. The value is that each responsibility is assigned to a mechanism with suitable properties.

### 17. Comparison

| Method family | Creation cost | Updates | Availability model |
| --- | --- | --- | --- |
| `did:key` | Free | None / immutable | Embedded key material |
| `did:web` | Cheap | Web server / DNS / TLS | Domain control |
| blockchain DID methods | Transaction cost | On-chain or layer-specific | Chain availability |
| `did:cid` | Free via IPFS CID | Pluggable registry | IPFS seed + registry history |

Speaker note:
The useful contrast is not "which method wins everywhere." It is where each method puts trust, cost, and mutability.

### 18. Closing

Takeaways:

- `did:cid` makes the initial DID self-certifying through content addressing.
- Updates are deliberately moved to registries that can provide ordering and confirmation.
- Resolution reconstructs state from verifiable history.
- Temporal verification makes key rotation practical.
- Archon is the reference implementation and packages this into Gatekeeper, Keymaster, mediators, IPFS, CLIs, and apps.

Speaker note:
End with the architectural sentence: `did:cid` is a DID method where creation is a content-addressed fact and updates are a registry-ordered history.

## Appendix: Terminology

- **CID**: Content Identifier. A hash-derived address for content, used here as the DID suffix.
- **DID**: Decentralized Identifier following W3C DID Core syntax.
- **DID document**: The resolved document containing keys, controllers, services, metadata, and method-specific data.
- **Create operation**: The canonicalized seed object whose CID creates the DID.
- **Update operation**: A signed mutation referencing the previous version through `previd`.
- **Delete operation**: A signed terminal operation that deactivates the DID.
- **Registry**: A network or ledger that orders DID update/delete operations.
- **Gatekeeper**: Archon service responsible for operation validation, event storage, and DID resolution.
- **Keymaster**: Archon wallet/key service responsible for signing DID operations.

## Source Material

- [`docs/scheme.md`](../scheme.md): `did:cid` method specification.
- [`docs/WHITEPAPER.md`](../WHITEPAPER.md): protocol rationale and architecture.
- [`docs/services/gatekeeper/README.md`](../services/gatekeeper/README.md): service contract, deterministic DID generation, proof rules, and resolution algorithm.
- [`README.md`](../../README.md): project overview and component framing.
