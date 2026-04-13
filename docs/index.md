# Archon Documentation

Archon is a decentralized identity protocol implementing the W3C-compliant `did:cid` scheme.

## Protocol

- [White Paper](WHITEPAPER.md) — full protocol specification (v1.1)
- [DID Scheme](scheme.md) — the `did:cid` method specification

## Operations

- [Deployment Guide](deployment.md) — Docker Compose setup from core node to full Lightning stack
- [Runtime Docker Architecture](runtime-container-architecture.md) — Mermaid diagrams of the live container topology
- [Nginx Reverse Proxy](nginx-proxy.conf.example) — example config for production

## Lightning

- [Lightning Zap Sequence](lightning-zap-sequence.md) — DID-to-DID and LUD-16 payment flows
- [Lightning Wallet Design](lightning-wallet-design.md) — wallet architecture and LNbits integration

## Service Specifications

Language-agnostic contracts for each Archon service. A conforming
implementation in any language is a drop-in replacement for the
canonical TypeScript reference.

- [Gatekeeper](services/gatekeeper/README.md) — DID event store, resolution, IPFS passthrough
- [Keymaster](services/keymaster/README.md) — wallet service, IDs, credentials, encryption
- [Drawbridge](services/drawbridge/README.md) — L402 paywall and public-facing proxy
- [Herald](services/herald/README.md) — name service with W3C credentials
- [Hyperswarm mediator](services/mediators/hyperswarm/README.md) — P2P DID operation relay
- [Lightning mediator](services/mediators/lightning/README.md) — LNbits + CLN bridge
- [Satoshi mediator](services/mediators/satoshi/README.md) — BTC chain anchoring
- [Satoshi wallet](services/mediators/satoshi-wallet/README.md) — BIP84 HD wallet for anchoring

## API Reference

- [Gatekeeper API](gatekeeper-api.html) — browsable reference
  ([raw OpenAPI](gatekeeper-api.json))
- [Keymaster API](keymaster-api.html) — browsable reference
  ([raw OpenAPI](keymaster-api.json))
