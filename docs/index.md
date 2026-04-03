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

## API Reference

- [Gatekeeper API](gatekeeper-api.json) — OpenAPI spec
- [Keymaster API](keymaster-api.json) — OpenAPI spec
