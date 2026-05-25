# Archon Service Specifications

Language-agnostic contracts for every Archon service. Each spec is the
single source of truth that the canonical TypeScript implementation
under [services/](../../services/) and any future port (Rust, Go,
Python, …) must agree on — a conforming implementation is intended to
be a drop-in replacement that no other component in the stack notices.

> **Conventions.** All wire formats are JSON over HTTP. Field names are
> camelCase. Timestamps are RFC 3339 / ISO 8601 in UTC unless otherwise
> noted. CIDs are CIDv1 base32. DIDs follow the `did:cid:<cid>` form.
> "MUST", "SHOULD", "MAY" follow RFC 2119.

---

## Core services

The four long-running services every Archon node depends on.

| Spec | Role |
| --- | --- |
| [Gatekeeper](gatekeeper/README.md) | DID event store, resolution, IPFS passthrough. The validation authority. |
| [Keymaster](keymaster/README.md) | Wallet service. Owns IDs, mnemonics, credentials, encryption, and the only HTTP source of signing material for the wallet mediators. |
| [Drawbridge](drawbridge/README.md) | Public-facing API gateway. Enforces the L402 paywall and subscription credentials, then proxies to Gatekeeper / Herald / Lightning. |
| [Herald](herald/README.md) | Name service. Issues membership credentials and publishes a directory as JSON, IPNS, LUD-16, WebFinger, and OIDC. |

---

## Mediators

Mediators bridge the Gatekeeper to external networks. They consume
operations from a per-registry queue
(`gatekeeper.getQueue(<registry>)`), write them somewhere external, and
mirror discovered batches back via `gatekeeper.importBatchByCids`. The
mediator never holds private keys; every signing mediator delegates to
a companion **wallet** service that reads the mnemonic from Keymaster.

### Anchoring registries

Each pair below is one canonical registry name (`BTC:mainnet`,
`ETH:sepolia`, `SOL:mainnet`, `ZEC:mainnet`, …).

| Mediator | Wallet | Anchor mechanism |
| --- | --- | --- |
| [Satoshi](mediators/satoshi/README.md) | [satoshi-wallet](mediators/satoshi-wallet/README.md) | Bitcoin `OP_RETURN` (mainnet / signet / testnet4). |
| [Ethereum](mediators/ethereum/README.md) | [ethereum-wallet](mediators/ethereum-wallet/README.md) | `ArchonRegistry` smart-contract event logs. |
| [Solana](mediators/solana/README.md) | [solana-wallet](mediators/solana-wallet/README.md) | Solana memo program. |
| [Zcash](mediators/zcash/README.md) | [zcash-wallet](mediators/zcash-wallet/README.md) | Transparent Zcash `OP_RETURN`. |

### Peer-to-peer

| Mediator | Role |
| --- | --- |
| [Hyperswarm](mediators/hyperswarm/README.md) | Live P2P relay of DID operations between Archon nodes. The default registry for new DIDs. |

### Storage (auxiliary `pin` queue)

Both drain the shared `pin` queue and copy each operation's CAR to a
durable backend. Run **at most one per node**; they do not coordinate.

| Mediator | Backend |
| --- | --- |
| [Filecoin](mediators/filecoin/README.md) + [filecoin-wallet](mediators/filecoin-wallet/README.md) | Synapse / Filecoin Pay. |
| [Pinning](mediators/pinning/README.md) | Any IPFS Pinning Service API endpoint (Filebase, Pinata, …). |

### Payments

| Mediator | Role |
| --- | --- |
| [Lightning](mediators/lightning/README.md) | LNbits + CLN bridge for Drawbridge L402 invoices and DID-to-DID / LUD-16 zaps. |

---

## OpenAPI references

- [Gatekeeper API](../gatekeeper-api.html) (browsable) — [raw OpenAPI](../gatekeeper-api.json)
- [Keymaster API](../keymaster-api.html) (browsable) — [raw OpenAPI](../keymaster-api.json)
