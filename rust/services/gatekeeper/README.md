# Rust Gatekeeper

This service is a native Rust implementation of Gatekeeper.

The goal is strict:

- zero Node runtime dependency
- zero TypeScript runtime dependency
- same public container contract
- same public HTTP contract

Implemented natively:

- startup and config loading
- HTTP routing
- Prometheus `/metrics`
- `/api/v1/ready`
- `/api/v1/version`
- `/api/v1/status`
- `/api/v1/registries`
- `/api/v1/did/generate`
- `/api/v1/did`
- `/api/v1/did/:did`
- `/api/v1/dids`
- `/api/v1/dids/`
- `/api/v1/dids/export`
- `/api/v1/dids/import`
- `/api/v1/dids/remove`
- `/api/v1/batch/export`
- `/api/v1/batch/import`
- `/api/v1/batch/import/cids`
- `/api/v1/queue/:registry`
- `/api/v1/queue/:registry/clear`
- `/api/v1/events/process`
- `/api/v1/db/reset`
- `/api/v1/db/verify`
- `/api/v1/block/:registry`
- `/api/v1/block/:registry/latest`
- `/api/v1/block/:registry/:blockId`
- `/api/v1/search`
- `/api/v1/query`
- `/api/v1/ipfs/json`
- `/api/v1/ipfs/text`
- `/api/v1/ipfs/data`
- `/api/v1/ipfs/stream`
- native create, update, delete, import, queue, block, and search behavior
- native signature and proof verification
- native JSON, SQLite, Redis, and Mongo-backed persistence
- fallback DID resolution when local resolution misses

Still to validate for cutover:

- exhaustive side-by-side fixture coverage for asset, ephemeral, and fallback-heavy scenarios
- dependent-service compose swap verification
- final default-image promotion

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
- `ARCHON_DATA_DIR`

Backend-specific runtime knobs:

- `ARCHON_REDIS_URL` for `ARCHON_GATEKEEPER_DB=redis`
- `ARCHON_MONGODB_URL` for `ARCHON_GATEKEEPER_DB=mongodb`

## Docker

Use `Dockerfile.gatekeeper-rust` to build the native Rust Gatekeeper image.
