# Archon: A Decentralized Identity Protocol

## White Paper v1.0

**Abstract**

Archon is a decentralized identity (DID) protocol implementing the W3C-compliant `did:cid` scheme. It provides a comprehensive peer-to-peer identity infrastructure that enables secure, verifiable decentralized identities anchored to IPFS and multiple blockchain registries. By separating DID creation (via content-addressable storage) from DID updates (via distributed registries), Archon achieves the unprecedented combination of instant, zero-cost identity creation with cryptographically secure, consensus-driven updates.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Problem Statement](#2-problem-statement)
3. [The Archon Solution](#3-the-archon-solution)
4. [Technical Architecture](#4-technical-architecture)
5. [The did:cid Method](#5-the-didcid-method)
6. [Registry System](#6-registry-system)
7. [Verifiable Credentials](#7-verifiable-credentials)
8. [Cryptographic Foundation](#8-cryptographic-foundation)
9. [Network Topology](#9-network-topology)
10. [Use Cases](#10-use-cases)
11. [Comparison with Existing Solutions](#11-comparison-with-existing-solutions)
12. [Future Directions](#12-future-directions)
13. [Conclusion](#13-conclusion)

---

## 1. Introduction

The digital age has created an identity paradox. While individuals generate more personal data than ever before, control over that data has concentrated in the hands of a few large platforms. Traditional identity systems—whether government-issued, corporate-managed, or platform-specific—share fundamental limitations: centralized control, single points of failure, and the inability to provide true user sovereignty.

Decentralized Identifiers (DIDs), as specified by the World Wide Web Consortium (W3C), offer a path forward. DIDs are globally unique identifiers that enable verifiable, decentralized digital identity without requiring a centralized registry. However, existing DID implementations face practical challenges: blockchain-based methods incur transaction costs and confirmation delays, while purely peer-to-peer approaches lack the finality guarantees required for high-stakes applications.

Archon addresses these challenges through a novel architectural approach that separates identity creation from identity updates, achieving both instant availability and cryptographic finality through its multi-registry design.

---

## 2. Problem Statement

### 2.1 The Centralization Problem

Current digital identity systems concentrate authority in centralized entities. Whether a government agency, a social media platform, or an enterprise identity provider, these systems create:

- **Single points of failure**: Service outages or organization failures can invalidate identities
- **Privacy vulnerabilities**: Centralized databases become attractive targets for attackers
- **Censorship risks**: Central authorities can revoke identities without recourse
- **Vendor lock-in**: Users cannot port their identity between systems

### 2.2 The Blockchain Trilemma for Identity

Existing blockchain-based DID methods face a trilemma between:

1. **Cost**: On-chain operations require transaction fees, making identity creation economically infeasible for many use cases
2. **Speed**: Blockchain confirmation times (minutes to hours) create unacceptable latency for real-time applications
3. **Decentralization**: Solutions that address cost and speed often compromise on decentralization

### 2.3 The Verification Gap

Even when decentralized identities exist, verifying them requires:

- Access to the same network infrastructure
- Trust in the resolution mechanism
- Ability to validate cryptographic proofs

Many existing systems fail to provide portable, universally verifiable identity documents.

---

## 3. The Archon Solution

### 3.1 Core Innovation: Separation of Creation and Updates

Archon's fundamental insight is that DID creation and DID updates have fundamentally different requirements:

**Creation** requires:
- Speed (immediate availability)
- Low/zero cost (enabling mass adoption)
- Decentralization (no gatekeepers)

**Updates** require:
- Ordering guarantees (prevent replay attacks)
- Finality (irreversible once confirmed)
- Auditability (verifiable history)

By separating these concerns, Archon achieves optimal characteristics for each:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ARCHON IDENTITY LIFECYCLE                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   CREATION (IPFS/CAS)              UPDATES (Registry)          │
│   ─────────────────────            ──────────────────────       │
│   • Instant (<10 seconds)          • Ordered by registry        │
│   • Zero cost                      • Cryptographically signed   │
│   • Content-addressed              • Consensus-verified         │
│   • Globally available             • Auditable history          │
│   • No gatekeepers                 • Finality guarantees        │
│                                                                 │
│         DID = did:cid:<IPFS-CID>                               │
│                    ↓                                            │
│         Immediate use, updates via chosen registry              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Multi-Registry Architecture

Rather than mandating a single consensus mechanism, Archon supports multiple registries, each with different characteristics:

| Registry | Confirmation Time | Cost | Finality | Best For |
|----------|-------------------|------|----------|----------|
| Hyperswarm | Seconds | Free | Eventual | Development, internal systems |
| Bitcoin | ~60 minutes (6 blocks) | ~$0.001/batch | Strong | Enterprise, legal identity |
| Feathercoin | ~15 minutes | ~$0.00001/batch | Strong | Cost-sensitive applications |

Users select their registry at DID creation based on their specific requirements, enabling a spectrum of security-cost trade-offs.

### 3.3 W3C Compliance

Archon implements the full W3C DID specification, ensuring interoperability with the broader decentralized identity ecosystem:

- Standard DID document structure
- Verification methods and authentication
- Service endpoints
- DID resolution with metadata

---

## 4. Technical Architecture

### 4.1 System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         ARCHON NODE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                     GATEKEEPER                          │  │
│   │            (DID Database & Validation Core)             │  │
│   │                                                         │  │
│   │  • Maintains local DID database                         │  │
│   │  • Validates all incoming operations                    │  │
│   │  • Manages registry-specific operation queues           │  │
│   │  • Provides REST API for DID operations                 │  │
│   └─────────────────────────────────────────────────────────┘  │
│                              ↑                                  │
│              ┌───────────────┼───────────────┐                 │
│              ↓               ↓               ↓                 │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│   │   KEYMASTER  │  │  MEDIATORS   │  │   CLIENTS    │        │
│   │   (Wallet)   │  │              │  │              │        │
│   │              │  │ • Hyperswarm │  │ • CLI        │        │
│   │ • HD Keys    │  │ • Satoshi    │  │ • Web Wallet │        │
│   │ • Signing    │  │ • Inscript.  │  │ • Mobile     │        │
│   │ • Encryption │  │              │  │ • Extension  │        │
│   └──────────────┘  └──────────────┘  └──────────────┘        │
│                              ↓                                  │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                    NETWORK LAYER                        │  │
│   │                                                         │  │
│   │  ┌─────────┐  ┌─────────────┐  ┌──────────────────┐    │  │
│   │  │  IPFS   │  │  P2P (Hypr) │  │   Blockchains    │    │  │
│   │  │  (CAS)  │  │  (Gossip)   │  │  (BTC/FTC/etc.)  │    │  │
│   │  └─────────┘  └─────────────┘  └──────────────────────┘    │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Core Components

#### Gatekeeper

The Gatekeeper serves as the authoritative local source for DID state. It:

- Receives and validates DID operations
- Maintains operation queues per registry
- Merges operations from multiple sources
- Provides a REST API for DID CRUD operations
- Supports multiple database backends (Redis, MongoDB, SQLite)

#### Keymaster

The Keymaster is the client-side wallet library responsible for:

- BIP-32 hierarchical deterministic key derivation
- BIP-39 mnemonic seed phrase management
- ECDSA signing of DID operations
- Encryption/decryption of messages and credentials
- Wallet backup and recovery

#### Mediators

Mediators synchronize DID operations across network boundaries:

- **Hyperswarm Mediator**: Distributes operations via P2P gossip protocol
- **Satoshi Mediator**: Anchors operation batches to Bitcoin/Feathercoin via OP_RETURN
- **Inscription Mediator**: Uses Taproot witness data for inscription-based registration

### 4.3 Data Flow

```
┌──────────┐     ┌───────────┐     ┌────────────┐     ┌──────────┐
│  Client  │────>│ Keymaster │────>│ Gatekeeper │────>│ Registry │
│          │     │           │     │            │     │          │
│ Request  │     │ Sign Op   │     │ Validate   │     │ Confirm  │
│ Identity │     │ Create Op │     │ Queue Op   │     │ Order Op │
└──────────┘     └───────────┘     └────────────┘     └──────────┘
                                          ↓
                                   ┌────────────┐
                                   │    IPFS    │
                                   │            │
                                   │ Store Op   │
                                   │ Return CID │
                                   └────────────┘
```

---

## 5. The did:cid Method

### 5.1 Method Specification

The `did:cid` method leverages Content Identifiers (CIDs) from IPFS to create self-certifying, content-addressed DIDs:

```
did:cid:<cid>[;service][/path][?query][#fragment]
```

Where:
- `cid`: A CIDv1 encoded in base32 (multibase prefix 'b')
- Optional components follow standard DID URL syntax

Example:
```
did:cid:bafkreig6rjxbv2aopv47dgxhnxepqpb4yrxf2nvzrhmhdqthojfdxuxjbe
```

### 5.2 DID Types

Archon supports two fundamental DID types:

**Agent DIDs**
- Possess cryptographic keys
- Can sign operations
- Controlled by a private key holder
- Used for: users, organizations, services, IoT devices

**Asset DIDs**
- No cryptographic keys
- Controlled by an owning Agent DID
- Used for: credentials, schemas, documents, data

### 5.3 DID Document Structure

```json
{
  "@context": "https://w3id.org/did-resolution/v1",
  "didDocument": {
    "@context": ["https://www.w3.org/ns/did/v1"],
    "id": "did:cid:bafkreig6rjxbv2aopv47dgxhnxepqpb4yrxf2nvzrhmhdqthojfdxuxjbe",
    "verificationMethod": [{
      "id": "#key-1",
      "controller": "did:cid:bafkreig6rjxbv...",
      "type": "EcdsaSecp256k1VerificationKey2019",
      "publicKeyJwk": {
        "kty": "EC",
        "crv": "secp256k1",
        "x": "...",
        "y": "..."
      }
    }],
    "authentication": ["#key-1"],
    "assertionMethod": ["#key-1"]
  },
  "didDocumentMetadata": {
    "created": "2024-01-15T10:30:00Z",
    "updated": "2024-01-15T10:30:00Z",
    "deactivated": false,
    "versionId": 1
  },
  "didDocumentData": {},
  "didDocumentRegistration": {
    "registry": "hyperswarm",
    "type": "agent",
    "version": 1
  }
}
```

### 5.4 Operations

All DID state changes occur through signed operations:

**Create Operation**
```json
{
  "type": "create",
  "created": "2024-01-15T10:30:00Z",
  "registration": {
    "registry": "hyperswarm",
    "type": "agent",
    "version": 1
  },
  "publicJwk": { /* Public key in JWK format */ },
  "signature": {
    "hash": "SHA-256",
    "signed": "2024-01-15T10:30:00Z",
    "signer": "did:cid:bafkrei...",
    "value": "304402..."
  }
}
```

**Update Operation**
```json
{
  "type": "update",
  "did": "did:cid:bafkrei...",
  "created": "2024-01-16T14:00:00Z",
  "doc": { /* Updated document fields */ },
  "previd": "bafkrei...",
  "signature": { /* Signed by controller */ }
}
```

**Delete Operation**
```json
{
  "type": "delete",
  "did": "did:cid:bafkrei...",
  "created": "2024-01-17T09:00:00Z",
  "previd": "bafkrei...",
  "signature": { /* Signed by controller */ }
}
```

---

## 6. Registry System

### 6.1 Registry Abstraction

Archon's registry system provides a unified interface across different consensus mechanisms:

```
┌─────────────────────────────────────────────────────────────────┐
│                      REGISTRY INTERFACE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   queue(operation)    → Add operation to confirmation queue     │
│   confirm(operation)  → Mark operation as confirmed             │
│   getOperations(did)  → Retrieve all operations for a DID       │
│   getOrdinal(op)      → Get ordering key for operation          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
            ↓                    ↓                    ↓
    ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
    │  Hyperswarm  │     │   Bitcoin    │     │  Feathercoin │
    │              │     │              │     │              │
    │  Gossip-     │     │  OP_RETURN   │     │  OP_RETURN   │
    │  based       │     │  Anchoring   │     │  Anchoring   │
    │  ordering    │     │              │     │              │
    └──────────────┘     └──────────────┘     └──────────────┘
```

### 6.2 Hyperswarm Registry

The Hyperswarm registry provides fast, peer-to-peer operation distribution:

**Characteristics:**
- Confirmation time: Seconds
- Cost: Zero
- Finality: Eventual consistency (gossip-based)
- Ordering: Timestamp-based with conflict resolution

**Mechanism:**
1. Operations are broadcast to all connected peers
2. Peers validate and store operations locally
3. Ordering determined by timestamp, with cryptographic tiebreakers
4. Eventually consistent across the network

**Best for:** Development, testing, internal organizational use, applications where speed matters more than finality

### 6.3 Blockchain Registries (Satoshi)

Blockchain registries provide cryptographic finality through proof-of-work:

**Bitcoin (BTC)**
- Confirmation time: ~60 minutes (6 blocks)
- Cost: ~$0.001-0.01 per batch (variable with network fees)
- Finality: Extremely strong (computational security)
- Ordering: Block height + transaction index

**Feathercoin (FTC)**
- Confirmation time: ~15 minutes (6 blocks at 2.5 min/block)
- Cost: ~$0.00001 per batch
- Finality: Strong
- Ordering: Block height + transaction index

**Mechanism:**
1. Operations accumulate in a queue
2. Mediator batches operations and computes batch CID
3. Batch CID embedded in OP_RETURN output (60 bytes)
4. Transaction broadcast and confirmed
5. All nodes can independently verify and import

### 6.4 Inscription Registry

For applications requiring on-chain data storage, Archon supports Taproot inscriptions:

**Mechanism:**
1. Commit transaction creates inscription address
2. Reveal transaction includes full operation data in witness
3. Lower on-chain footprint than OP_RETURN for larger data
4. Compatible with ordinals ecosystem

---

## 7. Verifiable Credentials

### 7.1 W3C Verifiable Credentials Support

Archon implements the full W3C Verifiable Credentials Data Model:

```json
{
  "@context": [
    "https://www.w3.org/2018/credentials/v1"
  ],
  "type": ["VerifiableCredential", "UniversityDegreeCredential"],
  "issuer": "did:cid:bafkrei...",
  "issuanceDate": "2024-01-15T00:00:00Z",
  "credentialSubject": {
    "id": "did:cid:bafkrei...",
    "degree": {
      "type": "BachelorDegree",
      "name": "Bachelor of Science"
    }
  },
  "proof": {
    "type": "EcdsaSecp256k1Signature2019",
    "created": "2024-01-15T00:00:00Z",
    "verificationMethod": "did:cid:bafkrei...#key-1",
    "proofPurpose": "assertionMethod",
    "proofValue": "..."
  }
}
```

### 7.2 Credential Lifecycle

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  ISSUER  │────>│  HOLDER  │────>│ VERIFIER │     │ REVOKE   │
│          │     │          │     │          │     │          │
│ Create   │     │ Accept   │     │ Verify   │     │ Issuer   │
│ Sign     │     │ Store    │     │ Validate │     │ Revokes  │
│ Issue    │     │ Present  │     │ Trust    │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

### 7.3 Privacy Features

**Encryption**
- Credentials can be encrypted for specific recipients
- Only the intended holder can decrypt and access
- Selective disclosure through encrypted presentations

**Bound Credentials**
- Credentials can be cryptographically bound to subjects
- Prevents credential transfer between identities
- Verifiers can confirm binding integrity

---

## 8. Cryptographic Foundation

### 8.1 Key Management

**Hierarchical Deterministic Wallets (BIP-32)**
```
Master Seed (BIP-39 Mnemonic)
        │
        ├── m/44'/0'/0'  (Bitcoin keys)
        ├── m/84'/0'/0'  (Native SegWit)
        ├── m/86'/0'/0'  (Taproot)
        └── m/390'/0'/0' (DID signing keys)
                  │
                  ├── Identity 1
                  ├── Identity 2
                  └── Identity N
```

**Key Types:**
- **ECDSA secp256k1**: Primary signing algorithm
- **JWK format**: Standardized key representation
- **AES-256-GCM**: Symmetric encryption for at-rest protection

### 8.2 Signature Scheme

All operations are signed using ECDSA over secp256k1:

```
signature = ECDSA_sign(
  private_key,
  SHA256(canonical_json(operation))
)
```

Verification:
```
valid = ECDSA_verify(
  public_key,
  SHA256(canonical_json(operation)),
  signature
)
```

### 8.3 Content Addressing

DIDs are derived from content addresses:

```
operation = create_operation(public_key, registry, ...)
canonical = json_canonicalize(operation)
cid = IPFS_add(canonical)  # CIDv1, base32
did = "did:cid:" + cid
```

This creates a self-certifying identifier: the DID itself proves the integrity of the creation operation.

---

## 9. Network Topology

### 9.1 Node Types

**Full Nodes**
- Run complete Gatekeeper with local database
- Participate in all supported registries
- Validate and store all operations
- Provide resolution services

**Light Clients**
- Connect to trusted full nodes
- Perform wallet operations locally
- Delegate resolution to full nodes
- Suitable for browsers and mobile

**Registry Nodes**
- Specialized mediator nodes
- Focus on specific registry synchronization
- May run blockchain full nodes

### 9.2 Peer Discovery

**Hyperswarm DHT**
- Nodes announce presence on topic-based DHT
- Peers discover each other without central coordination
- Encrypted connections established via noise protocol

**IPFS Network**
- Content retrieval via IPFS libp2p
- Global availability of DID operations
- No single point of failure for content access

### 9.3 Synchronization

```
┌─────────────────────────────────────────────────────────────────┐
│                    SYNCHRONIZATION FLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Node A                              Node B                     │
│    │                                   │                        │
│    │──── Hyperswarm announce ─────────>│                        │
│    │<─── Peer connection ──────────────│                        │
│    │                                   │                        │
│    │──── New operation (gossip) ──────>│                        │
│    │                                   │                        │
│    │                          ┌────────┴────────┐              │
│    │                          │ Validate & Store │              │
│    │                          └────────┬────────┘              │
│    │                                   │                        │
│    │<─── Acknowledgment ───────────────│                        │
│    │                                   │                        │
│                                                                 │
│  Blockchain (background)                                        │
│    │                                                            │
│    │──── Poll for new blocks ─────────────────────────────────>│
│    │                                                            │
│    │<─── Import confirmed operations ──────────────────────────│
│    │                                                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Use Cases

### 10.1 Self-Sovereign Identity

Individuals create and control their own digital identities without relying on any central authority:

- Generate identity locally using Keymaster
- Choose appropriate registry based on needs
- Hold credentials from multiple issuers
- Present credentials selectively to verifiers
- Recover identity using mnemonic seed phrase

### 10.2 Enterprise Identity Management

Organizations deploy Archon for decentralized employee and partner identity:

- Issue employee credentials upon onboarding
- Revoke credentials upon termination
- Enable passwordless authentication
- Audit credential usage and access

### 10.3 Educational Credentials

Universities and certification bodies issue verifiable credentials:

- Degrees and diplomas as verifiable credentials
- Professional certifications with expiration
- Micro-credentials for specific skills
- Instant verification by employers

### 10.4 IoT Device Identity

Connected devices receive unique, verifiable identities:

- Device attestation through manufacturer credentials
- Secure device-to-device authentication
- Supply chain provenance tracking
- Firmware update verification

### 10.5 Voting and Governance

Organizations implement transparent voting systems:

- Anonymous ballot casting
- Verifiable vote counting
- Proof of eligibility without identity disclosure
- Auditable election results

### 10.6 Digital Asset Provenance

Track ownership and authenticity of digital assets:

- Digital art authentication
- Document signing and notarization
- Supply chain tracking
- Intellectual property registration

---

## 11. Comparison with Existing Solutions

### 11.1 Feature Comparison

| Feature | did:cid (Archon) | did:btc | did:web | did:key |
|---------|------------------|---------|---------|---------|
| Creation Cost | Free | ~$1-10 | Free | Free |
| Creation Speed | Instant | Minutes | Instant | Instant |
| Update Support | Yes | Yes | Yes | No |
| Decentralized | Full | Full | Partial | Full |
| Finality Options | Multiple | Strong | None | N/A |
| Credential Support | Full | Limited | Full | Limited |
| Key Recovery | BIP-39 | Varies | N/A | N/A |

### 11.2 Architectural Comparison

**did:btc / did:ion**
- Requires blockchain transaction for every operation
- High cost and latency for creation
- Strong finality but poor user experience

**did:web**
- Relies on DNS and HTTPS
- Centralized at the domain level
- No inherent finality or ordering

**did:key**
- Simple, deterministic from public key
- No update capability
- Limited to ephemeral use cases

**did:cid (Archon)**
- Free, instant creation via IPFS
- Optional blockchain finality for updates
- Best of both worlds approach

---

## 12. Future Directions

### 12.1 Protocol Evolution

**Multi-Signature Support**
- Threshold signatures for organizational control
- Social recovery mechanisms
- Escrow and time-locked operations

**Zero-Knowledge Proofs**
- Selective disclosure without revealing full credentials
- Anonymous credential verification
- Privacy-preserving age/attribute verification

**Cross-Chain Bridges**
- Registry migration between blockchains
- Interoperability with other DID methods
- Federated identity across networks

### 12.2 Ecosystem Development

**Schema Registry**
- Standardized credential schemas
- Industry-specific schema packages
- Automated schema validation

**Trust Frameworks**
- Governance frameworks for issuer accreditation
- Trust registries for verifier policies
- Reputation systems for identity providers

### 12.3 Performance Optimization

**Layer 2 Scaling**
- Batching and rollup techniques
- State channels for high-frequency updates
- Optimistic confirmation with dispute resolution

---

## 13. Conclusion

Archon represents a significant advancement in decentralized identity technology. By separating identity creation from updates and supporting multiple registry options, it solves the fundamental tension between decentralization, cost, and speed that has limited previous approaches.

Key innovations include:

1. **Zero-cost, instant identity creation** through IPFS content addressing
2. **Flexible finality options** via multi-registry architecture
3. **Full W3C compliance** ensuring ecosystem interoperability
4. **Comprehensive credential support** for real-world applications
5. **Enterprise-ready features** including groups, vaults, and organizational management

The protocol is production-ready, with multiple client implementations (CLI, web, mobile, browser extension), robust cryptographic foundations, and extensive testing. Organizations seeking to implement decentralized identity infrastructure will find Archon provides the flexibility, security, and performance required for diverse use cases.

As the digital identity landscape continues to evolve, Archon's modular architecture positions it to adapt to new requirements while maintaining backward compatibility and the core principles of user sovereignty and decentralization.

---

## References

1. W3C Decentralized Identifiers (DIDs) v1.0. https://www.w3.org/TR/did-core/
2. W3C Verifiable Credentials Data Model v1.1. https://www.w3.org/TR/vc-data-model/
3. IPFS Content Identifiers (CIDs). https://docs.ipfs.tech/concepts/content-addressing/
4. BIP-32: Hierarchical Deterministic Wallets. https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
5. BIP-39: Mnemonic code for generating deterministic keys. https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
6. Hyperswarm Protocol. https://docs.holepunch.to/building-blocks/hyperswarm
7. JSON Canonicalization Scheme (JCS). RFC 8785

---

## Appendix A: Quick Start

### Creating Your First Identity

```bash
# Initialize wallet with new seed phrase
./archon create-wallet

# Create a new identity
./archon create-id alice

# Resolve the identity
./archon resolve-id alice

# Export for backup
./archon export-wallet
```

### Issuing a Credential

```bash
# Create a schema
./archon create-schema EmployeeCredential

# Issue credential to subject
./archon issue-credential alice employee-schema bob

# Subject accepts credential
./archon accept-credential <credential-did>
```

---

## Appendix B: API Reference

### Gatekeeper REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/did/:id` | GET | Resolve DID |
| `/api/v1/did` | POST | Create DID operation |
| `/api/v1/did/:id` | PUT | Update DID |
| `/api/v1/did/:id` | DELETE | Deactivate DID |
| `/api/v1/registries` | GET | List available registries |

### Keymaster REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/wallet` | POST | Create wallet |
| `/api/v1/ids` | GET | List identities |
| `/api/v1/ids` | POST | Create identity |
| `/api/v1/credentials` | GET | List credentials |
| `/api/v1/credentials` | POST | Issue credential |

---

*Copyright 2024 Archetech. Released under MIT License.*
