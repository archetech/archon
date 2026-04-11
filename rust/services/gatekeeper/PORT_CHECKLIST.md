# Rust Gatekeeper Port Checklist

This checklist tracks the full native Rust port of Gatekeeper with these goals:

- zero Node runtime dependency
- zero TypeScript runtime dependency
- same public container contract
- same public HTTP contract
- drop-in replacement for the current TypeScript Gatekeeper service

## Compatibility target

- [x] Enumerate every Gatekeeper HTTP route from [services/gatekeeper/server/src/gatekeeper-api.ts](/home/david/archetech/archon/services/gatekeeper/server/src/gatekeeper-api.ts).
- [x] Freeze request and response shapes for each route, including error payloads and status codes.
- [x] Freeze the env var/runtime contract from [services/gatekeeper/server/src/config.js](/home/david/archetech/archon/services/gatekeeper/server/src/config.js).
- [x] Freeze Docker/container compatibility requirements, including port, mounted data path, and healthcheck behavior.
- [x] Freeze Prometheus metric names, labels, and route-normalization behavior.

## Parity fixtures

- [x] Add black-box API fixtures that can be run against both the TypeScript and Rust Gatekeeper services.
- [ ] Cover happy-path and failure-path responses for every public endpoint.
- [ ] Add fixtures for agent DIDs, asset DIDs, ephemeral DIDs, local registries, remote registries, invalid proofs, and fallback resolution.
- [x] Snapshot metrics exposition output for parity comparison.

## Domain types

- [x] Port `Operation` and related proof types from [packages/gatekeeper/src/types.ts](/home/david/archetech/archon/packages/gatekeeper/src/types.ts).
- [x] Port `GatekeeperEvent`.
- [x] Port `DidCidDocument` and nested metadata/registration/document types.
- [x] Port `ResolveDIDOptions`.
- [x] Port batch, queue, block, and verification result types.
- [ ] Preserve JSON field names and optionality exactly.

## Deterministic ID generation

- [x] Add native deterministic DID generation.
- [ ] Verify canonical JSON output matches the TypeScript `canonicalizeJSON` implementation byte-for-byte.
- [ ] Verify CID generation matches [packages/ipfs/src/utils.ts](/home/david/archetech/archon/packages/ipfs/src/utils.ts) byte-for-byte.
- [ ] Add cross-language test vectors for identical operations producing identical CIDs and DIDs.

## Signature and proof verification

- [x] Port `verifyProofFormat`.
- [x] Port `verifyCreateOperation`.
- [x] Port `verifyUpdateOperation`.
- [x] Match secp256k1 key and signature handling exactly.
- [x] Add valid and invalid proof test vectors shared with the TypeScript implementation.

## Storage layer

- [x] Add a native JSON-backed storage foundation.
- [x] Define a Rust storage trait equivalent to `GatekeeperDb`.
- [x] Port JSON storage behavior fully, including operations table and queue/block storage.
- [x] Port JSON-cache behavior if still needed.
- [ ] Port Redis backend.
- [ ] Port SQLite backend.
- [ ] Port MongoDB backend.
- [x] Preserve DID suffix keying semantics used by current storage.

## DID core behavior

- [x] Implement native `POST /api/v1/did/generate`.
- [x] Implement native `POST /api/v1/did` for create operations.
- [x] Implement native local resolution for create-only DIDs.
- [x] Port `generateDoc` for native local create/update/delete event reconstruction.
- [x] Port full local `resolveDID` behavior over event history.
- [x] Support local `versionTime`.
- [x] Support local `versionSequence`.
- [x] Support local `confirm`.
- [x] Support `verify`.
- [x] Match local deactivation and delete semantics.
- [x] Match local canonicalId/versionId/versionSequence metadata behavior.

## Update and delete flows

- [x] Port `updateDID` through native `/api/v1/did` event append handling.
- [x] Port `deleteDID` through native `/api/v1/did` event append handling.
- [x] Enforce `previd` semantics.
- [x] Preserve idempotency and duplicate-event behavior.
- [x] Ensure asset/controller update validation matches TypeScript behavior.

## DID listing and export/import

- [x] Implement native `POST /api/v1/dids` and `POST /api/v1/dids/` basic listing.
- [x] Match `updatedAfter` filtering.
- [x] Match `updatedBefore` filtering.
- [x] Match local `resolve`, `confirm`, and `verify` options in DID listing.
- [x] Port `exportDID`.
- [x] Port `exportDIDs`.
- [x] Port `importDIDs`.
- [x] Port `removeDIDs`.

## Event import and processing

