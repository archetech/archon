# Archon Lightning mediator

The Lightning mediator is the home for Lightning-specific runtime behavior that used to live inside Drawbridge.

## Responsibilities

- CLN-backed invoice creation and status checks
- LNBits wallet and payment operations
- Public invoice generation for published DIDs
- Lightning Address and DID-based zap flows
- Lightning-specific Redis state
- L402 invoice creation, pending-invoice storage, and invoice-status lookups for Drawbridge

## Ownership boundary

- `lightning-mediator` owns Lightning-facing integrations and invoice lifecycle state
- Drawbridge owns macaroons, pricing, rate limits, and the final payment record that proves access was granted

That means pending L402 invoice state lives in the mediator, while Drawbridge still records completed payments as part of its access-policy audit trail.

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
| `ARCHON_DRAWBRIDGE_PUBLIC_HOST` | empty | Preferred public Drawbridge base URL for published invoice endpoints |
| `ARCHON_DRAWBRIDGE_PORT` | `4222` | Drawbridge port used when deriving the onion fallback |
| `ARCHON_LIGHTNING_MEDIATOR_PUBLIC_HOST` | empty | Legacy override for invoice publication when Drawbridge public host is unavailable |
| `ARCHON_LIGHTNING_MEDIATOR_TOR_PROXY` | empty | Tor SOCKS proxy for onion-aware Lightning flows |
