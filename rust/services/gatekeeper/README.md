# Rust Gatekeeper

This service is a native Rust rewrite target for Gatekeeper.

The goal is strict:

- zero Node runtime dependency
- zero TypeScript runtime dependency
- same public container contract
- same public HTTP contract

The current state is a native Rust foundation, not full feature parity yet.

Implemented natively:

- startup and config loading
- HTTP routing
- Prometheus `/metrics`
- `/api/v1/ready`
- `/api/v1/version`
- `/api/v1/status`
- `/api/v1/registries`
- `/api/v1/ipfs/json`
- `/api/v1/ipfs/text`
- `/api/v1/ipfs/data`
- `/api/v1/ipfs/stream`
- `/api/v1/did/:did` via the configured universal resolver fallback

Still to port natively:

- DID create/update/delete logic
- DID database and event processing
- batch import/export
- queue and block operations
- search and structured query

## Runtime

The service reads the same core Gatekeeper env vars:

- `ARCHON_GATEKEEPER_PORT`
- `ARCHON_BIND_ADDRESS`
- `ARCHON_GATEKEEPER_DB`
- `ARCHON_IPFS_URL`
- `ARCHON_GATEKEEPER_DID_PREFIX`
- `ARCHON_GATEKEEPER_REGISTRIES`
- `ARCHON_GATEKEEPER_JSON_LIMIT`
- `ARCHON_GATEKEEPER_UPLOAD_LIMIT`
- `ARCHON_GATEKEEPER_GC_INTERVAL`
- `ARCHON_GATEKEEPER_STATUS_INTERVAL`
- `ARCHON_ADMIN_API_KEY`
- `ARCHON_GATEKEEPER_FALLBACK_URL`
- `ARCHON_GATEKEEPER_FALLBACK_TIMEOUT`

## Docker

Use `Dockerfile.gatekeeper-rust` to build the native Rust Gatekeeper image.