- [x] Port `verifyOperation`.
- [x] Port `importEvent`.
- [x] Port `importEvents`.
- [x] Port `importBatch`.
- [x] Port `importBatchByCids`.
- [x] Port `processEvents`.
- [x] Preserve added/merged/rejected/deferred behavior.
- [x] Preserve reorg handling and ordinal comparison behavior.

## Queue behavior

- [x] Port `queueOperation`.
- [x] Port `getQueue`.
- [x] Port `clearQueue`.
- [x] Preserve `local` and `hyperswarm` queue behavior.
- [x] Preserve max-queue-size effects on supported registries.

## Block handling

- [x] Port `addBlock`.
- [x] Port `getBlock`.
- [x] Preserve latest-block selection behavior.
- [x] Preserve hash and numeric-height lookups.
- [x] Preserve timestamp metadata generation used by DID resolution.

## Search and structured query

- [x] Port the search index behavior from [packages/gatekeeper/src/search-index.ts](/home/david/archetech/archon/packages/gatekeeper/src/search-index.ts).
- [x] Port `searchDocs`.
- [x] Port `queryDocs`.
- [x] Port `search`.
- [x] Add parity tests for search and query results.

## IPFS behavior

- [x] Implement native IPFS JSON endpoints.
- [x] Implement native IPFS text endpoints.
- [x] Implement native IPFS data endpoints.
- [x] Implement native IPFS stream endpoints.
- [ ] Verify IPFS add/get behavior is byte-for-byte compatible where applicable.
- [ ] Verify returned CIDs match the TypeScript implementation for the same inputs.
- [ ] Verify stream content type and attachment behavior match exactly.

## Status and maintenance loops

- [x] Implement native `/api/v1/ready`.
- [x] Implement native `/api/v1/version`.
- [x] Implement native `/api/v1/status` foundation.
- [x] Port `checkDIDs`.
- [x] Port `verifyDb`.
- [x] Port queue and DID gauges derived from actual DB contents.
- [x] Port GC loop behavior.
- [x] Port periodic status reporting behavior.
- [ ] Decide how to represent memory stats in a compatibility-safe way.

## Admin behavior and errors

- [x] Add native `X-Archon-Admin-Key` enforcement scaffold.
- [x] Match production restriction behavior for `/db/reset`.
- [ ] Match all admin route status codes and error bodies exactly.
- [x] Match unhandled `/api` endpoint behavior exactly.

## Metrics parity

- [x] Add native Prometheus metrics endpoint.
- [x] Match all current metric names exactly.
- [x] Match current label cardinality and route normalization exactly.
- [x] Match DID operation counters exactly.
- [x] Match queue and DID gauges exactly.
- [x] Match service version gauge semantics exactly.

## Docker and deployment

- [x] Add Rust-only Dockerfile with no TypeScript runtime dependency.
- [x] Add compose override for Rust Gatekeeper image selection.
- [ ] Verify compose swap works with dependent services unchanged.
- [ ] Verify mounted `./data` semantics match the TypeScript container.
- [ ] Verify healthcheck behavior matches the current service.

## Final cutover

- [ ] Run the full fixture suite against both implementations and diff responses.
- [ ] Run side-by-side metrics diffs.
- [ ] Run side-by-side DID generation and resolution diffs.
- [ ] Confirm zero Node/TypeScript runtime in the final image.
- [ ] Confirm dependent services can use the Rust Gatekeeper unchanged.
- [ ] Promote the Rust Gatekeeper image to the default Gatekeeper implementation.

## Recommended implementation order

- [x] Phase 1: full create/update/delete event chains and local DID resolution parity.
- [x] Phase 2: import/export, event processing, queue, and block behavior.
- [x] Phase 3: search/query and maintenance-loop foundations.
- [x] Phase 4: signature/proof verification parity and DID verification semantics.
- [ ] Phase 5: storage/backend parity, compatibility fixtures, and exact metrics/error matching.
- [ ] Phase 6: deployment cutover, dependent-service validation, and default-image promotion.

## Remaining work by phase

### Phase 4

- Phase 4 implementation is complete; remaining parity automation now rolls into Phase 5.

### Phase 5

- Finish full endpoint-by-endpoint black-box fixture coverage, especially DID/import/export/IPFS fallback cases.
- Preserve JSON field names and optionality exactly for every response object.
- Port the remaining backend work:
  - Redis backend
  - SQLite backend
  - MongoDB backend
- Finish exact admin route status/error matching across every payload validation branch.
- Decide whether `/status.memoryUsage` should remain zero-filled or be backed by real Rust process metrics.

### Phase 6

- Finish the remaining `Docker and deployment` items.
- Finish all `Final cutover` items.
