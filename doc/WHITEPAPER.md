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
6. [The didDocumentData Extension](#6-the-diddocumentdata-extension)
7. [Registry System](#7-registry-system)
8. [Advanced Features](#8-advanced-features)
9. [Verifiable Credentials](#9-verifiable-credentials)
10. [Cryptographic Foundation](#10-cryptographic-foundation)
11. [Network Topology](#11-network-topology)
12. [Use Cases](#12-use-cases)
13. [Comparison with Existing Solutions](#13-comparison-with-existing-solutions)
14. [Future Directions](#14-future-directions)
15. [Conclusion](#15-conclusion)

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

## 6. The didDocumentData Extension

### 6.1 Beyond the W3C Standard

One of Archon's most powerful innovations is the `didDocumentData` field—an extension to the standard DID document structure that enables arbitrary application data to be stored alongside the identity itself. While the W3C DID Core specification defines the structure of `didDocument` and `didDocumentMetadata`, it also explicitly supports extensibility through additional properties.

The W3C DID specification states that DID methods may add custom properties beyond the core specification, provided they support lossless conversion between representations. Archon leverages this extensibility to introduce `didDocumentData`: a flexible, schema-free container for application-specific data that travels with the DID throughout its lifecycle.

```
┌─────────────────────────────────────────────────────────────────┐
│                    ARCHON DOCUMENT SET                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │  didDocument (W3C Standard)                             │  │
│   │  • Verification methods, authentication, services       │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │  didDocumentMetadata (W3C Standard)                     │  │
│   │  • Created, updated, deactivated, versionId             │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │  didDocumentData (Archon Extension)                     │  │
│   │  • Arbitrary JSON data bound to the DID                 │  │
│   │  • Cryptographically signed and versioned               │  │
│   │  • Supports any application use case                    │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │  didDocumentRegistration (Archon Extension)             │  │
│   │  • Registry, type (agent/asset), protocol version       │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Design Philosophy

Traditional DID systems treat identities as static containers for cryptographic keys and service endpoints. Archon recognizes that real-world identities are dynamic, accumulating attributes, relationships, and context over time. The `didDocumentData` field transforms DIDs from mere identifiers into rich, self-sovereign data containers.

**Key Properties:**

1. **Schema-Free**: No predefined structure—applications define their own data schemas
2. **Cryptographically Bound**: All data is signed by the DID controller, ensuring authenticity
3. **Version-Controlled**: Every change creates a new version with full audit trail
4. **Decentrally Stored**: Data is distributed via IPFS and synchronized across registries
5. **Controller-Owned**: Only the DID controller can modify the data

### 6.3 Use Cases Enabled by didDocumentData

The `didDocumentData` extension unlocks an expansive range of applications that would be impossible or impractical with standard DID documents:

#### Credential Manifests

Users can publish verified credentials to their DID, creating a public or selectively-disclosed portfolio:

```json
{
  "didDocumentData": {
    "manifest": {
      "did:cid:bafkrei...degree": {
        "type": ["VerifiableCredential", "UniversityDegree"],
        "issuer": "did:cid:bafkrei...stanford",
        "credentialSubject": {
          "degree": "Bachelor of Science in Computer Science"
        }
      },
      "did:cid:bafkrei...certification": {
        "type": ["VerifiableCredential", "ProfessionalCertification"],
        "issuer": "did:cid:bafkrei...aws",
        "credentialSubject": {
          "certification": "AWS Solutions Architect"
        }
      }
    }
  }
}
```

This enables LinkedIn-style professional profiles that are fully decentralized and cryptographically verifiable.

#### Identity Vaults

Encrypted backup storage tied directly to an identity:

```json
{
  "didDocumentData": {
    "vault": "did:cid:bafkrei...encrypted-backup"
  }
}
```

Users can recover their entire identity—including all credentials and relationships—from just their seed phrase.

#### Digital Assets as DIDs

Images, documents, and structured data become first-class citizens with their own DIDs:

```json
{
  "didDocumentData": {
    "type": "image/png",
    "encoding": "base64",
    "data": "iVBORw0KGgoAAAANSUhEUgAA...",
    "metadata": {
      "title": "Profile Photo",
      "created": "2024-01-15T10:30:00Z"
    }
  }
}
```

#### Encrypted Communications

End-to-end encrypted messages stored with DIDs:

```json
{
  "didDocumentData": {
    "encrypted": {
      "sender": "did:cid:bafkrei...alice",
      "created": "2024-01-15T10:30:00Z",
      "cipher_hash": "a1b2c3...",
      "cipher_sender": "encrypted-for-sender...",
      "cipher_receiver": "encrypted-for-receiver..."
    }
  }
}
```

#### Organizational Structures

Groups and hierarchies with membership data:

```json
{
  "didDocumentData": {
    "group": {
      "name": "Engineering Team",
      "members": [
        "did:cid:bafkrei...alice",
        "did:cid:bafkrei...bob",
        "did:cid:bafkrei...carol"
      ],
      "roles": {
        "did:cid:bafkrei...alice": "admin",
        "did:cid:bafkrei...bob": "member"
      }
    }
  }
}
```

#### Notices and Announcements

Time-sensitive communications to specific recipients:

```json
{
  "didDocumentData": {
    "notice": {
      "to": ["did:cid:bafkrei...recipient"],
      "subject": "Meeting Request",
      "body": "encrypted-content...",
      "expires": "2024-02-01T00:00:00Z"
    }
  }
}
```

#### Polls and Governance

Decentralized voting with cryptographic integrity:

```json
{
  "didDocumentData": {
    "poll": {
      "question": "Approve budget proposal?",
      "options": ["Yes", "No", "Abstain"],
      "deadline": "2024-02-01T00:00:00Z",
      "results_hidden": true
    }
  }
}
```

### 6.4 W3C Compatibility

The W3C DID Core specification explicitly supports extensibility. Section 4.1 states:

> "For maximum interoperability, it is RECOMMENDED that extensions use the W3C DID Specification Registries mechanism... It is always possible for two specific implementations to agree out-of-band to use a mutually understood extension."

Archon's `didDocumentData` follows this guidance:

1. **Additive Extension**: The field is added alongside standard properties, not replacing them
2. **Lossless Conversion**: Standard DID resolution tools receive valid W3C-compliant documents
3. **Namespace Separation**: Application data is isolated from core identity properties
4. **Graceful Degradation**: Systems unaware of `didDocumentData` can still resolve and verify DIDs

### 6.5 Security Considerations

All data in `didDocumentData` inherits the security properties of the DID system:

- **Authentication**: Only the DID controller (holder of the private key) can modify the data
- **Integrity**: Every change is cryptographically signed and content-addressed
- **Non-Repudiation**: The signature proves the controller authorized the data
- **Auditability**: Full version history is preserved through the operation chain
- **Revocation**: If the DID is revoked, `didDocumentData` is cleared, ensuring data lifecycle management

### 6.6 Comparison with Alternatives

| Approach | Storage | Verifiability | Cost | Flexibility |
|----------|---------|---------------|------|-------------|
| **didDocumentData** | Decentralized (IPFS) | Full (DID signatures) | Zero/Low | Unlimited |
| Off-chain with hash | External systems | Hash-only | Variable | Full |
| Service endpoints | External URLs | None | Variable | Full |
| On-chain storage | Blockchain | Full | High | Limited |

The `didDocumentData` approach provides the best combination: decentralized storage with full verifiability, minimal cost, and unlimited flexibility.

---

## 7. Registry System

### 7.1 Registry Abstraction

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

### 7.2 Hyperswarm Registry

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

### 7.3 Blockchain Registries (Satoshi)

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

### 7.4 Inscription Registry

For applications requiring on-chain data storage, Archon supports Taproot inscriptions:

**Mechanism:**
1. Commit transaction creates inscription address
2. Reveal transaction includes full operation data in witness
3. Lower on-chain footprint than OP_RETURN for larger data
4. Compatible with ordinals ecosystem

### 7.5 Blockchain Timestamping

One of Archon's most powerful features is automatic cryptographic timestamping for all DID operations registered on blockchain-based registries. When a DID operation is anchored to Bitcoin, Feathercoin, or any other blockchain registry, it inherits an immutable, independently verifiable timestamp from the block in which it was confirmed.

#### How Timestamping Works

```
┌─────────────────────────────────────────────────────────────────┐
│                    TIMESTAMP BOUNDS                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   LOWER BOUND (optional)          UPPER BOUND (confirmed)       │
│   ───────────────────────         ─────────────────────────     │
│   Block referenced in the         Block containing the          │
│   operation's blockid field       anchored operation            │
│                                                                 │
│   "This operation was created     "This operation was           │
│    after this block existed"       confirmed at this time"      │
│                                                                 │
│   ┌─────────────┐                 ┌─────────────┐               │
│   │ Block #800  │ ──────────────> │ Block #805  │               │
│   │ 2024-01-10  │    Operation    │ 2024-01-10  │               │
│   │ 12:00:00    │    Created      │ 12:50:00    │               │
│   └─────────────┘                 └─────────────┘               │
│         ↑                               ↑                       │
│   Lower Bound                     Upper Bound                   │
│   (reference point)               (confirmation)                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

When resolving a DID, the `didDocumentMetadata` includes timestamp information:

```json
{
  "didDocumentMetadata": {
    "created": "2024-01-15T10:30:00Z",
    "updated": "2024-01-16T14:00:00Z",
    "versionId": "bafkrei...",
    "version": "2",
    "confirmed": true,
    "timestamp": {
      "chain": "BTC",
      "opid": "bafkrei...",
      "lowerBound": {
        "time": 1705312800,
        "timeISO": "2024-01-15T10:00:00Z",
        "blockid": "00000000000000000002a7c4...",
        "height": 826000
      },
      "upperBound": {
        "time": 1705316400,
        "timeISO": "2024-01-15T11:00:00Z",
        "blockid": "00000000000000000001b8f2...",
        "height": 826005,
        "txid": "a1b2c3d4e5f6...",
        "txidx": 42,
        "batchid": "bafkrei...",
        "opidx": 3
      }
    }
  }
}
```

#### Timestamp Components

**Lower Bound** (optional): Created when the operation includes a `blockid` field referencing a recent block at the time of creation. This proves the operation was created *after* that block existed, establishing a "not before" time.

**Upper Bound** (always present for confirmed operations): The block in which the operation batch was anchored. This provides:
- `time`: Unix timestamp of the block
- `timeISO`: Human-readable ISO 8601 format
- `blockid`: The block hash (independently verifiable)
- `height`: Block height in the chain
- `txid`: Transaction ID containing the batch
- `txidx`: Transaction index within the block
- `batchid`: CID of the operation batch
- `opidx`: Index of this operation within the batch

#### Why Blockchain Timestamps Matter

**1. Legal Admissibility**

Blockchain timestamps provide cryptographic proof of existence at a specific time. Unlike self-asserted timestamps, blockchain timestamps are:
- Independently verifiable by any node
- Immutable once confirmed
- Backed by computational proof-of-work
- Anchored to a globally-recognized timechain

This makes them suitable for legal contexts where proving "when" something happened matters:
- Contract signing dates
- Intellectual property registration
- Regulatory compliance timestamps
- Audit trails

**2. Temporal Ordering**

The ordinal key `{block height, transaction index, batch index, operation index}` provides a strict total ordering of all operations, resolving any ambiguity about which operation came first. This is critical for:
- Key rotation (ensuring old keys can't sign "backdated" operations)
- Credential revocation (proving when a credential was revoked)
- Dispute resolution (establishing timeline of events)

**3. Trust Minimization**

Traditional timestamping services require trusting a third party. Blockchain timestamps derive their trustworthiness from:
- Decentralized consensus (no single authority)
- Economic security (cost of attack exceeds benefit)
- Transparent verification (anyone can audit)

**4. Proof of Non-Existence**

The timestamp system also enables proving that something *didn't* exist before a certain time. If an operation's lower bound is block N, it cannot have existed before block N was mined.

#### Timestamp Precision by Registry

| Registry | Typical Precision | Verification |
|----------|-------------------|--------------|
| Bitcoin | ~10 minutes (block time) | Full node or SPV proof |
| Feathercoin | ~2.5 minutes | Full node or SPV proof |
| Hyperswarm | Sub-second (self-asserted) | Peer attestation only |

#### Use Cases for Timestamps

**Intellectual Property**: Prove when a creative work was first registered, establishing priority for copyright or patent claims.

**Credential Validity Windows**: Verify that a credential was issued before its expiration date and hadn't been revoked at the time of use.

**Audit Compliance**: Demonstrate that required attestations or certifications were in place at specific regulatory checkpoints.

**Legal Evidence**: Provide court-admissible proof of when digital agreements, signatures, or declarations were made.

**Version Control**: Establish authoritative ordering of document revisions or identity updates, preventing "time-warp" attacks.

---

## 8. Advanced Features

Beyond the core DID functionality, Archon includes several advanced features that extend the protocol into a comprehensive identity and communication platform.

### 8.1 Time-Travel Resolution

Archon supports resolving DIDs at any point in their history, enabling powerful audit and compliance capabilities.

**Resolution Options:**

```javascript
// Resolve at a specific point in time
resolveDID(did, { versionTime: "2024-01-15T10:00:00Z" })

// Resolve a specific version number
resolveDID(did, { versionSequence: 3 })

// Resolve a specific version by its CID
resolveDID(did, { versionId: "bafkrei..." })
```

**How It Works:**

Every DID operation includes a `previd` field linking to the previous operation, creating an immutable chain:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Version 1  │────>│  Version 2  │────>│  Version 3  │
│  (Create)   │     │  (Update)   │     │  (Update)   │
│             │     │             │     │             │
│ previd: ∅   │     │ previd: v1  │     │ previd: v2  │
│ time: T1    │     │ time: T2    │     │ time: T3    │
└─────────────┘     └─────────────┘     └─────────────┘
```

The resolver walks this chain, applying operations up to the requested time/version, then returns the reconstructed document state.

**Use Cases:**
- **Audit trails**: Prove what credentials existed at a specific regulatory checkpoint
- **Dispute resolution**: Establish the state of an identity at a contested point in time
- **Recovery**: Examine historical states to understand how a DID evolved
- **Compliance**: Demonstrate historical compliance at any point

### 8.2 Decentralized Messaging (D-Mail)

Archon includes a complete decentralized email system built on top of the DID infrastructure:

```
┌─────────────────────────────────────────────────────────────────┐
│                        D-MAIL SYSTEM                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   SENDER                          RECIPIENT                     │
│   ──────                          ─────────                     │
│   1. Compose message              4. Refresh notices            │
│   2. Encrypt for recipient        5. Import dmail               │
│   3. Create notice asset          6. Decrypt message            │
│                                   7. File in folder             │
│                                                                 │
│   Message stored as encrypted asset DID                         │
│   Notice points recipient to the message                        │
│   Both sender and recipient retain encrypted copies             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Features:**
- **Folder organization**: INBOX, SENT, DRAFT, ARCHIVED, DELETED
- **CC support**: Multiple recipients with individual encryption
- **Attachments**: Files stored as asset DIDs
- **Read tracking**: UNREAD tag for new messages
- **Dual encryption**: Both sender and recipient can decrypt

**Message Structure:**
```json
{
  "didDocumentData": {
    "dmail": {
      "from": "did:cid:bafkrei...alice",
      "to": ["did:cid:bafkrei...bob"],
      "cc": ["did:cid:bafkrei...carol"],
      "subject": "Meeting Tomorrow",
      "body": "encrypted-content...",
      "attachments": ["did:cid:bafkrei...file1"],
      "created": "2024-01-15T10:30:00Z"
    }
  }
}
```

### 8.3 Privacy-Preserving Voting

Archon's polling system goes beyond simple vote counting to provide cryptographic privacy guarantees:

**Two-Phase Voting Protocol:**

```
Phase 1: Ballot Collection (Private)
──────────────────────────────────────
• Voters cast encrypted ballots
• Ballots stored as asset DIDs
• Vote choices hidden from everyone
• Eligibility verified via credentials

Phase 2: Result Revelation (Optional)
──────────────────────────────────────
• Poll creator can reveal results
• Individual ballots can remain hidden
• Or full transparency with ballot publication
```

**Privacy Features:**

1. **Spoil Ballots**: Voters can cast intentionally invalid ballots that are indistinguishable from valid ones, providing plausible deniability about whether they voted.

2. **Hidden Results**: Poll creators can choose to keep results hidden until a deadline or indefinitely.

3. **Anonymous Tallying**: Results can be published without revealing individual votes.

**Poll Structure:**
```json
{
  "didDocumentData": {
    "poll": {
      "question": "Approve the Q4 budget?",
      "options": ["Yes", "No", "Abstain"],
      "deadline": "2024-02-01T00:00:00Z",
      "roster": "did:cid:bafkrei...eligible-voters",
      "resultsHidden": true,
      "ballots": {
        "did:cid:bafkrei...ballot1": "encrypted...",
        "did:cid:bafkrei...ballot2": "encrypted..."
      }
    }
  }
}
```

### 8.4 Group Vaults with Secret Membership

Archon supports multi-party encrypted storage where members can share data without necessarily knowing each other's identities:

**Standard Group:**
```json
{
  "didDocumentData": {
    "group": {
      "name": "Project Alpha Team",
      "members": [
        "did:cid:bafkrei...alice",
        "did:cid:bafkrei...bob"
      ],
      "vault": "did:cid:bafkrei...shared-vault"
    }
  }
}
```

**Secret Member Group:**
```json
{
  "didDocumentData": {
    "group": {
      "name": "Anonymous Review Board",
      "secretMembers": true,
      "encryptedMembers": "encrypted-member-list...",
      "vault": "did:cid:bafkrei...shared-vault"
    }
  }
}
```

**How Secret Membership Works:**

1. **Encrypted Member List**: The member list is encrypted so only the group controller knows all members
2. **Individual Access Keys**: Each member receives their own derived key to access the vault
3. **Plausible Membership**: Members cannot prove or disprove others' membership
4. **Anonymous Contributions**: Items added to the vault don't reveal the contributor

**Use Cases:**
- **Whistleblower systems**: Submit documents without revealing identity to other submitters
- **Blind review**: Academic or professional review where reviewers don't know each other
- **Anonymous committees**: Voting bodies where member composition is confidential

### 8.5 Challenge-Response Authentication

Archon provides a flexible challenge-response system for authentication and authorization:

```
┌──────────────┐                    ┌──────────────┐
│   VERIFIER   │                    │    PROVER    │
│              │                    │              │
│ 1. Create    │    Challenge       │              │
│    challenge │ ─────────────────> │ 2. Receive   │
│              │                    │    challenge │
│              │                    │              │
│              │    Response (VP)   │ 3. Create    │
│ 4. Verify    │ <───────────────── │    response  │
│    response  │                    │              │
└──────────────┘                    └──────────────┘
```

**Challenge Types:**

1. **Simple Identity Challenge**: Prove you control a specific DID
2. **Credential Challenge**: Prove you hold a credential of a specific type
3. **Issuer-Specific Challenge**: Prove you hold a credential from a specific issuer

**Challenge Structure:**
```json
{
  "type": "VerifiablePresentation",
  "challenge": "random-nonce-12345",
  "domain": "https://example.com",
  "credentialRequirements": [
    {
      "type": "EmployeeCredential",
      "issuers": ["did:cid:bafkrei...acme-corp"]
    }
  ]
}
```

**Response (Verifiable Presentation):**
```json
{
  "type": "VerifiablePresentation",
  "holder": "did:cid:bafkrei...alice",
  "challenge": "random-nonce-12345",
  "verifiableCredential": [
    { /* Matching credential */ }
  ],
  "proof": { /* Signature over presentation */ }
}
```

### 8.6 Key Rotation

Archon supports secure key rotation without changing the DID:

```
┌─────────────────────────────────────────────────────────────────┐
│                      KEY ROTATION                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Before Rotation          After Rotation                       │
│   ───────────────          ──────────────                       │
│   DID: did:cid:abc...      DID: did:cid:abc... (unchanged)     │
│   Key: #key-1              Key: #key-2                          │
│                                                                 │
│   The DID remains constant, but the controlling key changes.    │
│   Old signatures remain valid for historical verification.      │
│   New operations must use the new key.                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Security Properties:**
- Old keys cannot sign new operations (enforced by `previd` chain)
- Historical signatures remain verifiable
- Compromised keys can be rotated without losing identity
- Key rotation is itself timestamped on blockchain registries

---

## 9. Verifiable Credentials

### 9.1 W3C Verifiable Credentials Support

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

### 9.2 Credential Lifecycle

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  ISSUER  │────>│  HOLDER  │────>│ VERIFIER │     │ REVOKE   │
│          │     │          │     │          │     │          │
│ Create   │     │ Accept   │     │ Verify   │     │ Issuer   │
│ Sign     │     │ Store    │     │ Validate │     │ Revokes  │
│ Issue    │     │ Present  │     │ Trust    │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

### 9.3 Privacy Features

**Encryption**
- Credentials can be encrypted for specific recipients
- Only the intended holder can decrypt and access
- Selective disclosure through encrypted presentations

**Bound Credentials**
- Credentials can be cryptographically bound to subjects
- Prevents credential transfer between identities
- Verifiers can confirm binding integrity

---

## 10. Cryptographic Foundation

### 10.1 Key Management

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

### 10.2 Signature Scheme

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

### 10.3 Content Addressing

DIDs are derived from content addresses:

```
operation = create_operation(public_key, registry, ...)
canonical = json_canonicalize(operation)
cid = IPFS_add(canonical)  # CIDv1, base32
did = "did:cid:" + cid
```

This creates a self-certifying identifier: the DID itself proves the integrity of the creation operation.

---

## 11. Network Topology

### 11.1 Node Types

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

### 11.2 Peer Discovery

**Hyperswarm DHT**
- Nodes announce presence on topic-based DHT
- Peers discover each other without central coordination
- Encrypted connections established via noise protocol

**IPFS Network**
- Content retrieval via IPFS libp2p
- Global availability of DID operations
- No single point of failure for content access

### 11.3 Synchronization

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

## 12. Use Cases

### 12.1 Self-Sovereign Identity

Individuals create and control their own digital identities without relying on any central authority:

- Generate identity locally using Keymaster
- Choose appropriate registry based on needs
- Hold credentials from multiple issuers
- Present credentials selectively to verifiers
- Recover identity using mnemonic seed phrase

### 12.2 Enterprise Identity Management

Organizations deploy Archon for decentralized employee and partner identity:

- Issue employee credentials upon onboarding
- Revoke credentials upon termination
- Enable passwordless authentication
- Audit credential usage and access

### 12.3 Educational Credentials

Universities and certification bodies issue verifiable credentials:

- Degrees and diplomas as verifiable credentials
- Professional certifications with expiration
- Micro-credentials for specific skills
- Instant verification by employers

### 12.4 IoT Device Identity

Connected devices receive unique, verifiable identities:

- Device attestation through manufacturer credentials
- Secure device-to-device authentication
- Supply chain provenance tracking
- Firmware update verification

### 12.5 Voting and Governance

Organizations implement transparent voting systems:

- Anonymous ballot casting
- Verifiable vote counting
- Proof of eligibility without identity disclosure
- Auditable election results

### 12.6 Digital Asset Provenance

Track ownership and authenticity of digital assets:

- Digital art authentication
- Document signing and notarization
- Supply chain tracking
- Intellectual property registration

---

## 13. Comparison with Existing Solutions

### 13.1 Feature Comparison

| Feature | did:cid (Archon) | did:btc | did:web | did:key |
|---------|------------------|---------|---------|---------|
| Creation Cost | Free | ~$1-10 | Free | Free |
| Creation Speed | Instant | Minutes | Instant | Instant |
| Update Support | Yes | Yes | Yes | No |
| Decentralized | Full | Full | Partial | Full |
| Finality Options | Multiple | Strong | None | N/A |
| Credential Support | Full | Limited | Full | Limited |
| Key Recovery | BIP-39 | Varies | N/A | N/A |
| Arbitrary Data Storage | Yes (didDocumentData) | No | External only | No |
| Blockchain Timestamps | Automatic (with bounds) | Implicit | No | No |
| Time-Travel Resolution | Yes | No | No | No |
| Built-in Messaging | Yes (D-Mail) | No | No | No |
| Voting/Governance | Yes | No | No | No |

### 13.2 Architectural Comparison

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

## 14. Future Directions

### 14.1 Protocol Evolution

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

### 14.2 Ecosystem Development

**Schema Registry**
- Standardized credential schemas
- Industry-specific schema packages
- Automated schema validation

**Trust Frameworks**
- Governance frameworks for issuer accreditation
- Trust registries for verifier policies
- Reputation systems for identity providers

### 14.3 Performance Optimization

**Layer 2 Scaling**
- Batching and rollup techniques
- State channels for high-frequency updates
- Optimistic confirmation with dispute resolution

---

## 15. Conclusion

Archon represents a significant advancement in decentralized identity technology. By separating identity creation from updates and supporting multiple registry options, it solves the fundamental tension between decentralization, cost, and speed that has limited previous approaches.

Key innovations include:

1. **Zero-cost, instant identity creation** through IPFS content addressing
2. **Flexible finality options** via multi-registry architecture
3. **The didDocumentData extension** enabling arbitrary application data bound to identities
4. **Automatic blockchain timestamping** providing cryptographic proof of when operations occurred
5. **Time-travel resolution** allowing DIDs to be resolved at any point in their history
6. **Decentralized messaging (D-Mail)** built on the identity layer
7. **Privacy-preserving voting** with spoil ballots and two-phase revelation
8. **Group vaults with secret membership** for anonymous collaboration
9. **Full W3C compliance** ensuring ecosystem interoperability
10. **Comprehensive credential support** for real-world applications

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
