# Rust Gatekeeper Compatibility Contract

This document freezes the current Gatekeeper compatibility target for the Rust
port in terms of the TypeScript service at
[services/gatekeeper/server/src/gatekeeper-api.ts](/home/david/archetech/archon/services/gatekeeper/server/src/gatekeeper-api.ts)
and
[services/gatekeeper/server/src/config.js](/home/david/archetech/archon/services/gatekeeper/server/src/config.js).

## Public routes

The TypeScript service exposes these public routes under `/api/v1`:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/ready` | Returns a JSON boolean. |
| `GET` | `/version` | Returns `{ version, commit }`. |
| `GET` | `/status` | Returns `{ uptimeSeconds, dids, memoryUsage }`. |
| `POST` | `/did` | Create/update/delete entrypoint. |
| `POST` | `/did/generate` | Deterministic DID generation without persistence. |
| `GET` | `/did/:did` | Local resolution with optional fallback resolver. |
| `POST` | `/dids` | Alias of `/dids/` in Rust for compatibility. |
| `POST` | `/dids/` | DID listing and optional resolution/filtering. |
| `POST` | `/dids/remove` | Admin protected. |
| `POST` | `/dids/export` | Export one or more DID event chains. |
| `POST` | `/dids/import` | Admin protected. |
| `POST` | `/batch/export` | Admin protected. |
| `POST` | `/batch/import` | Admin protected. |
| `POST` | `/batch/import/cids` | Admin protected. |
| `GET` | `/queue/:registry` | Admin protected. |
| `POST` | `/queue/:registry/clear` | Admin protected. |
| `GET` | `/registries` | Returns the active supported registries. |
| `GET` | `/db/reset` | Admin protected and forbidden in production. |
| `GET` | `/db/verify` | Admin protected. |
| `POST` | `/events/process` | Admin protected. |
| `POST` | `/ipfs/json` | Add JSON and return a CID string. |
| `GET` | `/ipfs/json/:cid` | Return JSON payload. |
| `POST` | `/ipfs/text` | Add text and return a CID string. |
| `GET` | `/ipfs/text/:cid` | Return plain text payload. |
| `POST` | `/ipfs/data` | Add binary data and return a CID string. |
| `GET` | `/ipfs/data/:cid` | Return binary payload. |
| `POST` | `/ipfs/stream` | Add stream and return a CID string. |
| `GET` | `/ipfs/stream/:cid` | Return streamed content; `type` and `filename` query params are honored. |
| `GET` | `/block/:registry/latest` | Latest known block for the registry. |
| `GET` | `/block/:registry/:blockId` | Block lookup by hash or height. |
| `POST` | `/block/:registry` | Admin protected. |
| `GET` | `/search` | Full-text DID search. |
| `POST` | `/query` | Structured query with `where`. |

Additional top-level routes:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/metrics` | Prometheus exposition endpoint. |
| `ANY` | `/api/*` | Unhandled API routes return `404` with `{ "message": "Endpoint not found" }`. |

## Admin auth contract

- Header name: `X-Archon-Admin-Key`
- Missing or invalid key response:
  - status: `401`
  - body: `{ "error": "Unauthorized — valid admin API key required" }`
- When `ARCHON_ADMIN_API_KEY` is unset, admin routes are open for development.

## Env/runtime contract

These values are part of the TypeScript Gatekeeper contract and the Rust service
must continue to honor them:

