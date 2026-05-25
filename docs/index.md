# Archon Documentation

Archon is a decentralized identity protocol implementing the W3C-compliant `did:cid` scheme.

## Protocol

- [White Paper](WHITEPAPER.md) — full protocol specification (v1.1)
- [DID Scheme](scheme.md) — the `did:cid` method specification
- [did:cid Technical Presentation](presentations/did-cid-technical-presentation.md) — slide outline, speaker notes, and prep checklist
- [Gatekeeper Resolution Infographic](presentations/gatekeeper-resolution-infographic.md) — visual brief for operation import and DID document replay

## Operations

- [Deployment Guide](deployment.md) — Docker Compose setup from core node to full Lightning stack
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
