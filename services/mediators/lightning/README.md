# Archon Lightning mediator

The Lightning mediator is the planned home for all Lightning-specific runtime behavior that is currently embedded in Drawbridge.

This initial scaffold only provides service startup, readiness, version, metrics, and a basic capability endpoint. Future stages of the refactor will move CLN, LNBits, public invoice generation, zap flows, and Lightning-specific Redis state into this service.

## Planned responsibilities

- CLN-backed invoice creation and status checks
- LNBits wallet and payment operations
- Public invoice generation for published DIDs
- Lightning Address and DID-based zap flows
- Lightning-specific Redis state

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
