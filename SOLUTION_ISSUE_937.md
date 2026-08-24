# Solution for Issue #937

## 🛠️ Proposed Design Writeup (by Aditya Waghamare)

### Analysis
This design proposes a provably neutral, zero-custody, zero-payment-rail agent marketplace built on top of Archon primitives (`did:cid`, Herald names, DIDComm, Verifiable Credentials, multi-chain anchoring). The core constraint is keeping the marketplace out of both custody and payment paths completely, acting strictly as a discovery and reputation indexer.

### Architecture & Components

```
+-------------------------------------------------------------+
|                     Archon Indexer                          |
|  - Crawls DID Documents for WorkOffer service entries       |
|  - Indexes cryptographically signed Verifiable Credentials  |
|  - Publishes raw immutable JSON-LD queryable API            |
+------------------------------^------------------------------+
                               | indexes
+------------------------------+------------------------------+
|                    Agent Network (Archon)                   |
|  - `did:cid` identities & Herald names (`agent@domain`)      |
|  - DIDComm messaging (direct peer-to-peer negotiation)      |
|  - Verifiable Credentials (reputation & work completion VC) |
+-------------------------------------------------------------+
```

---

### 1. `WorkOffer` Schema Specification

Agents register capabilities by publishing a service endpoint directly within their DID Document:

```json
{
  "id": "did:cid:zQm...#work-offer-1",
  "type": "WorkOffer",
  "serviceEndpoint": "didcomm://did:cid:zQm.../mcp",
  "protocol": "mcp",
  "capability": "cid:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqab43oclgt635fbwvqe",
  "tags": ["code-review", "solidity", "audit"],
  "pricingHint": "bounty",
  "termsUri": "https://agent.example/terms.json"
}
```

---

### 2. Reputation & Trust Graph (Zero-Central-Adjudication)

Instead of a centralized star rating or moderator-curated badges, reputation is derived entirely from **Verifiable Credentials (VCs)** issued by past clients directly to agents upon successful task completion.

#### `TaskCompletionVC` Schema (`https://archon.network/schemas/task-completion/v1.json`)
```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "id": "urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
  "type": ["VerifiableCredential", "TaskCompletionCredential"],
  "issuer": "did:cid:zClient...",
  "issuanceDate": "2026-08-24T18:00:00Z",
  "credentialSubject": {
    "id": "did:cid:zAgent...",
    "taskCategory": "solidity-audit",
    "deliveryHash": "bafy...deliverable",
    "paymentReference": "lightning:lnbc1... (optional out-of-band proof)",
    "satisfaction": 1.0
  },
  "proof": {
    "type": "Ed25519Signature2020",
    "created": "2026-08-24T18:05:00Z",
    "verificationMethod": "did:cid:zClient...#key-1",
    "proofPurpose": "assertionMethod",
    "jws": "eyJhbGciOiJFZERTQSIsImI..."
  }
}
```

---

### 3. Workflow Lifecycle (Zero Payment Rail & Custody)

1. **Discovery:** Requester queries the Archon Indexer by tag / capability CID. Returns matching agent DIDs and `WorkOffer` endpoints.
2. **Negotiation:** Requester and Agent establish a private channel via **DIDComm**, exchanging capability parameters, task specifications, and out-of-band payment terms (Lightning invoice, ecash token, or HTLC hashlock).
3. **Execution & Settlement:** Work is performed and delivered over DIDComm/MCP. Payment is settled peer-to-peer (e.g. Satoshi transfer via Lightning, bypassing the marketplace completely).
4. **Attestation:** Once completed and paid, the Requester issues a signed `TaskCompletionVC` to the Agent.
5. **Indexing:** The Archon Indexer ingests the VC, updates the trust graph, and makes the updated reputation score queryable without ever touching funds or arbitrating disputes.

---

### Testing & Verification
1. Validate DID Document parsing for `WorkOffer` entries against schema validator.
2. Verify W3C VC signature verification using Ed25519 verification methods.
3. Simulate zero-custody negotiation flow over mock DIDComm transport.

---
*Submitted by Aditya Waghamare*
💰 **Payout Address (Base L2 / EVM):** `0xb61dBcdBc3407F71EaCb64D4CBFAcf9FFfe2415C`