| Env var | TypeScript default | Contract |
| --- | --- | --- |
| `ARCHON_GATEKEEPER_PORT` | `4224` | HTTP listen port. |
| `ARCHON_BIND_ADDRESS` | `0.0.0.0` | HTTP bind address. |
| `ARCHON_GATEKEEPER_DB` | `redis` | Storage/backend selector. |
| `ARCHON_IPFS_URL` | `http://localhost:5001/api/v0` | Kubo API base URL. |
| `ARCHON_GATEKEEPER_DID_PREFIX` | `did:cid` | DID prefix used for local generation. |
| `ARCHON_GATEKEEPER_REGISTRIES` | unset | Optional comma-separated registry allowlist. |
| `ARCHON_GATEKEEPER_JSON_LIMIT` | `4mb` | JSON request-body size limit. |
| `ARCHON_GATEKEEPER_UPLOAD_LIMIT` | `10mb` | Binary/text upload body limit. |
| `ARCHON_GATEKEEPER_GC_INTERVAL` | `15` | DID verification/GC interval in minutes. |
| `ARCHON_GATEKEEPER_STATUS_INTERVAL` | `5` | Periodic DID status refresh interval in minutes. |
| `ARCHON_ADMIN_API_KEY` | empty string | Admin API protection. |
| `ARCHON_GATEKEEPER_FALLBACK_URL` | `https://dev.uniresolver.io` | Universal resolver fallback base URL. |
| `ARCHON_GATEKEEPER_FALLBACK_TIMEOUT` | `5000` | Fallback resolver timeout in milliseconds. |
| `GIT_COMMIT` | `unknown` | Commit label for `/version` and `service_version_info`. |

## Domain type freeze

The TypeScript source of truth is
[packages/gatekeeper/src/types.ts](/home/david/archetech/archon/packages/gatekeeper/src/types.ts).
The Rust service must preserve these JSON field names and optionality:

- `Operation`
- `Proof`
- `GatekeeperEvent`
- `DidCidDocument`
- `ResolveDIDOptions`
- `ImportBatchResult`
- `ImportEventsResult`
- `ProcessEventsResult`
- `VerifyDbResult`
- `CheckDIDsResult`
- `BlockInfo`

The Rust port now includes a storage trait equivalent in spirit to
`GatekeeperDb` so backend implementations can converge on the same contract
without reworking the HTTP layer.

For the JSON family of backends, the Rust port treats the native JSON store as
the canonical file-backed implementation and uses the same DID suffix keying
scheme as TypeScript storage: the final segment after the last `:` is the
persistent key.

## Docker/container contract

The Rust image is intended to be a drop-in replacement for the TypeScript
Gatekeeper container:

- same container port: `4224` by default
- same mounted data root expectation: `ARCHON_DATA_DIR`, defaulting to `data`
- same admin header contract
- same `/metrics`, `/api/v1/ready`, and `/api/v1/version` endpoints
- same `GIT_COMMIT` injection pattern

The Rust-only image intentionally contains no Node.js or TypeScript runtime.

## Metrics contract

The gatekeeper-specific Prometheus metrics that must remain stable are:

- `http_requests_total{method,route,status}`
- `http_request_duration_seconds{method,route,status}`
- `did_operations_total{operation,registry,status}`
- `events_queue_size{registry}`
- `gatekeeper_dids_total`
- `gatekeeper_dids_by_type{type}`
- `gatekeeper_dids_by_registry{registry}`
- `service_version_info{version,commit}`

The TypeScript normalization behavior for `route` is intentionally preserved,
including these normalizations:

- `/api/v1/did/did:...` -> `/api/v1/did/:did`
- `/api/v1/block/<registry>/latest` -> `/api/v1/block/:registry/latest`
- `/api/v1/block/<registry>/<blockId>` -> `/api/v1/block/:registry/<blockId>`
- `/api/v1/queue/<registry>/clear` -> `/api/v1/queue/:registry/clear`
- `/api/v1/queue/<registry>` -> `/api/v1/queue/:registry`
- `/api/v1/events/<registry>` -> `/api/v1/events/:registry`
- `/api/v1/dids/<prefix>` -> `/api/v1/dids/:prefix`

## Memory usage compatibility

The TypeScript service returns Node/V8 memory statistics in `/status`.
The Rust port preserves the same response shape and currently returns zeroes for
those fields as a compatibility-safe placeholder:

- `rss`
- `heapTotal`
- `heapUsed`
- `external`
- `arrayBuffers`
