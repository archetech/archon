# Archon Gatekeeper — Service Specification

This document is the language-agnostic contract that any Gatekeeper
implementation must satisfy. It is what both the existing TypeScript service
([services/gatekeeper/server/](../../../services/gatekeeper/server/)) and the
native Rust port ([rust/services/gatekeeper/](../../../rust/services/gatekeeper/))
agree on, and what a third implementation in Go, Python, Java, etc. would need
to honor to be a drop-in replacement.

The intent is that any conforming implementation can be substituted in place
of the others without any other component of the Archon stack — Keymaster,
Drawbridge, mediators, wallets, dashboards — noticing.

> **Conventions.** All wire formats are JSON over HTTP. Field names are
> camelCase. Timestamps are RFC 3339 / ISO 8601 in UTC unless otherwise
> noted. CIDs are CIDv1 base32. DIDs follow the `did:cid:<cid>` form.
> "MUST", "SHOULD", "MAY" follow RFC 2119.

---

## Table of contents

1. [Service responsibilities](#1-service-responsibilities)
2. [HTTP API contract](#2-http-api-contract)
3. [Domain types](#3-domain-types)
4. [DID generation algorithm](#4-did-generation-algorithm)
5. [Cryptographic proof contract](#5-cryptographic-proof-contract)
6. [DID resolution algorithm](#6-did-resolution-algorithm)
7. [DID create / update / delete validation](#7-did-create--update--delete-validation)
8. [Event import state machine](#8-event-import-state-machine)
9. [Search and structured query](#9-search-and-structured-query)
10. [Storage contract](#10-storage-contract)
11. [IPFS interaction contract](#11-ipfs-interaction-contract)
12. [Maintenance loops](#12-maintenance-loops)
13. [Prometheus metrics contract](#13-prometheus-metrics-contract)
14. [Container and runtime contract](#14-container-and-runtime-contract)
15. [Logging conventions](#15-logging-conventions)
16. [Test fixtures](#16-test-fixtures)
17. [Reference implementations](#17-reference-implementations)

---

## 1. Service responsibilities

The Gatekeeper is the canonical gateway between Archon clients (Keymaster,
mediators, wallets) and:

- a **DID event store** (per-DID append-only log of create/update/delete operations)
- one or more **registries** (`local`, `hyperswarm`, `BTC:mainnet`, `BTC:signet`, `BTC:testnet4`, `ZEC:mainnet`, `ZEC:testnet`)
- an **IPFS node** (Kubo-compatible)
- a **block store** (per-registry block index for resolution timestamps)

It is responsible for:

- generating deterministic DIDs from create operations
- verifying cryptographic proofs (secp256k1 ECDSA over SHA-256 of canonical JSON)
- resolving DIDs into `didDocument` + `didDocumentMetadata` per the DID Core spec
- exposing a standards-conformant DID resolution and dereferencing surface (`/1.0/identifiers`) per the DID Resolution data model
- managing the import queue for events received from other nodes
- exposing IPFS read/write through HTTP for clients without their own Kubo
- serving Prometheus metrics and a small set of admin/operational endpoints

It is **not** responsible for:

- network-level synchronization between nodes (mediators do that)
- wallet or key management (Keymaster does that)
- Lightning, payments, or LNbits (Drawbridge does that)

---

## 2. HTTP API contract

The service binds to `${ARCHON_BIND_ADDRESS}:${ARCHON_GATEKEEPER_PORT}`
(default `0.0.0.0:4224`). Most API routes live under `/api/v1`. A
standards-conformant DID resolution surface lives under `/1.0/identifiers`
(see [§2.6](#26-conformant-did-resolution-surface)). Two other non-versioned
routes exist: `/metrics` for Prometheus and an `/api/*` catch-all for
unhandled paths.

### 2.1 Routes

| Method | Path | Admin? | Notes |
| --- | --- | :---: | --- |
| `GET` | `/api/v1/ready` | no | JSON boolean. `true` once startup is complete. |
| `GET` | `/api/v1/version` | no | `{ "version": string, "commit": string }` (commit truncated to 7 chars). |
| `GET` | `/api/v1/status` | no | `{ uptimeSeconds, dids, memoryUsage }`. See [§3.10](#310-status-payload). |
| `GET` | `/api/v1/registries` | no | JSON array of supported registry names. |
| `POST` | `/api/v1/did` | no | Submit a `create`, `update`, or `delete` operation. Create returns the new DID string; update/delete return `true`. See [§7](#7-did-create--update--delete-validation). |
| `POST` | `/api/v1/did/generate` | no | Deterministic DID generation without persistence. Body: `Operation`. Returns: DID string. |
| `GET` | `/api/v1/did/:did` | no | Resolve a DID (internal resolver; returns the full document set incl. `didDocumentData`/`didDocumentRegistration`, see [§3.7](#37-didciddocument-resolution-result)). Query params: `versionTime` (ISO 8601), `versionSequence` (int), `confirm` (`"true"`/`"false"`), `verify` (`"true"`/`"false"`). See [§6](#6-did-resolution-algorithm). For the standards-conformant surface see [§2.6](#26-conformant-did-resolution-surface). |
| `POST` | `/api/v1/dids/` | no | List DIDs. Body: `GetDIDOptions`. Only `/dids/` is registered explicitly; Express matches both `/dids` and `/dids/`. |
| `POST` | `/api/v1/dids/remove` | yes | Body: array of DIDs. Returns boolean. |
| `POST` | `/api/v1/dids/export` | no | Body: `{ "dids": string[] | undefined }`. Returns `GatekeeperEvent[][]` (one inner array per DID). |
| `POST` | `/api/v1/dids/import` | yes | Body: `GatekeeperEvent[][]`. Flattens into a batch and queues for processing. Returns `ImportBatchResult`. |
| `POST` | `/api/v1/batch/export` | yes | Body: `{ "dids": string[] | undefined }`. Returns a single `GatekeeperEvent[]`, sorted by `proof.created`, holding the full history of every chosen DID that is gossip-eligible. Eligibility is per DID, not per event, and an eligible DID exports its `local` operations too — see [§8.7](#87-batch-export-eligibility). |
| `POST` | `/api/v1/batch/import` | yes | Body: `GatekeeperEvent[]`. Returns `ImportBatchResult`. Empty arrays MUST be rejected with HTTP 500 `Error: Invalid parameter: batch`. |
| `POST` | `/api/v1/batch/import/cids` | yes | Body: `{ "cids": string[], "metadata": BatchMetadata }`. Hydrates each CID via the operation store or IPFS, then imports. Empty `cids` MUST 500 with `Error: Invalid parameter: cids`; missing `metadata.registry`/`time`/`ordinal` MUST 500 with `Error: Invalid parameter: metadata`. |
| `GET` | `/api/v1/queue/:registry` | yes | Returns queued outbound `Operation[]` for the registry. |
| `POST` | `/api/v1/queue/:registry/clear` | yes | Body: `Operation[]`. Removes the matching events (matched by `proof.proofValue`) from the queue. Returns `boolean` (true on success). |
| `GET` | `/api/v1/db/reset` | yes | Resets the DB. MUST return HTTP 403 `{"error":"Database reset is disabled in production"}` when `NODE_ENV=production`. |
| `GET` | `/api/v1/db/verify` | yes | Runs `verifyDb` (see [§12](#12-maintenance-loops)) and returns `VerifyDbResult`. |
| `POST` | `/api/v1/events/process` | yes | Drains the import queue. Returns `{ "busy": true }` if already running, otherwise `ProcessEventsResult`. |
| `POST` | `/api/v1/ipfs/json` | no | Body: any JSON. Returns the CID as `text/plain`. Bounded by `ARCHON_GATEKEEPER_JSON_LIMIT`. |
| `GET` | `/api/v1/ipfs/json/:cid` | no | Returns the JSON payload. |
| `POST` | `/api/v1/ipfs/text` | no | Body: `text/plain` up to `ARCHON_GATEKEEPER_UPLOAD_LIMIT`. Returns CID. |
| `GET` | `/api/v1/ipfs/text/:cid` | no | Returns text. |
| `POST` | `/api/v1/ipfs/data` | no | Body: `application/octet-stream` up to `ARCHON_GATEKEEPER_UPLOAD_LIMIT`. Returns CID. |
| `GET` | `/api/v1/ipfs/data/:cid` | no | Returns binary. |
| `POST` | `/api/v1/ipfs/stream` | no | Body: streamed; **no server-side size cap**. Returns CID. |
| `GET` | `/api/v1/ipfs/stream/:cid` | no | Streams the content. Query `type` overrides Content-Type (default `application/octet-stream`); `filename` adds `Content-Disposition: attachment; filename="..."`. |
| `GET` | `/api/v1/block/:registry/latest` | no | Latest known block for the registry. |
| `GET` | `/api/v1/block/:registry/:blockId` | no | Block lookup. Numeric `blockId` is treated as height; otherwise as hash. |
| `POST` | `/api/v1/block/:registry` | yes | Body: `BlockInfo`. Returns boolean. |
| `GET` | `/api/v1/search` | no | Query `q`. Returns array of DIDs whose `didDocumentData` contains the query string. Empty `q` returns `[]`. |
| `POST` | `/api/v1/query` | no | Body: `{ "where": {...} }`. See [§9](#9-search-and-structured-query). MUST return HTTP 400 `{"error":"`where` must be an object"}` if `where` is missing or not an object. |
| `GET` | `/metrics` | no | Prometheus exposition. See [§13](#13-prometheus-metrics-contract). |
| `*` | `/api/*` (unmatched) | no | HTTP 404 with body `{"message":"Endpoint not found"}`. |

### 2.2 Admin authentication

- Header: `X-Archon-Admin-Key` (case-insensitive)
- `ARCHON_ADMIN_API_KEY` is **required**. Admin routes MUST require a matching header.
- On missing or wrong key, return:
  - status `401`
  - body `{"error":"Unauthorized — valid admin API key required"}` (note the em dash)
- The comparison MUST be constant-time (e.g. `crypto.timingSafeEqual`), so a wrong
  key cannot be recovered byte-by-byte from response timing.
- When `ARCHON_ADMIN_API_KEY` is unset/empty, admin routes MUST **fail closed**:
  - status `403`
  - body `{"error":"Admin API key not configured"}`
- The server entry point MUST additionally refuse to start when
  `ARCHON_ADMIN_API_KEY` is unset, exiting non-zero with a message naming the
  variable. Mediators authenticate against these same admin routes with the same
  key, so starting without one would leave them silently unable to sync. The 403
  above therefore applies only when the app is constructed programmatically (e.g.
  in tests) without a key.

### 2.3 CORS

The service MUST respond to cross-origin requests with permissive CORS so
that browser-based wallets/explorers can call it directly:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE` (the `cors()` default)
- `Access-Control-Allow-Headers`: reflects the request's `Access-Control-Request-Headers` (the `cors()` default)

Preflight `OPTIONS` requests MUST succeed.

### 2.4 Request body limits

- JSON endpoints (everything except `/ipfs/text`, `/ipfs/data`, `/ipfs/stream`):
  bounded by `ARCHON_GATEKEEPER_JSON_LIMIT` (default `4mb`).
- `/ipfs/text` and `/ipfs/data`: bounded by `ARCHON_GATEKEEPER_UPLOAD_LIMIT`
  (default `10mb`).
- `/ipfs/stream` (POST): **unbounded**; the body is piped directly to the
  IPFS node.

Limit strings parse case-insensitively as `<digits>(b|kb|mb)?`.

### 2.5 Error response shape

- 4xx/5xx errors that are caught by handlers MUST return either:
  - `text/plain` body of the form `Error: <message>` (matching the Node
    `error.toString()` convention), OR
  - `application/json` body `{"error":"..."}` for the well-defined cases
    listed in [§2.1](#21-routes).
- The unhandled-route fallback returns `{"message":"Endpoint not found"}`.
- Any uncaught panic / exception SHOULD return HTTP 500 and SHOULD be logged.

### 2.6 Conformant DID resolution surface

In addition to the internal `/api/v1/did/:did` resolver, the service MUST
expose a standards-conformant DID resolution and dereferencing surface under
the [Universal Resolver](https://github.com/decentralized-identity/universal-resolver)
driver convention `/1.0/identifiers`. This surface satisfies the W3C
[DID Resolution](https://www.w3.org/TR/did-core/#did-resolution) data model,
which permits only three top-level members in a resolution result.

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/1.0/identifiers/:did` | The DID Resolution result: exactly `didDocument`, `didResolutionMetadata`, `didDocumentMetadata`. See [§6.5](#65-conformant-resolution-result). |
| `GET` | `/1.0/identifiers/:did/data` | The DID's data resource (`didDocumentData`), returned as the raw resource (empty object for agents). |
| `GET` | `/1.0/identifiers/:did/registration` | The DID's registration/anchoring provenance (`didDocumentRegistration` plus confirmation/timestamp provenance), returned as the raw resource. |

Shared behavior:

- **Query params:** `versionTime` (ISO 8601) and `versionSequence` (int) only.
  Unlike `/api/v1/did/:did`, the non-standard `confirm`/`verify` params are
  NOT accepted; this surface always resolves with `confirm: true, verify:
  true` (confirmed, cryptographically verified state). Clients needing raw or
  unconfirmed state use `/api/v1/did/:did`.
- **Routing:** `:did` is a bare DID (a single path segment); the
  dereference resources are selected by the `/data` and `/registration`
  sub-paths, so DID-URL path parsing is handled by routing rather than the
  DID validator.
- **Dereferenceable resources:** `/data` and `/registration` are method-specific
  dereferenceable resources of the DID (the DID URLs `did:cid:<cid>/data` and
  `did:cid:<cid>/registration`), retrieved by content address. They are NOT
  part of the resolution result and are returned as the raw resource value
  (not wrapped in a named envelope).
- **Anchoring provenance:** confirmation state and block timestamp bounds are
  method-specific provenance. The conformant resolution result omits
  `didDocumentMetadata.confirmed` and `didDocumentMetadata.timestamp`; use
  `/registration` for those details.
- **Local-only (no fallback delegation):** unlike `/api/v1/did/:did`, this
  surface resolves solely from local state — it MUST NOT delegate to the
  universal-resolver `fallbackURL` or the confirmed-Gatekeeper peer on a local
  miss, and returns `notFound` instead. This is deliberate: `/1.0/identifiers`
  is the node's own Universal Resolver *driver* surface, so delegating to the
  configured `fallbackURL` (itself a Universal Resolver by default) could form
  a resolution loop and would return an external resolver's representation.
  Clients that want fallback/import-propagation behavior use `/api/v1/did/:did`.
- **Errors:**
  - `invalidDid` -> HTTP 400; `notFound` -> HTTP 404.
  - For `/:did`, errors are reported in `didResolutionMetadata.error` and the
    body remains triple-shaped (`didDocument: null`, `didDocumentMetadata:
    {}`).
  - For the dereference resources, the body is `{"error":"<value>"}`.
  - Any other path under `/1.0/identifiers` (an unsupported DID URL resource,
    e.g. `/1.0/identifiers/<did>/bogus`) MUST return HTTP 404
    `{"error":"notFound"}` — a structured JSON body, not a framework-default
    HTML 404.
  - A validation failure in the DID's own operation chain (surfaced by the
    forced `verify`) MUST be treated as `notFound` (HTTP 404), not an internal
    error. Unexpected failures (I/O, storage, crypto) MUST return HTTP 500 with
    error value `internalError` (triple-shaped for `/:did`) and SHOULD be logged.

---

## 3. Domain types

All field names below are wire-format JSON keys. Optional fields MAY be
omitted from the JSON object; required fields MUST be present unless noted.

### 3.1 `Operation`

```jsonc
{
  "type": "create" | "update" | "delete",   // required
  "created": "<RFC 3339>",                    // required for create
  "did": "did:cid:...",                       // required for update/delete
  "registration": DocumentRegistration,       // required for create
  "publicJwk": EcdsaJwkPublic,                // required for agent create
  "controller": "did:cid:...",                // required for asset create
  "doc": DidCidDocument,                      // optional update payload
  "previd": "<opid>",                         // required for update/delete
  "data": <any JSON>,                         // optional, asset-create only
  "blockid": "<block hash>",                  // optional anchoring info
  "proof": Proof                              // required everywhere except generate-only paths
}
```

### 3.2 `Proof`

Two accepted forms. The legacy one signs the operation alone; the Data Integrity
one signs the proof configuration with it, so `created` and `proofPurpose` are
inside the signature. Both MUST be accepted — every operation already anchored
carries the legacy form — and a node MUST select the payload from the proof's own
`type`.

```jsonc
{
  "type": "EcdsaSecp256k1Signature2019",      // the legacy form
  "created": "<RFC 3339>",                    // signature timestamp, NOT signed
  "verificationMethod": "<did>#key-1",         // for create-agent it is exactly "#key-1" (relative)
  "proofPurpose": "capabilityInvocation" | "authentication" | "assertionMethod",
  "proofValue": "<base64url(64-byte ECDSA r||s)>"
}
```

```jsonc
{
  "type": "DataIntegrityProof",
  "cryptosuite": "archon-ecdsa-secp256k1-jcs-2026",     // MUST be exactly this suite
  "created": "<RFC 3339>",                    // signed
  "verificationMethod": "<did>#key-1",
  "proofPurpose": "capabilityInvocation" | "authentication" | "assertionMethod",
  "proofValue": "<base64url(64-byte ECDSA r||s)>"
}
```

### 3.3 `DocumentRegistration`

```jsonc
{
  "version": 1,                               // currently only version 1 is valid
  "type": "agent" | "asset",
  "registry": "<registry-name>",              // e.g. "local", "hyperswarm", "BTC:signet", "ZEC:mainnet", or another configured registry
  "validUntil": "<RFC 3339>",                 // optional ephemeral expiry
  "prefix": "did:cid"                          // optional override of server default
}
```

### 3.4 `EcdsaJwkPublic`

```jsonc
{
  "kty": "EC",
  "crv": "secp256k1",
  "x": "<base64url(32-byte X coordinate)>",
  "y": "<base64url(32-byte Y coordinate)>"
}
```

### 3.5 `GatekeeperEvent`

```jsonc
{
  "registry": "local" | "hyperswarm" | "BTC:...",
  "time": "<RFC 3339>",
  "ordinal": [<u64>, <u64>...] | undefined,   // for total ordering within a registry
  "operation": Operation,
  "opid": "<CID>",                            // optional locally; required for IPFS-backed events
  "did": "did:cid:...",                        // optional; inferred from operation if missing
  "registration": ChainRegistration | undefined // required for chain registries
}
```

Chain-registry receipts require complete `ChainRegistration` and ordinal
`[height, index, ...registryPosition, opidx]`, with at least three nonnegative safe
integers (0 through 9007199254740991). The first two and last components must
match registration `height`, `index`, and `opidx`. `txid` and `batch` must be
nonempty strings. CID batch metadata uses `ChainBatchRegistration` and the
position prefix (at least height and index); Gatekeeper supplies opidx.
Missing, `null`, non-array, empty, and malformed-member ordinals are rejected
before queueing or candidate storage. CID imports validate the batch position
before appending the operation index. Non-string CID entries are skipped without
renumbering subsequent operations. Previously stored absent/null/empty ordinal
receipts cannot regain chain authority through startup replay. This does not add
a compatibility decoder for corrupt stored field types. `local`, `hyperswarm`,
and `pin` events may omit `ordinal`, but if they provide one it must still be an
array of nonnegative safe integers; only those unanchored registries may use an
empty array. The CID-import API still requires `BatchMetadata.ordinal` for every
registry. A nonempty CID list yielding no importable events returns zero
queued/processed/rejected counts and the current queue total.
Before journaling and during stored-candidate recovery, normalize `local` creation
receipts to `operation.created`, and `local` update/deletion receipts to
`operation.proof.created`. Hyperswarm and pin receipts use `proof.created` for all
operation kinds. Preserve operation bytes, canonical IDs and ordinals. Rebuild
accepted histories and dependent assets after repairing stored clocks; an old
receipt timestamp must not decide historical authorization.
The signed operation and its CID do not change. Peer/export imports are first
converted to Hyperswarm hints, so they do not need a chain ordinal and cannot
assert chain confirmation. Bundled chain mediators already supply positions.

### 3.6 `DidRegistration` (batch anchoring metadata)

```jsonc
{
  "height": 12345,
  "index": 7,
  "txid": "<hex>",
  "batch": "<CID>",
  "opidx": 2
}
```

### 3.7 `DidCidDocument` (resolution result)

This is the **full internal document set** returned by `/api/v1/did/:did` and
used throughout the protocol (including update operation payloads). The
standards-conformant `/1.0/identifiers/:did` surface returns only the
`didDocument` / `didResolutionMetadata` / `didDocumentMetadata` subset;
`didDocumentData` and `didDocumentRegistration` are dereferenced separately
(see [§2.6](#26-conformant-did-resolution-surface) and
[§6.5](#65-conformant-resolution-result)).

```jsonc
{
  "didDocument": {
    "@context": ["https://www.w3.org/ns/did/v1"],
    "id": "did:cid:...",
    "controller": "did:cid:...",              // asset owner; agents may only name themselves
    "verificationMethod": [...],              // agents
    "authentication": ["#key-1"],
    "assertionMethod": ["#key-1"],
    "service": [...]                           // optional
  },
  "didDocumentMetadata": {
    "created": "<RFC 3339>",
    "updated": "<RFC 3339>",                  // present after the first update
    "deleted": "<RFC 3339>",                  // present after delete
    "deactivated": true,                      // present and true after delete
    "canonicalId": "<DID>",                   // present iff registration.prefix was overridden
    "versionId": "<CID of latest event>",
    "versionSequence": "<int as string>",      // "1" for create, increments on update/delete
    "confirmed": true | false,                 // internal/API provenance; omitted from /1.0/identifiers
    "timestamp": {                             // internal/API provenance; omitted from /1.0/identifiers
      "chain": "BTC:signet",
      "opid": "<CID>",
      "lowerBound": { time, timeISO, blockid, height }, // omitted when unknown
      "upperBound": { time, timeISO, blockid, height, txid, txidx, batchid, opidx } // omitted when unknown
    }
  },
  "didDocumentData": <arbitrary>,             // assets carry user data here
  "didDocumentRegistration": DocumentRegistration,
  "didResolutionMetadata": {
    "retrieved": "<RFC 3339>",                 // server time of resolution
    "error": "notFound" | "invalidDid"         // present iff resolution failed
  }
}
```

### 3.8 `ResolveDIDOptions`

```jsonc
{
  "versionTime": "<RFC 3339>",                 // stop when resolution time > versionTime (§6)
  "versionSequence": <int>,                    // stop replay when versionSequence reached
  "confirm": true | false,                     // stop on first unconfirmed event
  "verify": true | false                       // re-verify every signature during resolution
}
```

### 3.9 `GetDIDOptions`

```jsonc
{
  "dids": string[] | undefined,                // filter; undefined = all DIDs
  "updatedAfter": "<RFC 3339>" | undefined,
  "updatedBefore": "<RFC 3339>" | undefined,
  "confirm": true | false | undefined,
  "verify": true | false | undefined,
  "resolve": true | false | undefined          // when true, return DidCidDocument[] instead of string[]
}
```

### 3.10 Status payload

```jsonc
{
  "uptimeSeconds": <int>,
  "dids": {                                    // CheckDIDsResult
    "total": <int>,
    "byType": { "agents", "assets", "confirmed", "unconfirmed", "ephemeral", "invalid": <int> },
    "byRegistry": { "<registry>": <int>, ... },
    "byVersion": { "<version>": <int>, ... },
    "eventsQueue": GatekeeperEvent[]           // live in-memory import queue
  },
  "memoryUsage": {
    "rss": <bytes>,
    "heapTotal": <bytes>,
    "heapUsed": <bytes>,
    "external": <bytes>,
    "arrayBuffers": <bytes>
  }
}
```

Implementations without a JS heap MAY zero-fill the V8-specific fields
(`heapTotal`, `heapUsed`, `external`, `arrayBuffers`) but MUST emit them so
the response shape is stable. `rss` MUST reflect the process resident set
size when the host OS exposes it (e.g. `/proc/self/status` on Linux).

### 3.11 Result types

```jsonc
ImportBatchResult   = { queued, processed, rejected, total: <int> }
ImportEventsResult  = { added, merged, rejected: <int> }
ProcessEventsResult = { busy: true }
                    | { added, merged, rejected, pending: <int>, pendingBatches?: string[] }
VerifyDbResult      = { total, verified, expired, invalid: <int> }
BlockInfo           = { height: <int>, hash: <string>, time: <unix-seconds> }
BatchMetadata       = { registry, time, ordinal: number[], registration?: DidRegistration }
```

In `ImportBatchResult`, `queued`, `processed`, and `rejected` count only the
submitted batch; `total` is the **global inbound event queue size** after import.
In `ProcessEventsResult`, `added`, `merged`, and `rejected` count work across the
whole queue drained by that call, and `pending` is the **global inbound event
queue size** afterward. Neither `total` nor `pending` counts only the caller's
batch. Use `pendingBatches` to identify batches with deferred events (see
[§8.2](#82-processevents-multi-pass)).

---

## 4. DID generation algorithm

A DID is derived deterministically from the create `Operation`:

```
canonical = canonicalize(operation)         // RFC 8785 / JCS-equivalent (see §4.1)
digest    = sha256(canonical)               // 32 bytes
mh        = multihash(0x12, 0x20, digest)    // sha2-256, 32-byte length
cid       = CIDv1(codec=0x0200, multihash=mh) // 0x0200 = json multicodec
did       = "<prefix>:" + base32(cid)        // base32 = RFC 4648 lowercase, no padding
```

`prefix` is `operation.registration.prefix` if present, else
`ARCHON_GATEKEEPER_DID_PREFIX` (default `did:cid`).

Cross-language test vectors live in
[tests/gatekeeper/deterministic-vectors.json](../../../tests/gatekeeper/deterministic-vectors.json).
Every implementation MUST produce identical CIDs and DIDs for identical
inputs.

### 4.1 Canonical JSON

The TS implementation uses the [`canonicalize`](https://www.npmjs.com/package/canonicalize)
npm package, which implements RFC 8785 JSON Canonicalization Scheme (JCS):

- objects: keys sorted lexicographically by UTF-16 code units (matches
  JavaScript string ordering, equivalent to UTF-8 byte order for ASCII)
- arrays: order preserved
- strings: minimal JSON escaping per RFC 8785 §3.2.2
- numbers: ECMAScript `Number.prototype.toString` formatting
- no whitespace anywhere

The Rust implementation in
[rust/services/gatekeeper/src/proofs.rs](../../../rust/services/gatekeeper/src/proofs.rs)
uses [`serde_json_canonicalizer`](https://docs.rs/serde_json_canonicalizer/)
for RFC 8785 serialization, with `serde_json`'s `float_roundtrip` parser feature.
Both implementations use UTF-16 code-unit key ordering and binary64/ECMAScript
number formatting. Shared `canonicalization-vectors.json` fixtures cover byte
encoding, operation CIDs, signed genesis and successors, and both proof suites.

Operation CIDs hash the UTF-8 canonical bytes directly, including the complete
proof, using SHA-256 and JSON multicodec `0x0200`. The canonical string MUST NOT
be parsed and re-serialized by an ordinary JSON codec before hashing or storage:
JavaScript would reorder integer-index property names. TS requests canonical
encoding for operation blocks explicitly; generic JSON/IPFS uploads retain their
existing encoding behavior. Canonical input must contain well-formed Unicode
and finite numbers.

Previously generated TS numeric-key operation references remain supported through
the existing content-backed predecessor alias cache. Both ports derive that old
reference from the complete operation when retaining evidence, so a fresh node
can recover signed legacy predecessors without trusting a peer's claimed `opid`.
Signed fields are not rewritten. No legacy-genesis naming mode or old Rust
signature-serialization fallback is introduced; the production audit found no
such exposure. See [the #1180 audit and validation](../../plans/canonicalization-1180.md).

A new implementation MAY use any canonical-JSON library that matches the
fixture output. Recommended: a JCS-compliant library where one exists.

---

## 5. Cryptographic proof contract

Curve: **secp256k1**. Hash: **SHA-256**. Signature scheme: **ECDSA**, fixed
64-byte form `r || s`, big-endian.

### 5.1 Signing

The payload depends on the proof's `type`.

`EcdsaSecp256k1Signature2019` — the operation alone, so no member of the proof
is covered:

```
operation_without_proof = clone(operation); delete operation_without_proof.proof
canonical               = canonicalize(operation_without_proof)
msg_hash                = sha256(canonical)            // 32 bytes
signature               = ecdsa_sign(secp256k1, private_key, msg_hash)
proof.proofValue        = base64url(signature_64_bytes)
```

`archon-ecdsa-secp256k1-jcs-2026` — the proof configuration and the operation, which is
what puts `created` and `proofPurpose` inside the signature:

```
proof_config            = clone(proof); delete proof_config.proofValue
operation_without_proof = clone(operation); delete operation_without_proof.proof
digests                 = sha256(canonicalize(proof_config))
                        ‖ sha256(canonicalize(operation_without_proof))   // 64 bytes
msg_hash                = sha256(digests)              // 32 bytes
signature               = ecdsa_sign(secp256k1, private_key, msg_hash)
proof.proofValue        = base64url(signature_64_bytes)
```

The second hash has no counterpart in the Ed25519 credential suites: ECDSA signs
a 32-byte digest where Ed25519 takes the message itself.

The signer MUST sign the prehashed message (no extra hashing inside ECDSA).

### 5.2 Verifying

`Proof` validation steps (any failure -> reject):

1. `proof.type == "EcdsaSecp256k1Signature2019"`, or
   `proof.type == "DataIntegrityProof"` with
   `proof.cryptosuite == "archon-ecdsa-secp256k1-jcs-2026"`
2. `proof.created` parses as RFC 3339 — see
   [§5.6](#56-timestamp-grammar)
3. `proof.proofPurpose ∈ { "capabilityInvocation", "authentication", "assertionMethod" }`.
   An operation exercises control over a DID document, which is what
   `capabilityInvocation` names and what a node emits — so a generated agent
   document lists `#key-1` under that relationship as well, since a purpose the
   document does not grant is a safeguard nothing can check. The other two MUST
   stay accepted: they were accepted before, so an operation carrying either may
   already be anchored, and every node replays its own history
4. `proof.verificationMethod` contains `#`. Split on first `#`; the prefix
   MUST be empty (relative) or a valid DID
5. `proof.proofValue` is a non-empty string

Then signature verification:

1. Compute `msg_hash` as in [§5.1](#51-signing)
2. Decode `proofValue` as base64url -> 64-byte signature
3. Decode the signing public key (see [§5.3](#53-key-resolution-by-operation-type))
4. ECDSA-verify the prehash against the signature with that public key

The TypeScript Node service uses OpenSSL verification over the bytes before the
final SHA-256: canonical unsecured JSON for legacy proofs, or the concatenated
proof-configuration and document digests for the Archon suite. OpenSSL performs
that final hash once. This produces the same prehash as §5.1; passing the prehash
itself to this API would incorrectly hash twice. Compact scalar validation and
low-S rejection remain explicit, and public keys retain the existing compressed
point interpretation (x plus y parity). The Node implementation caches at most
1,024 parsed public keys, never signature results or authorization decisions.
Verification uses Node's worker pool so bounded replay concurrency can overlap
cryptographic work without blocking the JavaScript thread for each signature.

### 5.3 Key resolution by operation type

| Operation | verificationMethod | Key source |
| --- | --- | --- |
| `create` agent | MUST equal `#key-1` (relative, since the DID does not yet exist) | `operation.publicJwk` (self-signed) |
| `create` asset | `<controller>#key-N`. `controller` portion MUST equal `operation.controller` | resolve `controller` DID with `confirm: true, versionTime: proof.created`; use the verification method the proof names |
| `update` / `delete` on agent | `<did>#key-N` | resolve `operation.did`; use the verification method the proof names |
| `update` / `delete` on asset | `<controller>#key-N` | resolve the doc, follow `controller`, use the verification method the proof names in that document |

The key is selected by the DID URL in `proof.verificationMethod`, compared as a
URL so a relative `#key-1` matches an absolute `<did>#key-1` and the reverse. Any
method the document lists may be named; only an agent create is pinned to the
literal `#key-1`, since no document exists yet. An operation naming a method the
document does not list does **not** verify, and so does one against a document
whose `verificationMethod` is empty. Both are refusals rather than an
`Invalid operation`: the import state machine defers on the latter, so such an
operation would be retried forever instead of rejected. An **absent**
`verificationMethod` is the structural error and does defer, because it is what
a controller that has not been imported yet looks like.

Within each DID document, verification-method IDs MUST be unique after resolving
relative fragment IDs against that document's DID. For example, `#key-1` and
`<did>#key-1` denote the same method and cannot both be listed, even with the
same public key. This applies to agent and asset documents. Distinct method names
may share a key, and a later document version may replace the key under an existing
name. Direct submission, import, and verified replay reject replacements that
violate this rule; signed operation bytes are never rewritten.

### 5.4 Operation size limit

`JSON.stringify(operation).length <= 64 * 1024` (character count, not byte
count, so non-ASCII content may diverge between implementations). Operations
exceeding this MUST be rejected (HTTP 500 from create/update; counted as
`rejected` in `importBatch`). Implementations SHOULD avoid full JSON
serialization for the size check (e.g. counting writer with early abort).

### 5.5 JWK encoding

`publicJwk` carries the X and Y coordinates as 32-byte unsigned big-endian
base64url-encoded values. Implementations MUST reconstruct the SEC1
compressed form (33 bytes: `0x02 | x` if Y is even, `0x03 | x` if odd) for
secp256k1 verifying-key deserialization.

Test vectors: [tests/gatekeeper/proof-vectors.json](../../../tests/gatekeeper/proof-vectors.json)
covers valid agent/asset create + update + delete, plus several invalid
shapes that MUST be rejected.

---

### 5.6 Timestamp grammar

Every timestamp a node validates — `proof.created`, `operation.created`,
`registration.validUntil`, and an event's `time` — is RFC 3339, and both ports
MUST accept exactly the same set of strings. A node that accepts a timestamp its
peers reject admits an operation they refuse, and the two then hold different
histories for the same DID.

`tests/gatekeeper/timestamp-vectors.json` is the authority, and both ports run
it as a test. RFC 3339 and `xsd:dateTimeStamp` differ at the corners, so the
vectors settle what neither reference settles alone. The accepted corners are a
space separator in place of `T`, a lowercase `t` or `z`, a leap second at
`:60`, and an unbounded fraction. Rejected are a missing offset, a bare date, a
signed or expanded year, surrounding whitespace, and any calendar-invalid date.

### 5.7 Field presence

A field is present when it is a string, not when it is truthy. The two differ on
the empty string, and a port that treats `""` as absent skips a check its peer
applies — admitting an operation the other refuses, which leaves the two holding
different histories for the same DID. `registration.validUntil`, a create
operation's `created` and `proof.proofValue` have each diverged this way.

An event's `registry` is validated as a name, not merely tested for presence.

`tests/gatekeeper/event-shape-vectors.json` pins the verdict both ports MUST
reach for each mutation of a valid event, and both run it as a test.

## 6. DID resolution algorithm

```
events := store.get_events(did)
if events.is_empty():
    return { didResolutionMetadata: { error: "notFound" }, didDocument: {}, didDocumentMetadata: {} }
if !is_valid_did(did):
    return { didResolutionMetadata: { error: "invalidDid" }, didDocument: {}, didDocumentMetadata: {} }

anchor   := events[0]
doc      := generate_initial_doc(anchor)            // §6.1
versionN := 1
confirmed := true                                   // create is always confirmed by definition

for event in events[1:]:
    resolutionTime := event.time
    if options.versionTime and resolutionTime > options.versionTime: break
    if options.versionSequence and versionN == options.versionSequence: break

    confirmed := confirmed && (event.registry == doc.registration.registry)
    if options.confirm and !confirmed: break

    if options.verify:
        verify_proof_against_current_doc(event.operation, doc)   // throws on failure
        if event.operation.previd != doc.metadata.versionId:
            throw "Invalid operation: previd"

    apply(event, doc, &mut versionN)                  // §6.2

doc.didResolutionMetadata := { retrieved: now() }
return doc
```

### 6.1 Initial document for create

For agent:

```jsonc
"didDocument": {
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "<did>",
  "verificationMethod": [{
    "id": "#key-1",
    "controller": "<did>",
    "type": "EcdsaSecp256k1VerificationKey2019",
    "publicKeyJwk": <operation.publicJwk>
  }],
  "authentication": ["#key-1"],
  "assertionMethod": ["#key-1"]
}
```

For asset:

```jsonc
"didDocument": {
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "<did>",
  "controller": "<operation.controller>"
}
"didDocumentData": <operation.data>
```

`didDocumentRegistration` starts as `operation.registration`. If
`operation.registration.prefix` is set, `didDocumentMetadata.canonicalId` is
set to the DID; otherwise it is omitted.

### 6.2 Apply each subsequent event

| `event.operation.type` | Effect |
| --- | --- |
| `update` | `versionN++`; `versionId := cid(event.operation)`; `updated := resolutionTime`; merge `event.operation.doc.didDocument`, `didDocumentData`, `didDocumentRegistration` into the running doc (any field present in `event.operation.doc` replaces the corresponding field on the running doc); `deactivated := false`. |
| `delete` | `versionN++`; `versionId := ...`; `deleted := resolutionTime`; remove `updated` (including any earlier update timestamp); `didDocument := { id: did }`; `didDocumentData := {}`; `deactivated := true`. |
| anything else | ignored |

The resolver uses stored `event.time`, comparing instants at JavaScript
millisecond precision (including offsets). The Hyperswarm mediator sets this
field to the operation's `proof.created`. Gatekeeper normalizes Hyperswarm and pin
envelopes on import and during candidate recovery, covering older mediators,
HTTP history imports, and existing databases. It corrects envelope timestamps
without changing operation bytes, IDs, or ordinals. Both ordinary and verified
resolution consume these corrected events. Gatekeeper also normalizes local
creation receipts to `operation.created` and local update/deletion receipts to
`proof.created`, including stored-candidate recovery. Anchored receipts keep their
authoritative chain times; chain ordinals retain precedence for same-registry
anchored authorization.

`previd` establishes predecessor order. The time cutoff selects a prefix, even
when proof times decrease; it does not reorder history. This applies to both
legacy and modern proofs without imposing a new timestamp-signing requirement.
It removes dependence on Hyperswarm receipt clocks, not competing-branch or
missing-evidence differences. Genesis creation-time behavior is unchanged.

### 6.3 Block timestamps

If `doc.didDocumentRegistration.registry` has a non-empty value and the
event has either `operation.blockid` (lower bound) or `event.registration`
with a `height` (upper bound), look up the matching block(s) via
`store.get_block(registry, ...)` and emit:

```jsonc
"timestamp": {
  "chain": "<registry>",
  "opid": "<versionId>",
  "lowerBound": {
    "time": <unix-seconds>,
    "timeISO": "<RFC 3339>",
    "blockid": "<hash>",
    "height": <int>
  },
  "upperBound": {
    "time": <unix-seconds>,
    "timeISO": "<RFC 3339>",
    "blockid": "<hash>",
    "height": <int>,
    "txid": "<hex>",
    "txidx": <int>,
    "batchid": "<CID>",
    "opidx": <int>
  }
}
```

Each bound is omitted when unknown. CID batch import derives `registration.opidx`
from the operation’s zero-based position in the supplied CID list, overriding any
batch-level value. It appears in `upperBound` when the anchoring block is known.

### 6.4 Final clean-up

Before returning, implementations MUST:

- delete deprecated fields if present: `didDocumentRegistration.opid`,
  `didDocumentRegistration.registration`
- omit `didDocumentMetadata.deactivated` unless `true`
- omit `didDocumentMetadata.updated` unless an update occurred and the resolved version is not deleted
- omit `didDocumentMetadata.deleted` unless a delete occurred
- omit `didDocumentMetadata.canonicalId` unless set
- always emit `didDocumentMetadata.versionId`, `versionSequence` (string),
  `confirmed`, `created`

### 6.5 Conformant resolution result

The `/1.0/identifiers` surface ([§2.6](#26-conformant-did-resolution-surface))
reshapes the resolver output at the HTTP boundary; the resolution algorithm
itself is unchanged (it always runs with `confirm: true, verify: true` for
this surface). The conformant result contains only the three members defined
by the DID Resolution data model:

```jsonc
{
  "didDocument": { /* ... */ },
  "didResolutionMetadata": { "contentType": "application/did+ld+json" },
  "didDocumentMetadata": {
    "created": "<RFC 3339>",
    "versionId": "<CID>",
    "versionSequence": "1"
    // ...plus updated / deleted / deactivated / canonicalId when applicable
  }
}
```

`Accept: application/did+json` and `Accept: application/did+ld+json` are
honored for successful resolution responses, and are the default. Because both
describe a DID *document* while this endpoint returns the resolution triple, a
client may instead ask for `Accept: application/did-resolution` to have the
result labelled for what it is; `didResolutionMetadata.contentType` continues to
report the document representation either way, since it describes what is inside
the envelope.

An `Accept` header naming only media types this endpoint cannot produce is
answered `406` with `didResolutionMetadata.error` set to
`representationNotSupported`.

Volatile fields such as `didResolutionMetadata.retrieved` are omitted from this
surface so generated W3C DID test-suite fixtures remain stable.

`didDocumentData` and `didDocumentRegistration` (present inline in the
internal [`DidCidDocument`](#37-didciddocument-resolution-result)) MUST be
omitted here and instead exposed via the `/data` and `/registration`
dereference resources. Standard document metadata (`created`, `updated`,
`versionId`, `versionSequence`, `deactivated`, `canonicalId`) remains in
`didDocumentMetadata`. Method-specific anchoring provenance (`confirmed` and
`timestamp`) is omitted here and exposed by `/registration`.

---

## 7. DID create / update / delete validation

The normative version-1 [transition table](../../scheme.md#transition-table)
connects these submission rules to imports and verified replay. Supplied document
components replace whole components; omitted components carry forward. The
[version and retention rules](../../scheme.md#version-validity-and-local-retention)
distinguish local GC from signed deletion and identify paused policy changes.

### 7.1 `create`

1. Reject if compact JSON serialization exceeds 65,536 UTF-16 code units (the version-1 limit, not UTF-8 bytes).
2. Reject if `type != "create"`, `created` is malformed, `registration` is
   missing or any of `version`, `type`, `registry` is invalid, or `proof`
   format checks fail.
3. Agent: `proof.verificationMethod == "#key-1"` and `publicJwk` is present.
   Reject an explicit `operation.controller`; the agent controls itself.
   Verify signature against `publicJwk`.
4. Asset: `proof.verificationMethod` names a key in the controller document, such as `<controller>#key-1`,
   `operation.controller == controller`. Resolve the controller with
   `confirm: true, versionTime: proof.created`. The controller must be an
   active, self-controlled agent, identified by its immutable creation type.
   Reject if the controller's
   `registration.registry == "local"` and the new operation's registry is
   non-`local`. Verify against the named controller verification method's `publicKeyJwk`, not necessarily the first key.
5. Reject if `registration.registry` is not in the server's
   `supportedRegistries`.
6. Append the event with `registry: "local"`, `ordinal: [0]`, `time:
   operation.created`, `opid: cid(operation)`.
7. If the registry is non-`local`, queue the operation for outbound
   distribution (see [§10.4](#104-outbound-queue)).

### 7.2 `update` / `delete`

1. Reject if compact JSON serialization exceeds 65,536 UTF-16 code units (the version-1 limit, not UTF-8 bytes).
2. Reject if `proof` format checks fail.
3. Resolve the target DID. Reject if the doc is `deactivated`. Validate `previd` against the current accepted head (including cached content-backed aliases) before any operation storage or queue write.
4. Agents use their own predecessor document. Assets resolve their owner
   at the authorization cutoff; that owner must be an active, self-controlled
   agent. There is no recursive traversal through assets or externally controlled agents.
   Reject duplicate normalized verification-method IDs in the resulting document (see §5.3).
   Validate the resulting document: agents may omit `controller` or name themselves;
   assets must retain an agent owner, including on transfer. The previous owner
   authorizes a transfer. Use the immutable creation type to classify the DID, even when the registration component is omitted. A supplied registration replaces the whole component and must retain genesis version, type, and prefix while providing a valid registry.
5. Verify signature against the resolved key.
6. Reject if `doc.didDocumentRegistration.registry` is not in
   `supportedRegistries`.
7. For `update`: reject if `operation.doc.didDocumentRegistration.registry`
   exists and refers to an unsupported registry.
8. Append with `registry: "local"`, `ordinal: [0]`, `time: proof.created`.
9. Queue on the predecessor registry if it is non-`local`. A migration is confirmed there; its successors use the new registry.

Concurrency: per-DID operations MUST be serialized. The implementation
MUST guarantee that two concurrent `POST /did` calls for the same DID see
each other's effects when computing `previd`.

---

## 8. Event import state machine

Used by `/dids/import`, `/batch/import`, `/batch/import/cids`, and
`/events/process`.

Historical controller selection uses chain context only when an event has
complete, position-consistent registration metadata and belongs to a chain registry. Local, Hyperswarm and pin
receipts always select the controller at the operation's `proof.created`, even
if their envelopes include registration metadata or ordinals. Those fields stay
in retained evidence but do not confer chain authority. Startup reconstruction
uses the same rule and reauthorizes previously accepted dependent assets.

Chain receipts require complete, position-consistent registration metadata; see
[the chain receipt contract](../../scheme.md#complete-chain-receipts). Validation
runs before queue deduplication and in per-event replay. Metadata-free copies
are rejected rather than preferred or replaced according to arrival history.

### Shared accepted-history interpretation

The per-port `history-view` module walks accepted events in predecessor order.
Each entry exposes the predecessor registry and whether the event extends the
confirmed prefix. Genesis is publicly confirmed even when its receipt registry
is different; chain anchoring still requires a matching chain receipt. A registry
replacement takes effect only after its operation, so the old registry confirms
a migration and the new registry confirms its successors.

Resolution consumes this walk up to its existing version/time/ordinal cutoff.
Controller anchoring separately consumes the **whole confirmed prefix**; a
cutoff-selected document is not a substitute for that evidence scan. Same-chain
ordinal precedence, other-chain block time, proof-time fallback, verification,
and timestamp-bound lookup remain at their existing resolution/authorization
boundaries. The first excluded predecessor ends historical selection.

Component transitions replace each supplied component in full and carry omitted
components forward. Deletion clears document/data, retains registration, and
omits `updated`. Rust's ordinary and verified resolvers share the same transition
function. The helpers add no storage, cache, database reads, or lock boundaries.

### Envelope policy shared by import and recovery

TypeScript `event-policy.ts` and Rust `event_policy.rs` define the existing
registry, clock, relay, and candidate-retention rules in one place per port.
These helpers do not select a signing authority or rewrite signed operations.

| Registry | Normalized envelope time | Durable candidate key | Same-key candidate copy | Public relay |
| --- | --- | --- | --- | --- |
| `local` | creation `operation.created`; update/delete `proof.created` | canonical opid, registry | first | preserve envelope |
| `hyperswarm` | `proof.created` | canonical opid, registry | first | preserve envelope |
| `pin` | `proof.created` | canonical opid, registry, normalized time, ordinal | last | Hyperswarm hint; strip registration |
| Any well-formed chain registry | authoritative receipt time | canonical opid, registry, ordinal | last | Hyperswarm hint; strip registration |

Chain admission still requires complete metadata consistent with the ordinal
(§8.1). The table describes candidate retention, not accepted-history replacement:
same-operation confirmation and earlier-anchor authorization remain in the importer.
Pin remains both an optional DID registry and the auxiliary outbound queue; sharing
unanchored clocks does not give it local/Hyperswarm transport or retention behavior.

Batch queue deduplication deliberately uses a different key: registry and
canonical operation CID, plus the incoming time/ordinal when registration metadata
is present. It runs before envelope-time normalization. Durable candidate keys run
after normalization, so restamped gossip can enter the batch queue without forcing
another replay of unchanged evidence. Pending-batch attribution and exported event
records remain separate from these keys. Canonicalization and content-backed
predecessor alias storage remain in the existing import/recovery paths.

### 8.1 `importBatch(events)`

```
for event in events:
    if !verify_event_shape(event) or !valid_event_target(event) or !valid_chain_metadata(event): // §8.5
        rejected += 1; continue

    key := event.registry + "/" + canonicalOperationCID(event.operation)
    if event.registration: key += "/" + JSON([event.time, event.ordinal])
    if seen[key]:
        processed += 1; continue
    seen[key] = true

    import_queue.push(event)
    queued += 1

return { queued, processed, rejected, total: import_queue.length }
```

The `seen` set is in-process and ephemeral. It MAY be lost on restart.

### 8.2 `processEvents()`

```
if isProcessing: return { busy: true }
isProcessing = true
loop:
    result := importEvents()       // single drain pass
    added += result.added; merged += result.merged; rejected += result.rejected
    if result.added == 0 and result.merged == 0: break
isProcessing = false
return { added, merged, rejected, pending: import_queue.length }
```

When `pending > 0`, the response also includes `pendingBatches`: sorted,
distinct `registration.batch` DIDs from the same queue snapshot. An empty list
means only events without batch registration remain. This lets mediators finish
unrelated batches while retaining retries for their own deferred events, including
candidate persistence failures. Older servers may omit this field; consumers must
then fall back to the global count. Batch DIDs are conservative identifiers: if
multiple anchors reference the same batch, any pending anchor keeps that batch
retryable. The busy response provides no completion evidence.

### 8.3 `importEvents()` (single pass)

Drains the queue once. For each event, runs `importEvent` and accumulates
counters. Events returning `DEFERRED` are pushed back onto the queue (to be
attempted on the next pass). If a processing step throws, the failed event,
the unvisited remainder of the pass, and any already deferred or newly queued
events are preserved. TypeScript propagates the error to the caller and releases
the processing flag; it does not return a successful zero-pending result. The
mediator keeps that batch retryable, and a later pass can resume after storage
recovers even if repeated imports are suppressed by the in-memory seen set.

### 8.4 `importEvent(event)` per-event flow

Imports validate the operation-derived target before queue deduplication and candidate persistence, then run the insertion algorithm below and replay the affected DID and its transitive dependents. Imports and direct submissions serialize history mutations. Replay uses a separate working view and invokes the same insertion/authorization algorithm; it never trusts a previous authorization verdict merely because it was once accepted.

The per-event replay importer applies the same envelope target check. This rule
adds no storage migration or candidate-journal cleanup.

Local/gossip candidates retain the first observation of each canonical operation per registry; fresh peer receipt timestamps and ordinals do not add authorization evidence. Anchored candidates retain their distinct chain positions. After startup recovery, a merged import that changes neither retained candidates nor accepted history skips reconciliation and leaves status and verification caches intact. New evidence and changed anchors still reconcile normally.

Canonical predecessor IDs that already match an accepted event are resolved
directly from that history. Cached operation content is consulted only for an
unmatched reference that may be a retrieval-CID alias. Startup recovery still
revalidates operation signatures and authorization against reconstructed history.
TypeScript's isolated replay copies event rows while sharing read-only operation
payloads and memoizing their canonical IDs for that replay only. Resolution
detaches its result before removing deprecated fields, preserving signed bytes.
Independent agent histories replay in bounded groups of 32; the agent phase
finishes before the asset phase. Histories with mixed-type or misaddressed
retained evidence remain at their original sequential positions instead of
joining parallel groups. Assets then replay in bounded groups,
preserving each DID's internal candidate order and publishing
only after reconstruction completes. This relies on self-controlled agents
and agent-only asset controllers, which are enforced during authorization.
Search-index initialization uses bounded groups of 32 concurrent reads, with
each group protected against partial history publication.
Ordinary resolution computes the canonical CID and block timestamp bounds only
for the selected version. Verified resolution still checks every included
operation and its predecessor; both return the same version metadata.

The dependency index includes controller assignments on retained branches, not just the current document. Replay completes self-controlled agent histories before asset histories, retrying candidates within each DID until its sequence stops changing and ordering chain candidates by registry, ordinal, time, and operation CID; registry ordinals are never compared across chains. Local/gossip candidates keep their existing traversal order for efficient processing of predecessor chains. The shared importer chooses competing unanchored siblings by canonical CID during both live import and replay; traversal order does not decide the winner. Agents must remain self-controlled and asset owners must be agents. These constraints are checked during creation, direct updates, import, and verified replay, including the new owner of a transfer. Startup repair removes previously accepted violations from the accepted projection while retaining candidate evidence. Replay has no separate oscillation detection or quarantine policy.

Accepted histories, search entries, and verification caches are refreshed when replay changes a DID. Search indexing runs on published histories, not intermediate replay views. Explicit removal and garbage collection also replay dependents before returning. Startup rebuilds each DID once from the journal to recover interrupted publication, rather than replaying a controller’s dependents again for each entry in the startup scan. Startup reads accepted histories in bounded batches and reuses that snapshot during reconstruction. Both implementations build the complete startup search index and status counts together from the accepted in-memory replay snapshot, after durable publication and before releasing the history lock. TypeScript publishes startup histories in bounded groups, waiting for all started writes before propagating any failure or releasing the lock. Startup excludes rejected candidate-only histories from those views and avoids separate Redis search-refresh, status, and full-index scans. Runtime reconciliation still refreshes affected search documents. Rust invalidates cached status; subsequent TypeScript status checks scan current histories. Already-canonical, unchanged journals are not rewritten; public verification, resolution, and DID-list reads wait for repair and hold the history lock throughout their asynchronous reads. TypeScript status scans resolve up to 32 DIDs concurrently under that lock, then release it and yield before the next chunk. Each chunk observes complete publication; aggregate status counts can span multiple completed publications and are monitoring data, not a transaction snapshot. An operation accepted through dependent replay may report `MERGED` when its next queue attempt runs, so processing counters describe queue attempts, not every change to derived histories.

Runtime replay avoids work when retained evidence and accepted state are unchanged,
including repeated deferred events. Deferred events remain pending;
arrival of their missing predecessor or controller history still triggers recovery.
A new hint for an accepted operation is retained and its own DID is rebuilt first;
if that projection stays unchanged, its dependents do not need reconstruction.
TypeScript compares stored histories canonically so Redis hydration changing object
key order cannot manufacture a history change. Known canonical content is not
rewritten to IPFS merely because a gossip wrapper omitted its operation ID.

The following is the insertion algorithm reused during replay:

```
1. derive target from canonical creation CID/prefix, or signed update/delete operation.did
   reject a supplied event.did that differs; fill an omitted event.did with the target
   normalize canonical event.opid and unanchored event.time from the operation
   select the preferred retained same-position chain receipt before authorization
2. acquire per-DID lock
3. current = store.get_events(did); derive any missing canonical operation IDs
4. if any current event has opid == event.opid:
       expectedRegistry = expected_registry_for_index(current, index_of_match)
       earlierAnchor = expectedRegistry is a chain registry and event.registry == expectedRegistry
           and both ordinals exist and compare_ordinals(event.ordinal, current[match].ordinal) < 0
       if current[match].registry == expectedRegistry and not earlierAnchor: return MERGED
       if event.registry == expectedRegistry:
           previous = selected predecessor document, or none for creation
           authorize_operation(event.operation, previous, event)
           // same failure handling as step 7; do not replace an unauthorized anchor
           replace current[match] := event; setEvents(did, current); return ADDED
       else: return MERGED
5. if current is non-empty and event.operation.previd is missing: return REJECTED
6. find prev by canonical operation ID, accepting a cached content-backed previd alias
   if current is non-empty and no prev: return DEFERRED
   previous = resolve through prev, or none when current is empty
7. valid = authorize_operation(event.operation, previous, event)   // §5.2 + §7
   if Err("Invalid operation"-class): return DEFERRED   (evidence may be unavailable)
   if !valid: return REJECTED
   other errors: return REJECTED
8. if current is empty: addEvent(did, event); return ADDED
9. let i = index_of(prev)
   if i == current.length - 1:
       addEvent(did, event); return ADDED
   expectedRegistry = expected_registry_for_index(current, i + 1)
   next = current[i+1]
   if compare_successors(expectedRegistry, event, next) < 0:
       setEvents(did, current[..=i] + [event]) // replace the displaced branch
       return ADDED
10. return REJECTED
```

`expected_registry_for_index(events, i)` walks forward from index 0,
starting from `events[0].operation.registration.registry`, switching to
`event.operation.doc.didDocumentRegistration.registry` whenever an `update`
re-registers it.

For repeated anchors of one canonical operation on its expected chain, an earlier
ordinal replaces a later accepted anchor only after authorization at that earlier
position succeeds. A descendant's early anchor may initially defer because its
predecessor is unavailable, while a later copy becomes applicable during the same
replay pass. Subsequent passes must still reconsider the earlier anchor; retaining
the first applicable copy can change controller cutoffs and dependent asset
acceptance according to gossip arrival order. Distinct candidates remain retained.
Equal ordinals do not replace an already-confirmed copy under this
rule; local, Hyperswarm, and pin representations keep first-observation behavior.

The pure successor comparator receives already-authorized siblings and the
predecessor's expected registry. An expected-chain receipt sorts before provisional
evidence; two expected-chain receipts compare lexicographic ordinal, then canonical
CID; two provisional receipts compare canonical CID alone. Local, Hyperswarm, pin,
and wrong-chain receipts remain provisional. A negative result prefers the incoming
event. Both live import and replay use this same comparison after authorization.
It does not handle repeated observations of one operation or sort replay traversal.

For distinct competing operations confirmed on the expected chain, present equal
ordinals are broken by canonical operation CID (ASCII order). This is required
because chain producers can assign equal positions to different operations;
first-applicable selection can otherwise depend on hint arrival order and persist
across reconstruction. Earlier ordinals still take precedence. Chain receipts
without a nonempty ordinal are invalid; repeated positioned anchors of the same
operation follow the earlier-anchor rule above.

The [unanchored successor rule](../../scheme.md#competing-unanchored-successors)
is a sibling preference, not a timestamp cutoff or a replacement for chain
ordering. Reconciliation publishes the recovered branch and revalidates its
dependents; retaining a losing candidate does not make its receipt order authoritative.

Controller anchoring eligibility is derived only from the confirmed prefix.
Walk predecessor registry changes from genesis; stop at the first successor whose
receipt registry does not match. Matching chain receipts establish anchoring
only when all such receipts carry complete, position-consistent registration metadata. A wrong-registry genesis
receipt is ignored for this test even though genesis itself is admitted. Pin
receipts are followed as expected-registry confirmations but never count as chain
receipts, so missing pin registration metadata does not disqualify a later chain
migration. Receipt
choices in the unconfirmed suffix cannot enable or disable chain-based controller
cutoffs. The signed [cutoff audit](../../plans/agent-convergence-cutoff.md) covers
this distinction through import, repeat delivery, and restart in both ports.

### 8.5 Event shape validation

```
event.registry is a valid registry name (`[A-Za-z0-9][A-Za-z0-9:_-]*`, max 128 chars)
event.time parses as RFC 3339
event.operation present; compact JSON.stringify-style serialization <= 65,536 UTF-16 code units
    // version-1 size rule, not canonical UTF-8 byte length
proof format valid (§5.2)
operation.type ∈ { create, update, delete }
  - create: created, registration.{version=1, type, registry}, type-specific fields
  - update: did, doc with at least one of { didDocument, didDocumentData, didDocumentRegistration };
            if doc.didDocument.id is set it MUST equal operation.did
  - delete: did
target := create ? applicableMethodPrefix + ":" + canonicalOperationCID(operation) : operation.did
if event.did is supplied it MUST equal target
chain events require complete registration matching ordinal (see scheme chain receipt contract)
    // creation.operation.did and peer-supplied event.opid cannot override creation identity
```

### 8.6 Ordinal comparison

`compare_ordinals(a, b)` is element-wise lexicographic over `Vec<u64>`:
shorter is "less than" prefix-equal longer (matches the TS behavior).
`None` ordinals compare as equal to anything.

### 8.7 Batch export eligibility

`POST /api/v1/batch/export` is the outbound counterpart of import: it
selects which DIDs are eligible to be gossiped to peers (the Hyperswarm
mediator's `shareDb` is the primary caller). `POST /api/v1/dids/export`
performs no such filtering and returns every requested DID.

Eligibility is decided **per DID, not per event**:

> A DID is exportable if **any** of its operations carries a non-`local`
> registry.

Read the registry from whichever field the operation shape provides:

| Operation | Registry field |
| --- | --- |
| `create` | `operation.registration.registry` |
| `update` | `operation.doc.didDocumentRegistration.registry` |

A missing or empty registry MUST NOT qualify a DID for export.

Checking only the create operation is **insufficient**. A DID created
`local` and later promoted (via `change-registry`, an `update` that
rewrites `didDocumentRegistration.registry`) still has a `local` create
op, so a create-only test excludes the DID entirely and the promotion
never reaches peers — the origin reports it as confirmed on the new
registry while every other node returns `notFound`.

An eligible DID MUST export its **full** operation history, including any
`local` operations. Peers need the create op to replay the DID from its
first version; exporting only the non-`local` operations leaves them
unable to reconstruct it. This does not re-publish the `local` operation,
because outbound queueing ([§10.4](#104-outbound-queue)) early-returns on
`local` — only the promoting update drives further distribution.

The response is a single flat `GatekeeperEvent[]`, sorted ascending by
`operation.proof.created`.

---

## 9. Search and structured query

The Gatekeeper maintains an in-memory **search index** keyed by DID,
storing only `didDocumentData` (the user-controlled portion). The index is
rebuilt at startup from `getDIDs()` and updated incrementally on every
create/update/delete and on the result of `importEvent`. Implementations MUST
preserve insertion order for deterministic test results.

### 9.1 `GET /api/v1/search?q=...`

Returns DIDs whose `JSON.stringify(didDocumentData).includes(q)` is true.
Empty `q` returns `[]`.

### 9.2 `POST /api/v1/query` body

```jsonc
{ "where": { "<path>": { "$in": [<value>, ...] } } }
```

Only the first key of `where` is used. Only `$in` is supported (other
operators MAY be added in future revisions).

Path syntax:

| Form | Meaning |
| --- | --- |
| `a.b.c` | dotted path; numeric segments index arrays |
| `$.a.b` or `$a.b` | leading `$` is stripped |
| `a.b[*]` | match any array element of `didDocumentData.a.b` |
| `a.b[*].c` | match `c` on any array element of `didDocumentData.a.b` |
| `a.*` | any value of the keyed object `didDocumentData.a` |
| `a.*.b` | `b` on any value of the keyed object `didDocumentData.a` |

A document matches if any candidate value extracted via the path is `==`
(JSON deep equality) to any element of the `$in` list.

Errors:

- `where` missing or non-object -> HTTP 400 `{"error":"`where` must be an object"}`
- `cond.$in` missing or non-array -> HTTP 500 `{"error":"<implementation-specific>"}`

---

## 10. Storage contract

The Gatekeeper stores seven logical resources:

| Resource | Purpose |
| --- | --- |
| `dids` | per-DID accepted `EventRecord[]`, replaced when replay changes authorization |
| `candidates` | persistent event evidence, including rejected operations and replaced branches, keyed by DID |
| `ops` | content-addressed `opid -> Operation` cache (so events can be stored by reference) |
| `queue` | per-registry outbound `Operation[]` awaiting distribution |
| `blocks` | per-registry index of `BlockInfo` (by hash and by height) |
| `import_queue` | in-memory queue of events received from peers (NOT persisted) |
| `events_seen` | in-memory dedupe set for `importBatch` (NOT persisted) |

Reference implementations support **JSON file**, **SQLite**, **Redis**, and
**MongoDB**. Implementations are free to add others. Selector:
`ARCHON_GATEKEEPER_DB ∈ { json, json-cache, sqlite, redis, mongodb }`.

### 10.1 DID suffix keying

The persistent key for a DID is the substring after the last `:`.
Implementations MUST tolerate any prefix (e.g. `did:cid:foo`,
`did:other:foo` both key as `foo`). This is required for cross-prefix
canonical-id behavior.

### 10.2 Event storage

For backends other than the in-memory JSON file, events SHOULD be stored
with `operation` stripped and `opid` set, with the operation body stored
separately in the `ops` table keyed by `opid`. On read the event is
"hydrated" by joining the operation back in. This both saves space (when a
DID's chain has many small wrapper events around large ops) and supports
content-addressed import via `/batch/import/cids`.

Candidate journals store full events (including operations and original registration metadata). JSON uses a `candidates` map; SQLite and MongoDB use a `candidates` table/collection (`id`, `events`); Redis uses a `<namespace>/candidates` hash. Empty journal entries mark explicit removals or garbage collection so restart does not resurrect those histories. Database reset clears both accepted state and candidates. Existing stores without a journal adopt their available accepted histories; previously discarded evidence requires a chain rescan. DID exports still describe accepted state, not the journal.

Custom TypeScript `GatekeeperDb` adapters must implement `getCandidates()` and `setCandidates(did, events)` with durable storage. Rejected candidates can become valid later, so they must not be pruned merely because the current authorization verdict is negative.

### 10.3 Filesystem layout

| Backend | Path |
| --- | --- |
| `json` / `json-cache` | `data/archon.json` |
| `sqlite` | `data/archon.db` |

The `data` folder is hard-coded (relative to working directory) and
inside the container is mounted at `/app/gatekeeper/data`.

### 10.4 Outbound queue

When a non-`local` operation is committed, the implementation MUST:

1. enqueue it on the `hyperswarm` registry queue (always)
2. enqueue it on the originating `registry` (e.g. `BTC:signet`) **if it
   differs** from `hyperswarm`
3. if the per-registry queue length exceeds `maxQueueSize` (default 100),
   remove that registry from the in-memory `supportedRegistries` set so no
   new operations target it (operational pressure relief)

### 10.5 Redis key schema (reference)

For interoperability with the existing TypeScript service when sharing a
Redis instance, implementations using Redis MUST use this schema (namespace
is hard-coded to `archon`):

| Key | Type | Contents |
| --- | --- | --- |
| `<ns>/dids/<did-suffix>` | LIST | event JSON strings (operation field stripped, opid kept) |
| `<ns>/ops/<opid>` | STRING | operation JSON |
| `<ns>/registry/<registry>/queue` | LIST | operation JSON strings |
| `<ns>/registry/<registry>/blocks/<hash>` | STRING | block JSON |
| `<ns>/registry/<registry>/heightMap` | HASH | height (decimal string) -> hash |
| `<ns>/registry/<registry>/maxHeight` | STRING | decimal int |

`clearQueue` is implemented as a single Lua script that filters by
`obj.proof.proofValue` matching, to keep the operation atomic.

### 10.6 SQLite schema (reference)

```sql
CREATE TABLE dids       (id TEXT PRIMARY KEY, events TEXT);
CREATE TABLE queue      (id TEXT PRIMARY KEY, ops TEXT);
CREATE TABLE blocks     (registry TEXT, hash TEXT, height INTEGER NOT NULL,
                         time TEXT NOT NULL, txns INTEGER NOT NULL,
                         PRIMARY KEY (registry, hash));
CREATE UNIQUE INDEX idx_registry_height ON blocks (registry, height);
CREATE TABLE operations (opid TEXT PRIMARY KEY, operation TEXT NOT NULL);
```

`events` and `ops` are JSON strings.

### 10.7 MongoDB collection schema (reference)

| Collection | Indexes |
| --- | --- |
| `dids` | `{ id: 1 }` |
| `blocks` | `{ registry: 1, height: -1 }`, unique `{ registry: 1, hash: 1 }` |
| `operations` | unique `{ opid: 1 }` |
| `queue` | (none) |

Documents in `dids` are `{ id: <suffix>, events: [<encoded event>...] }`.

---

## 11. IPFS interaction contract

The Gatekeeper expects a Kubo-compatible HTTP API at `ARCHON_IPFS_URL`
(default `http://localhost:5001/api/v0`). It calls these endpoints:

| Action | Method | Path | Query | Body |
| --- | --- | --- | --- | --- |
| `addJSON` | `POST` | `/block/put` | `pin=true&cid-codec=json&mhtype=sha2-256` | multipart `file` part with the JSON bytes |
| `addText` | `POST` | `/add` | `pin=true&cid-version=1` | multipart `file` part with the text |
| `addData` | `POST` | `/add` | `pin=true&cid-version=1` | multipart `file` part with binary bytes |
| `addStream` | `POST` | `/add` | `pin=true&cid-version=1` | multipart `file` part fed from the streamed request body |
| `getJSON` | `POST` | `/block/get` | `arg=<cid>` | (none) |
| `getText` / `getData` / `getStream` | `POST` | `/cat` | `arg=<cid>` | (none) |

The CID returned by `/add` and `/block/put` is parsed out of the JSON
response (`Hash` / `Key` / `Cid./` field; Kubo's exact key has varied
across versions).

Wait policy at startup: implementations SHOULD wait for `/api/v0/version`
to respond before declaring readiness, polling every few seconds.

---

## 12. Maintenance loops

Two periodic background tasks run after startup; both are governed by
configurable intervals.

### 12.1 Status loop

Interval: `ARCHON_GATEKEEPER_STATUS_INTERVAL` minutes (default 1).
Runs `checkDIDs()` (the same code path as `GET /status`) and logs a status
block to stdout. This loop also refreshes the DID-count Prometheus gauges.

### 12.2 GC loop

Interval: `ARCHON_GATEKEEPER_GC_INTERVAL` minutes (default 60).
Runs `verifyDb()` followed by `checkDids()`, so this loop also refreshes the
DID-count Prometheus gauges:

```
total = 0; verified = 0; expired = 0; invalid = 0
for did in getAllKeys():
    if did in verifiedDIDs: continue            // memoized, never re-verifies
    try:
        doc = resolveDID(did, { verify: true })
    except:
        invalid++; deleteEvents(did); continue
    validUntil = doc.didDocumentRegistration.validUntil
    if validUntil and parseTime(validUntil) < now:
        expired++; deleteEvents(did); continue
    if validUntil:
        verified++       // counted but NOT memoized (might expire later)
    else:
        verified++; verifiedDIDs[did] = true     // memoize
import_queue.clear()
return { total, verified, expired, invalid }
```

`verifyDb` clears the import queue only after successful removal and dependent replay.
The `verified` count is seeded from the size of the memoized
`verifiedDIDs` set, so DIDs verified in prior runs are included in the count
even though they are skipped this pass.

Storage or replay failures propagate to the caller: `/db/verify` returns HTTP 500,
pending imports remain queued, and background GC logs the failure instead of a
successful result. Success-only cleanup and search-index rebuilding are skipped.

`verifyDb` also drives chatty per-DID logs at INFO level: `removing N/T DID
invalid`, `removing N/T DID expired`, `expiring N/T DID in M minutes`,
`verifying N/T DID OK`, plus a final `verifyDb: <ms>ms` timing line.

A value of `0` for either interval disables the loop.

---

## 13. Prometheus metrics contract

Exposed at `GET /metrics`. The Gatekeeper-specific metric names, types, and
label sets MUST be exactly:

| Metric | Type | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram (buckets: 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5) | `method`, `route`, `status` |
| `did_operations_total` | counter | `operation`, `registry`, `status` |
| `events_queue_size` | gauge | `registry` |
| `gatekeeper_dids_total` | gauge | (none) |
| `gatekeeper_dids_by_type` | gauge | `type` |
| `gatekeeper_dids_by_registry` | gauge | `registry` |
| `service_version_info` | gauge | `version`, `commit` |

Implementations SHOULD additionally emit standard Prometheus process metrics
(`process_resident_memory_bytes`, `process_start_time_seconds`,
`process_cpu_seconds_total`, etc.) to keep the existing Grafana dashboards
working.

### 13.1 Route normalization

The `route` label MUST collapse dynamic path segments to placeholder names
so cardinality stays bounded. Required normalizations:

```
/api/v1/did/did:...          -> /api/v1/did/:did
/api/v1/block/<r>/latest     -> /api/v1/block/:registry/latest
/api/v1/block/<r>/<id>       -> /api/v1/block/:registry/<id>
/api/v1/queue/<r>/clear      -> /api/v1/queue/:registry/clear
/api/v1/queue/<r>            -> /api/v1/queue/:registry
/api/v1/events/<x>           -> /api/v1/events/:registry
/api/v1/dids/<x>             -> /api/v1/dids/:prefix
/1.0/identifiers/did:...     -> /1.0/identifiers/:did   (the /data and /registration suffixes are preserved)
```

The label MUST retain each route's own prefix (`/api/v1` for the versioned
API, `/1.0/identifiers` for the conformant surface); only the dynamic DID /
registry segments are collapsed.

### 13.2 Counter semantics

- `did_operations_total` is incremented exactly once per `POST /api/v1/did`
  call, with `status: "success"` or `"error"`.
- `events_queue_size{registry}` is the **per-registry** count of events
  currently in the import queue (in-memory). Refreshed on the periodic
  status loop and on certain admin actions.
- `gatekeeper_dids_*` gauges reflect the most recent `checkDIDs()` snapshot.
  They are recomputed on the periodic status loop and on single-DID write
  paths (`POST /did`, `POST /dids/remove`). They are NOT recomputed on bulk
  paths (`importBatch`, `processEvents`) for performance reasons; consumers
  should expect these gauges to be eventually consistent.

---

## 14. Container and runtime contract

### 14.1 Image

- Container exposes port `4224` by default.
- Working directory contains `data/` mounted from the host
  (`-v ./data:/app/gatekeeper/data`).
- `GIT_COMMIT` build arg / env populates the Prometheus `service_version_info`
  `commit` label and the `/version` response. Truncated to 7 characters.

### 14.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_GATEKEEPER_PORT` | `4224` | HTTP listen port. |
| `ARCHON_BIND_ADDRESS` | `0.0.0.0` | HTTP bind address. |
| `ARCHON_GATEKEEPER_DB` | `redis` | Storage backend selector (`json`, `json-cache`, `sqlite`, `redis`, `mongodb`). |
| `ARCHON_IPFS_URL` | `http://localhost:5001/api/v0` | Kubo HTTP API base. |
| `ARCHON_REDIS_URL` | `redis://localhost:6379` | Redis URL when `db=redis`. |
| `ARCHON_MONGODB_URL` | `mongodb://localhost:27017` | MongoDB URL when `db=mongodb`. |
| `ARCHON_GATEKEEPER_DID_PREFIX` | `did:cid` | DID prefix for locally-generated DIDs. |
| `ARCHON_GATEKEEPER_REGISTRIES` | unset | Comma-separated allowlist; empty/unset means `local,hyperswarm`. |
| `ARCHON_GATEKEEPER_JSON_LIMIT` | `4mb` | JSON request-body size cap. |
| `ARCHON_GATEKEEPER_UPLOAD_LIMIT` | `10mb` | Raw/text body cap on `/ipfs/text` and `/ipfs/data`. |
| `ARCHON_GATEKEEPER_GC_INTERVAL` | `60` | GC loop interval in minutes (`0` disables). |
| `ARCHON_GATEKEEPER_STATUS_INTERVAL` | `1` | Status loop interval in minutes (`0` disables). |
| `ARCHON_ADMIN_API_KEY` | empty (**required**) | Admin API key. The service refuses to start without it; admin routes return 403 when unset. A warning is logged if it is shorter than 32 characters. Generate with `openssl rand -hex 32`. |
| `ARCHON_GATEKEEPER_FALLBACK_URL` | `https://dev.uniresolver.io` | Universal resolver to consult on local notFound. Empty disables. |
| `ARCHON_GATEKEEPER_FALLBACK_TIMEOUT` | `5000` | Fallback timeout in ms. |
| `ARCHON_GATEKEEPER_CONFIRM_FALLBACK_URL` | empty | Optional Gatekeeper peer for `confirm=true` requests with missing local history or a pending successor within the requested version/time bounds. Empty disables. |
| `GIT_COMMIT` | `unknown` | Build commit. |

### 14.3 Healthcheck

Container healthcheck SHOULD:

```
test "$(wget -qO- http://127.0.0.1:4224/api/v1/ready)" = "true"
```

`/api/v1/ready` MUST return JSON `false` until startup is complete (DB
loaded, search index initialized, background tasks scheduled, listener
bound) and `true` thereafter.

Compose gives both Gatekeeper implementations a `120s` startup grace period,
configurable with `ARCHON_GATEKEEPER_START_PERIOD` (for example `5m` for a larger
history). This is a Compose setting, not a Gatekeeper process environment variable.
The parity stack uses the same setting. A successful readiness probe marks the
container healthy immediately, including during the grace period; dependents do
not wait for the entire period. Startup probe failures do not count toward the
retry limit until the grace period ends. After the first success, normal failure
counting applies. Deployment probes retain their 10-second interval, 5-second
timeout, and six retries; the parity stack retains its twelve retries.

The grace period is not the total startup deadline: consecutive failed probes
can also consume the retry window. Increasing it delays detection of a startup
that never becomes ready; it does not fix slow replay. Continue comparing
populated-history startup benchmarks when changing recovery code.

Measure total startup from the container's `State.StartedAt` to its first
successful readiness probe, including DB/IPFS connection and all recovery phases.
Capture `docker compose ps` and `docker inspect --format '{{json .State}}'
"$(docker compose ps -q gatekeeper)"` as soon as readiness is reached; Docker only
retains recent health probe results. Use timestamped startup logs to locate slow
phases. The TypeScript `checkDIDs` line alone is not a total startup measurement:
initialization runs before the startup status report's timer.

To inspect startup progress, run `docker compose logs -f --timestamps gatekeeper`.
Both implementations announce candidate-journal loading, then report aggregate
DID counts and elapsed time for history loading, candidate preparation, replay,
publication, and the combined startup search/status view. For example:

```text
Gatekeeper history replay: 0/25647 DIDs (0.0s)
Gatekeeper history replay: 4200/25647 DIDs (5.0s)
Gatekeeper history replay: 25647/25647 DIDs (31.2s)
Gatekeeper startup search/status views: 0/25647 DIDs (0.0s)
```

Counts describe DIDs processed in the current phase, not valid DIDs or accepted
operations. Phase boundaries always log; intermediate updates are limited to
one every five seconds, emitted after a unit of work completes. They are not
heartbeats: an individual slow storage call or DID replay can delay an update.
The Rust bulk history read reports its start and completion. Routine imports
do not emit recovery progress; periodic database status scans report their own
progress. These logs do not change readiness or healthcheck timeouts.

### 14.4 Graceful shutdown

On `SIGTERM` or `SIGINT` the server SHOULD stop accepting new connections,
allow in-flight requests to drain, then exit. Persisted backends (SQLite,
Redis, MongoDB) SHOULD be closed cleanly where the language's driver
exposes that.

---

## 15. Logging conventions

- One line per HTTP request: `METHOD path?query status (Nms)` (matching
  morgan's "dev" format).
- 4xx and 5xx error responses with text bodies SHOULD also emit a
  `warn`/`error`-level log line containing the status and message.
- Unhandled `/api/*` 404s SHOULD emit a single `warn` line of the form
  `Warning: Unhandled (API) endpoint - METHOD path`.
- Periodic status block logged on the status loop, with sections for total
  DIDs, breakdown by type/registry/version, events queue length, and memory
  usage (matching the TS `reportStatus()` text shape).
- GC loop emits `DID garbage collection: {result-json} waiting N
  minutes...`.
- `processEvents` emits `processEvents: {result-json}` once per call.

Plain unstructured stdout is acceptable; container orchestrators add
timestamps and container labels.

---

## 16. Test fixtures

Nine shared JSON fixtures drive cross-language conformance:

| File | Purpose |
| --- | --- |
| [tests/gatekeeper/deterministic-vectors.json](../../../tests/gatekeeper/deterministic-vectors.json) | Canonical-JSON / CID / DID generation vectors. Every implementation MUST produce identical bytes/IDs. |
| [tests/gatekeeper/proof-vectors.json](../../../tests/gatekeeper/proof-vectors.json) | Valid + invalid proof shapes for `verifyProofFormat`, `verifyCreateOperation`, `verifyUpdateOperation`. |
| [tests/gatekeeper/api-parity-fixtures.json](../../../tests/gatekeeper/api-parity-fixtures.json) | Stateless HTTP request/response fixtures across most endpoints. |
| [tests/gatekeeper/api-parity-flows.json](../../../tests/gatekeeper/api-parity-flows.json) | Stateful flows (create + resolve + export + import + queue + block + IPFS round-trips). |
| [tests/gatekeeper/metrics-parity.json](../../../tests/gatekeeper/metrics-parity.json) | Required metric names + route normalization expectations. |
| [tests/gatekeeper/timestamp-vectors.json](../../../tests/gatekeeper/timestamp-vectors.json) | The RFC 3339 grammar every validated timestamp MUST satisfy — see [§5.6](#56-timestamp-grammar). |
| [tests/gatekeeper/controller-rules-vectors.json](../../../tests/gatekeeper/controller-rules-vectors.json) | Signed controller constraints and the former cross-registry oscillation reproducer, now rejected at controller assignment; direct/import/startup tests in both ports. |
| [tests/gatekeeper/history-recovery-vectors.json](../../../tests/gatekeeper/history-recovery-vectors.json) | Signed delayed-history cases shared by both ports and live parity: same/cross-registry, creation/update/deletion, rejected asset delegation, successors, and migration. |
| [tests/gatekeeper/event-shape-vectors.json](../../../tests/gatekeeper/event-shape-vectors.json) | Event shapes both ports MUST agree to accept or reject, mutation by mutation. |

The script [scripts/gatekeeper-parity.mjs](../../../scripts/gatekeeper-parity.mjs)
replays every fixture and flow against two running implementations and diffs
the responses per each entry's `compareMode`. It reads `TS_GATEKEEPER_URL` and
`RUST_GATEKEEPER_URL` (not `GATEKEEPER_URL_A`/`_B`) and exits non-zero on the
first divergence. New implementations SHOULD pass it against the TypeScript
reference before being considered drop-in.

Beyond the curated fixtures it also **structurally fuzzes** a valid operation:
it mutates every field — deleting it, setting it to `""`, `null`, a number, an
object, an array; re-encoding a `created` with offsets, a lowercase `z`, a bare
date — and asserts both ports agree on **accept vs reject** for each. Each
mutation is re-signed with a test key first, so a port that wrongly *accepts* a
malformed field returns 200 where the other rejects, rather than both failing a
stale signature and hiding the split. This catches the acceptance fork — one
port accepting what the other rejects — which is the class #1115 and #1118
belonged to, and which no single-port test can see.

`POST /did` collapses every rejection to HTTP 500, so this compares acceptance,
not the finer refuse-vs-`Invalid operation` error class; distinguishing those
needs a verdict surface the endpoint does not expose, and is a follow-on
(#1140). Determinism under out-of-order import — the property #1134 violated —
is a separate stateful check, also follow-on.

It runs on every PR via the `gatekeeper parity` job in
[.github/workflows/docker-build-test.yml](../../../.github/workflows/docker-build-test.yml),
which starts both gatekeepers side by side using
[docker/compose/gatekeeper-parity.yml](../../../docker/compose/gatekeeper-parity.yml).
To run it locally:

```sh
docker compose -f docker/compose/gatekeeper-parity.yml up -d --build --wait
TS_GATEKEEPER_URL=http://localhost:4224 \
RUST_GATEKEEPER_URL=http://localhost:4324 \
ARCHON_ADMIN_API_KEY=parity-admin-key node scripts/gatekeeper-parity.mjs
docker compose -f docker/compose/gatekeeper-parity.yml down -v
```

The CI workflow
[.github/workflows/docker-build-test.yml](../../../.github/workflows/docker-build-test.yml)
matrix-runs the 27-test CLI integration suite against both the TS and Rust
gatekeeper images on every PR; a third implementation can be added by:

1. Adding a `docker/compose/gatekeeper-<flavor>.yml` flavor file with the
   build/image plus the shared service body.
2. Adding `<flavor>` to the matrix in `docker-build-test.yml`.

---

## 17. Reference implementations

| Implementation | Source | Image |
| --- | --- | --- |
| TypeScript (canonical) | [services/gatekeeper/server/](../../../services/gatekeeper/server/) + [packages/gatekeeper/](../../../packages/gatekeeper/) | `ghcr.io/archetech/gatekeeper-typescript` |
| Rust | [rust/services/gatekeeper/](../../../rust/services/gatekeeper/) | `ghcr.io/archetech/gatekeeper-rust` |

Both images are interchangeable in `docker-compose.yml`; flavor selection
is done at the top of `docker-compose.yml` via the `include:` directive
parameterized by `ARCHON_GATEKEEPER_FLAVOR` (`ts` | `rust`, defaults to
`ts`). A new implementation can be added the same way.

For an in-depth audit comparing the two implementations against this spec,
see [rust/services/gatekeeper/AUDIT_REPORT.md](../../../rust/services/gatekeeper/AUDIT_REPORT.md).

### Canonical operation identity and retrieval aliases

CID import accepts retrievable JSON regardless of its original member order, but
accepted events and candidates use the complete operation's JCS-canonical CID as
`opid` and resolution `versionId`. Queue and history duplicate checks use that
identity, never `proofValue`. Repeated anchors retain their distinct chain positions.

Fetched operations remain cached under their retrieval CID. Predecessor lookup
may use that durable cache to resolve an existing signed alias to the canonical
previous operation; it does not rewrite signed `previd` values or trust a relayed
`opid` as an alias. Startup rebuilds normalize old event IDs and journals. Full
backups must retain both journals and the operation cache; a histories-only export
can require a rescan of original CID references to recover legacy aliases.

### Confirmed-resolution peer delegation

The legacy DID HTTP endpoint can consult the configured confirm-fallback peer when
local history is missing, or when resolution with the same selectors and
`confirm=false` reaches beyond the local confirmed prefix. A confirmed prefix is
not evidence that the node has confirmed its pending successor. Invalid DIDs,
requests without `confirm=true`, and requests bearing `X-Archon-Confirm-Fallback`
do not trigger this delegation.

Peer answers must identify the requested DID, contain no resolution error, report
confirmed state, respect the requested version/time bounds, and advance an
existing local confirmed version. Stale, malformed, unconfirmed, failed, or timed-out
answers leave the local result unchanged. The request forwards the selectors and
recursion marker. Delegation does not import events or cache peer documents and
does not alter core Gatekeeper resolution or authorization.

### Runtime performance reproduction

`scripts/benchmark-gatekeeper-runtime.mjs` measures TypeScript/Redis runtime work
with concurrent DID resolution. Build the Gatekeeper package first, then set
`ARCHON_BENCHMARK_HISTORIES` to an accepted-history JSON map (`CID` keys to hydrated
event arrays) and `ARCHON_BENCHMARK_REDIS_URL` to an isolated Redis server. Run:

```sh
node scripts/benchmark-gatekeeper-runtime.mjs duplicates
node scripts/benchmark-gatekeeper-runtime.mjs status
node scripts/benchmark-gatekeeper-runtime.mjs deferred
```

Each run seeds its own temporary Redis key prefix, skips startup repair, and
checks every accepted history for changes before deleting that prefix. The
`deferred` case inserts synthetic retained evidence with an absent predecessor
on the agent with the most dependents. IPFS is in memory: this measures core
processing and Redis costs, not network synchronization or Herald HTTP latency.
`ARCHON_BENCHMARK_IMPLEMENTATION` can select another built Gatekeeper `dist/esm`
directory for before/after comparisons using the same harness and snapshot.

### Startup replay benchmark

Unlike the runtime benchmark above, `scripts/benchmark-gatekeeper-startup.mjs`
includes startup recovery and status/search initialization, using the same combined initializer as the TypeScript service (or separate scans for older baseline builds).
Use a built Gatekeeper and an isolated Redis instance:

```sh
ARCHON_BENCHMARK_HISTORIES=/path/to/accepted-histories.json \
ARCHON_BENCHMARK_REDIS_URL=redis://127.0.0.1:16380 \
ARCHON_BENCHMARK_OUTPUT=/tmp/startup-baseline.json \
node scripts/benchmark-gatekeeper-startup.mjs
```

The input maps bare DID CID suffixes to hydrated event arrays with operation IDs.
Each run seeds and deletes only its own unique key prefix; it never flushes Redis.
Choose a new output path for each run. Set `ARCHON_BENCHMARK_IMPLEMENTATION` to
another built Gatekeeper `dist/esm` directory to benchmark it, and set
`ARCHON_BENCHMARK_REFERENCE` to a previous run's output to assert that every
accepted history matches after recovery. Compare recovered outputs rather than
assuming an older snapshot needs no canonical-ID repair. The benchmark reports
wall time and database method counts; summed method durations include concurrent
calls and must not be interpreted as additive wall time. It uses in-memory IPFS
and does not seed blockchain metadata, so production timing can differ.

### Chain reorganization recovery (`rewindRegistry`)

`POST /api/v1/block/:registry/rewind` accepts `{ "fromHeight": 100 }` and requires
`X-Archon-Admin-Key`. `registry` must be a chain registry; `fromHeight` must be a
nonnegative safe integer. The successful response is `true`. The mediator must
retry failures (including active imports or event processing) before advancing its
checkpoint. Imports hold admission through CID fetching and queue insertion;
rewind refuses to start while an import is active. During rewind, new imports
receive a retryable error rather than being queued behind the withdrawal.

For that registry at or above the inclusive height, Gatekeeper removes block
metadata and converts retained/queued chain receipts into unconfirmed Hyperswarm
hints. Signed operation bytes remain unchanged, hint time follows `proof.created`,
and unaffected receipts—including other anchors of the same operation—remain.
Changed histories and their controller dependents are replayed before success.
Deduplication permits rediscovered anchors to be imported again.

Candidate journals are authoritative after initial legacy-history migration.
Rewind writes changed journals before publishing accepted histories, so startup
must not merge stale projections back into an existing journal. If a request is
interrupted, the mediator retries it while retaining its original scan position;
completed journal writes survive recovery. This is evidence withdrawal, not a
change to operation authorization or batch DID resolution.

### Immutable genesis retrieval (`getGenesis`)

`GET /api/v1/did/:did/genesis` (SDK: `getGenesis(did)`) returns the original create
operation, including data and proof. This public, read-only endpoint retrieves
content from the local operation cache or IPFS, checks its canonical operation
identity against the DID and validates create-operation ingress shape and registration. Invalid identifiers,
unavailable content, mismatched content, and malformed creates fail the request.

It does not resolve a controller, assert signature authorization, import a DID,
or modify accepted histories. It works without publisher history and for a
genesis that ordinary resolution rejects. The response is an operation, not a
resolved document with authorization/confirmation metadata. Ordinary `resolveDID`
and version-sequence semantics are unchanged.

Chain mediators use this method to interpret the immutable original batch CID
list independently of publisher-history arrival order. A retained proof remains
available for provenance verification, but does not authorize contained operations:
Gatekeeper applies its normal authorization rules to each imported operation.
