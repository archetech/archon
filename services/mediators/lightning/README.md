# Archon Lightning mediator

The Lightning mediator is the home for Lightning-specific runtime behavior that used to live inside Drawbridge.

## Responsibilities

- CLN-backed invoice creation and status checks
- LNBits wallet and payment operations
- Public invoice generation for published DIDs
- Lightning Address and DID-based zap flows
- Lightning-specific Redis state
- L402 invoice creation and invoice-status lookups for Drawbridge

## Environment variables

| variable | default | description |
| --- | --- | --- |
| `ARCHON_LIGHTNING_MEDIATOR_PORT` | `4235` | HTTP port for the mediator |
| `ARCHON_BIND_ADDRESS` | `0.0.0.0` | Bind address |
| `ARCHON_LIGHTNING_MEDIATOR_REDIS_URL` | `ARCHON_REDIS_URL` or `redis://localhost:6379` | Redis connection string |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper URL for DID-based Lightning lookups |
| `ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL` | `https://cln:3001` | CLN REST endpoint |
| `ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE` | empty | CLN rune |
| `ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL` | empty | LNBits base URL |
| `ARCHON_LIGHTNING_MEDIATOR_PUBLIC_HOST` | empty | Public base URL for invoice publication |
| `ARCHON_LIGHTNING_MEDIATOR_TOR_PROXY` | empty | Tor SOCKS proxy for onion-aware Lightning flows |
