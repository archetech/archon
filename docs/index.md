# Archon Documentation

Archon is a decentralized identity protocol implementing the W3C-compliant `did:cid` scheme.

## Animated Walkthroughs

Three-minute animated explanations of how Archon works, each viewable in the browser.

- [How Archon Works](presentations/how-archon-works.html) — DID creation, resolution, updates, and registries
- [Keys You Can Lose](presentations/recovery.html) — identity recovery and key rotation: one recovery phrase, wallet backup and restore, rotating keys, stolen old keys, and DID repair
- [Proving What You Hold](presentations/credential-verification.html) — credential issuance, presentation, the five verification checks, request pairing, and verifying as of a past time
- [Sign In With a DID](presentations/signin.html) — passwordless sign-in: challenge, wallet response, Herald verification, and OpenID Connect
- [A Name for Your DID](presentations/names.html) — Archon addresses: claiming name@domain, resolving and publishing it, Herald's public pages, and using addresses for Lightning and email
- [Shared, Sealed, Counted](presentations/assets.html) — groups, vaults and polls: nested membership, per-member vault keys, sealed ballots, and who can see what
- [Messages Between DIDs](presentations/didcomm.html) — DIDComm in Archon: keys, envelopes, delivery through the relay and Tor, mediators, and protocols
- [Paying a DID](presentations/payments.html) — Lightning in Archon: a wallet per DID, zaps to a DID or name@domain, onion endpoints, and pay-per-request L402 API access
- [One History, Everywhere](presentations/convergence.html) — how nodes converge on DID history: replay, forks, chain anchors, late evidence, and reorganizations

## Protocol

- [White Paper](WHITEPAPER.md) — full protocol specification (v1.1)
- [DID Scheme](scheme.md) — the `did:cid` method specification
- [Sidetree and Archon Comparison](sidetree-archon-comparison.md) — deep dive on Archon's Sidetree lineage and design differences
- [DIDComm Messaging Support](didcomm-design.md) — design doc for adding standards-based DIDComm v2 messaging
- [did:cid Technical Presentation](presentations/did-cid-technical-presentation.md) — slide outline, speaker notes, and prep checklist
- [Gatekeeper Resolution Infographic](presentations/gatekeeper-resolution-infographic.md) — visual brief for operation import and DID document replay

## Operations

- [Deployment Guide](deployment.md) — Docker Compose setup from core node to full Lightning stack
- [Recovery Procedures](recovery.md) — getting a node back after losing state
- [Runtime Docker Architecture](runtime-container-architecture.md) — Mermaid diagrams of the live container topology
- [Nginx Reverse Proxy](nginx-proxy.conf.example) — example config for production

## Lightning

- [Lightning Zap Sequence](lightning-zap-sequence.md) — DID-to-DID and LUD-16 payment flows
- [Lightning Wallet Design](lightning-wallet-design.md) — wallet architecture and LNbits integration

## Service Specifications

See [services/](services/README.md) for the full index of
language-agnostic contracts that every Archon service must satisfy.

- **Core**: [Gatekeeper](services/gatekeeper/README.md), [Keymaster](services/keymaster/README.md), [Drawbridge](services/drawbridge/README.md), [Herald](services/herald/README.md)
- **Anchoring mediators** (paired with a wallet service): [Satoshi](services/mediators/satoshi/README.md), [Ethereum](services/mediators/ethereum/README.md), [Solana](services/mediators/solana/README.md), [Zcash](services/mediators/zcash/README.md)
- **P2P**: [Hyperswarm](services/mediators/hyperswarm/README.md)
- **Storage** (`pin` queue): [Filecoin](services/mediators/filecoin/README.md), [Pinning](services/mediators/pinning/README.md)
- **Payments**: [Lightning](services/mediators/lightning/README.md)

## API Reference

- [Gatekeeper API](gatekeeper-api.html) — browsable reference
  ([raw OpenAPI](gatekeeper-api.json))
- [Keymaster API](keymaster-api.html) — browsable reference
  ([raw OpenAPI](keymaster-api.json))
