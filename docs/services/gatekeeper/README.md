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
- one or more **registries** (`local`, `hyperswarm`, `BTC:mainnet`, `BTC:signet`, `BTC:testnet4`)
- an **IPFS node** (Kubo-compatible)
- a **block store** (per-registry block index for resolution timestamps)

It is responsible for:

- generating deterministic DIDs from create operations
- verifying cryptographic proofs (secp256k1 ECDSA over SHA-256 of canonical JSON)
- resolving DIDs into `didDocument` + `didDocumentMetadata` per the DID Core spec
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
(default `0.0.0.0:4224`). All API routes live under `/api/v1`. Two
non-versioned routes exist: `/metrics` for Prometheus and an `/api/*`
catch-all for unhandled paths.

### 2.1 Routes

| Method | Path | Admin? | Notes |
| --- | --- | :---: | --- |
| `GET` | `/api/v1/ready` | no | JSON boolean. `true` once startup is complete. |
| `GET` | `/api/v1/version` | no | `{ "version": string, "commit": string }` (commit truncated to 7 chars). |
| `GET` | `/api/v1/status` | no | `{ uptimeSeconds, dids, memoryUsage }`. See [§3.10](#310-status-payload). |
| `GET` | `/api/v1/registries` | no | JSON array of supported registry names. |
| `POST` | `/api/v1/did` | no | Submit a `create`, `update`, or `delete` operation. Create returns the new DID string; update/delete return `true`. See [§7](#7-did-create--update--delete-validation). |
| `POST` | `/api/v1/did/generate` | no | Deterministic DID generation without persistence. Body: `Operation`. Returns: DID string. |
| `GET` | `/api/v1/did/:did` | no | Resolve a DID. Query params: `versionTime` (ISO 8601), `versionSequence` (int), `confirm` (`"true"`/`"false"`), `verify` (`"true"`/`"false"`). See [§6](#6-did-resolution-algorithm). |
| `POST` | `/api/v1/dids` | no | List DIDs. Aliased to `/api/v1/dids/`. Body: `GetDIDOptions`. |
| `POST` | `/api/v1/dids/` | no | Same as above. |
| `POST` | `/api/v1/dids/remove` | yes | Body: array of DIDs. Returns boolean. |
| `POST` | `/api/v1/dids/export` | no | Body: `{ "dids": string[] | undefined }`. Returns `GatekeeperEvent[][]` (one inner array per DID). |
| `POST` | `/api/v1/dids/import` | yes | Body: `GatekeeperEvent[][]`. Flattens into a batch and queues for processing. Returns `ImportBatchResult`. |
| `POST` | `/api/v1/batch/export` | yes | Body: `{ "dids": string[] | undefined }`. Returns a single sorted `GatekeeperEvent[]` of all non-`local` events for the chosen DIDs. |
| `POST` | `/api/v1/batch/import` | yes | Body: `GatekeeperEvent[]`. Returns `ImportBatchResult`. Empty arrays MUST be rejected with HTTP 500 `Error: Invalid parameter: batch`. |
| `POST` | `/api/v1/batch/import/cids` | yes | Body: `{ "cids": string[], "metadata": BatchMetadata }`. Hydrates each CID via the operation store or IPFS, then imports. Empty `cids` MUST 500 with `Error: Invalid parameter: cids`; missing `metadata.registry`/`time`/`ordinal` MUST 500 with `Error: Invalid parameter: metadata`. |
| `GET` | `/api/v1/queue/:registry` | yes | Returns queued outbound `Operation[]` for the registry. |
| `POST` | `/api/v1/queue/:registry/clear` | yes | Body: `Operation[]`. Removes the matching events (matched by `proof.proofValue`) from the queue. Returns the **remaining** queue array. |
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
- When `ARCHON_ADMIN_API_KEY` is set, admin routes MUST require a matching header.
- On missing or wrong key, return:
  - status `401`
  - body `{"error":"Unauthorized — valid admin API key required"}` (note the em dash)
- When `ARCHON_ADMIN_API_KEY` is unset/empty, admin routes MUST be open (development mode). Implementations MUST log a warning at startup in this case.

### 2.3 CORS

The service MUST respond to cross-origin requests with permissive CORS so
that browser-based wallets/explorers can call it directly:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: *`
- `Access-Control-Allow-Headers: *`

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

```jsonc
{
  "type": "EcdsaSecp256k1Signature2019",      // MUST be exactly this string
  "created": "<RFC 3339>",                    // signature timestamp
  "verificationMethod": "<did>#key-1",         // for create-agent it is exactly "#key-1" (relative)
  "proofPurpose": "assertionMethod" | "authentication",
  "proofValue": "<base64url(64-byte ECDSA r||s)>"
}
```

### 3.3 `DocumentRegistration`

```jsonc
{
  "version": 1,                               // currently only version 1 is valid
  "type": "agent" | "asset",
  "registry": "local" | "hyperswarm" | "BTC:mainnet" | "BTC:signet" | "BTC:testnet4",
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
  "registration": DidRegistration | undefined  // batch metadata, optional
}
```

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

```jsonc
{
  "didDocument": {
    "@context": ["https://www.w3.org/ns/did/v1"],
    "id": "did:cid:...",
    "controller": "did:cid:...",              // assets only
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
    "confirmed": true | false,
    "timestamp": {                             // when registration registry has block info
      "chain": "BTC:signet",
      "opid": "<CID>",
      "lowerBound": { time, timeISO, blockid, height } | null,
      "upperBound": { time, timeISO, blockid, height, txid, txidx, batchid, opidx } | null
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
  "versionTime": "<RFC 3339>",                 // stop replay when event time > versionTime
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
                    | { added, merged, rejected, pending: <int> }
VerifyDbResult      = { total, verified, expired, invalid: <int> }
BlockInfo           = { height: <int>, hash: <string>, time: <unix-seconds> }
BatchMetadata       = { registry, time, ordinal: number[], registration?: DidRegistration }
```

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
implements the subset sufficient for operation payloads (sorted keys, no
whitespace, basic escaping). It is verified byte-for-byte against the TS
output via the deterministic-vectors fixture.

A new implementation MAY use any canonical-JSON library that matches the
fixture output. Recommended: a JCS-compliant library where one exists.

---

## 5. Cryptographic proof contract

Curve: **secp256k1**. Hash: **SHA-256**. Signature scheme: **ECDSA**, fixed
64-byte form `r || s`, big-endian.

### 5.1 Signing

```
operation_without_proof = clone(operation); delete operation_without_proof.proof
canonical               = canonicalize(operation_without_proof)
msg_hash                = sha256(canonical)            // 32 bytes
signature               = ecdsa_sign(secp256k1, private_key, msg_hash)
proof.proofValue        = base64url(signature_64_bytes)
```

The signer MUST sign the prehashed message (no extra hashing inside ECDSA).

### 5.2 Verifying

`Proof` validation steps (any failure -> reject):

1. `proof.type == "EcdsaSecp256k1Signature2019"`
2. `proof.created` parses as RFC 3339
3. `proof.proofPurpose ∈ { "assertionMethod", "authentication" }`
4. `proof.verificationMethod` contains `#`. Split on first `#`; the prefix
   MUST be empty (relative) or a valid DID
5. `proof.proofValue` is a non-empty string

Then signature verification:

1. Compute `msg_hash` as in [§5.1](#51-signing)
2. Decode `proofValue` as base64url -> 64-byte signature
3. Decode the signing public key (see [§5.3](#53-key-resolution-by-operation-type))
4. ECDSA-verify the prehash against the signature with that public key

### 5.3 Key resolution by operation type

| Operation | verificationMethod | Key source |
| --- | --- | --- |
| `create` agent | MUST equal `#key-1` (relative, since the DID does not yet exist) | `operation.publicJwk` (self-signed) |
| `create` asset | `<controller>#key-1`. `controller` portion MUST equal `operation.controller` | resolve `controller` DID with `confirm: true, versionTime: proof.created`; use `didDocument.verificationMethod[0].publicKeyJwk` |
| `update` / `delete` on agent | `<did>#key-N` | resolve `operation.did`; use `didDocument.verificationMethod[0].publicKeyJwk` |
| `update` / `delete` on asset | controller's verification method | resolve the doc, follow `controller`, use that controller's `verificationMethod[0].publicKeyJwk` |

### 5.4 Operation size limit

`canonical_operation_bytes <= 64 * 1024`. Operations exceeding this MUST be
rejected (HTTP 500 from create/update; counted as `rejected` in
`importBatch`). Implementations SHOULD avoid full JSON serialization for the
size check (e.g. counting writer with early abort).

### 5.5 JWK encoding

`publicJwk` carries the X and Y coordinates as 32-byte unsigned big-endian
base64url-encoded values. Implementations MUST reconstruct the SEC1
compressed form (33 bytes: `0x02 | x` if Y is even, `0x03 | x` if odd) for
secp256k1 verifying-key deserialization.

Test vectors: [tests/gatekeeper/proof-vectors.json](../../../tests/gatekeeper/proof-vectors.json)
covers valid agent/asset create + update + delete, plus several invalid
shapes that MUST be rejected.

---

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
    if options.versionTime  and event.time  > options.versionTime:  break
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
| `update` | `versionN++`; `versionId := event.opid || cid(event.operation)`; `updated := event.time`; merge `event.operation.doc.didDocument`, `didDocumentData`, `didDocumentRegistration` into the running doc (any field present in `event.operation.doc` replaces the corresponding field on the running doc); `deactivated := false`. |
| `delete` | `versionN++`; `versionId := ...`; `deleted := updated := event.time`; `didDocument := { id: did }`; `didDocumentData := {}`; `deactivated := true`. |
| anything else | ignored |

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

Each bound is `null` when unknown.

### 6.4 Final clean-up

Before returning, implementations MUST:

- delete deprecated fields if present: `didDocumentRegistration.opid`,
  `didDocumentRegistration.registration`
- omit `didDocumentMetadata.deactivated` unless `true`
- omit `didDocumentMetadata.updated` unless an update occurred
- omit `didDocumentMetadata.deleted` unless a delete occurred
- omit `didDocumentMetadata.canonicalId` unless set
- always emit `didDocumentMetadata.versionId`, `versionSequence` (string),
  `confirmed`, `created`

---

## 7. DID create / update / delete validation

### 7.1 `create`

1. Reject if total operation byte size exceeds 64 KB.
2. Reject if `type != "create"`, `created` is malformed, `registration` is
   missing or any of `version`, `type`, `registry` is invalid, or `proof`
   format checks fail.
3. Agent: `proof.verificationMethod == "#key-1"` and `publicJwk` is present.
   Verify signature against `publicJwk`.
4. Asset: `proof.verificationMethod` is `<controller>#key-1`,
   `operation.controller == controller`. Resolve the controller with
   `confirm: true, versionTime: proof.created`. Reject if the controller's
   `registration.registry == "local"` and the new operation's registry is
   non-`local`. Verify against the controller's `verificationMethod[0]
   .publicKeyJwk`.
5. Reject if `registration.registry` is not in the server's
   `supportedRegistries`.
6. Append the event with `registry: "local"`, `ordinal: [0]`, `time:
   operation.created`, `opid: cid(operation)`.
7. If the registry is non-`local`, queue the operation for outbound
   distribution (see [§10.4](#104-outbound-queue)).

### 7.2 `update` / `delete`

1. Reject if total operation byte size exceeds 64 KB.
2. Reject if `proof` format checks fail.
3. Resolve the target DID. Reject if the doc is `deactivated` or has no
   `verificationMethod`.
4. If the doc has a `controller` (asset), recurse on the controller doc to
   pick verification key.
5. Verify signature against the resolved key.
6. Reject if `doc.didDocumentRegistration.registry` is not in
   `supportedRegistries`.
7. For `update`: reject if `operation.doc.didDocumentRegistration.registry`
   exists and refers to an unsupported registry.
8. Append with `registry: "local"`, `ordinal: [0]`, `time: proof.created`.
9. Queue for outbound distribution if the target registry is non-`local`.

Concurrency: per-DID operations MUST be serialized. The implementation
MUST guarantee that two concurrent `POST /did` calls for the same DID see
each other's effects when computing `previd`.

---

## 8. Event import state machine

Used by `/dids/import`, `/batch/import`, `/batch/import/cids`, and
`/events/process`.

### 8.1 `importBatch(events)`

```
for event in events:
    if !verify_event_shape(event):           // §8.4
        rejected += 1; continue

    key := event.registry + "/" + event.operation.proof.proofValue
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

### 8.3 `importEvents()` (single pass)

Drains the queue once. For each event, runs `importEvent` and accumulates
counters. Events returning `DEFERRED` are pushed back onto the queue (to be
attempted on the next pass).

### 8.4 `importEvent(event)` per-event flow

```
1. ensure event.did and event.opid are set (compute via DID generation if missing)
2. acquire per-DID lock
3. current = store.get_events(did)
4. if any current event has identical proof.proofValue:
       expectedRegistry = expected_registry_for_index(current, index_of_match)
       if current[match].registry == expectedRegistry: return MERGED
       elif event.registry == expectedRegistry:
           replace current[match] := event; setEvents(did, current); return ADDED
       else: return MERGED
5. if current is non-empty and event.operation.previd is missing: return REJECTED
6. valid = verify_operation(event.operation)        // §5.2 + §7
   if Err("Invalid operation"-class): return DEFERRED   (the controller may not be imported yet)
   if !valid: return REJECTED
7. if current is empty: addEvent(did, event); return ADDED
8. find prev = event whose opid == event.operation.previd
   if !prev: return DEFERRED
9. let i = index_of(prev)
   if i == current.length - 1:
       addEvent(did, event); return ADDED
   expectedRegistry = expected_registry_for_index(current, i + 1)
   if event.registry == expectedRegistry:
       next = current[i+1]
       if next.registry != event.registry
          or compare_ordinals(event.ordinal, next.ordinal) < 0:
           // reorg: replace the rest of the chain
           setEvents(did, current[..=i] + [event])
           return ADDED
10. return REJECTED
```

`expected_registry_for_index(events, i)` walks forward from index 0,
starting from `events[0].operation.registration.registry`, switching to
`event.operation.doc.didDocumentRegistration.registry` whenever an `update`
re-registers it.

### 8.5 Event shape validation

```
event.registry ∈ ValidRegistries
event.time parses as RFC 3339
event.operation present, canonical-bytes <= 64 KB
proof format valid (§5.2)
operation.type ∈ { create, update, delete }
  - create: created, registration.{version=1, type, registry}, type-specific fields
  - update: did, doc with at least one of { didDocument, didDocumentData, didDocumentRegistration };
            if doc.didDocument.id is set it MUST equal operation.did
  - delete: did
```

### 8.6 Ordinal comparison

`compare_ordinals(a, b)` is element-wise lexicographic over `Vec<u64>`:
shorter is "less than" prefix-equal longer (matches the TS behavior).
`None` ordinals compare as equal to anything.

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

The Gatekeeper stores six logical resources:

| Resource | Purpose |
| --- | --- |
| `dids` | per-DID append-only `EventRecord[]` |
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

### 10.3 Filesystem layout

| Backend | Path |
| --- | --- |
| `json` / `json-cache` | `${ARCHON_DATA_DIR}/archon.json` |
| `sqlite` | `${ARCHON_DATA_DIR}/archon.db` |

`ARCHON_DATA_DIR` defaults to `data` (relative to working directory) and
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
defaults to `"archon"`):

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
CREATE TABLE dids       (id TEXT PRIMARY KEY, events TEXT NOT NULL);
CREATE TABLE queue      (id TEXT PRIMARY KEY, ops TEXT NOT NULL);
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

Interval: `ARCHON_GATEKEEPER_STATUS_INTERVAL` minutes (default 5).
Runs `checkDIDs()` (the same code path as `GET /status`) and logs a status
block to stdout. This loop also refreshes the DID-count Prometheus gauges.

### 12.2 GC loop

Interval: `ARCHON_GATEKEEPER_GC_INTERVAL` minutes (default 15).
Runs `verifyDb()`:

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

A passed `verifyDb` MUST clear the import queue (events that survived a full
re-verify are good; orphaned ones are not re-considered until the next
import cycle).

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
/api/v1/did/did:...        -> /api/v1/did/:did
/api/v1/block/<r>/latest   -> /api/v1/block/:registry/latest
/api/v1/block/<r>/<id>     -> /api/v1/block/:registry/<id>
/api/v1/queue/<r>/clear    -> /api/v1/queue/:registry/clear
/api/v1/queue/<r>          -> /api/v1/queue/:registry
/api/v1/events/<x>         -> /api/v1/events/:registry
/api/v1/dids/<x>           -> /api/v1/dids/:prefix
```

The label MUST include the `/api/v1` prefix.

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
| `ARCHON_DATA_DIR` | `data` | On-disk data root. |
| `ARCHON_IPFS_URL` | `http://localhost:5001/api/v0` | Kubo HTTP API base. |
| `ARCHON_REDIS_URL` | `redis://localhost:6379` | Redis URL when `db=redis`. |
| `ARCHON_MONGODB_URL` | `mongodb://localhost:27017` | MongoDB URL when `db=mongodb`. |
| `ARCHON_GATEKEEPER_DID_PREFIX` | `did:cid` | DID prefix for locally-generated DIDs. |
| `ARCHON_GATEKEEPER_REGISTRIES` | unset | Comma-separated allowlist; empty/unset means `local,hyperswarm`. |
| `ARCHON_GATEKEEPER_JSON_LIMIT` | `4mb` | JSON request-body size cap. |
| `ARCHON_GATEKEEPER_UPLOAD_LIMIT` | `10mb` | Raw/text body cap on `/ipfs/text` and `/ipfs/data`. |
| `ARCHON_GATEKEEPER_GC_INTERVAL` | `15` | GC loop interval in minutes (`0` disables). |
| `ARCHON_GATEKEEPER_STATUS_INTERVAL` | `5` | Status loop interval in minutes (`0` disables). |
| `ARCHON_ADMIN_API_KEY` | empty | Admin API key. Empty disables admin auth. |
| `ARCHON_GATEKEEPER_FALLBACK_URL` | `https://dev.uniresolver.io` | Universal resolver to consult on local notFound. Empty disables. |
| `ARCHON_GATEKEEPER_FALLBACK_TIMEOUT` | `5000` | Fallback timeout in ms. |
| `GIT_COMMIT` | `unknown` | Build commit. |

### 14.3 Healthcheck

Container healthcheck SHOULD:

```
test "$(wget -qO- http://127.0.0.1:4224/api/v1/ready)" = "true"
```

`/api/v1/ready` MUST return JSON `false` until startup is complete (DB
loaded, search index initialized, background tasks scheduled, listener
bound) and `true` thereafter.

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

Three shared JSON fixtures drive cross-language conformance:

| File | Purpose |
| --- | --- |
| [tests/gatekeeper/deterministic-vectors.json](../../../tests/gatekeeper/deterministic-vectors.json) | Canonical-JSON / CID / DID generation vectors. Every implementation MUST produce identical bytes/IDs. |
| [tests/gatekeeper/proof-vectors.json](../../../tests/gatekeeper/proof-vectors.json) | Valid + invalid proof shapes for `verifyProofFormat`, `verifyCreateOperation`, `verifyUpdateOperation`. |
| [tests/gatekeeper/api-parity-fixtures.json](../../../tests/gatekeeper/api-parity-fixtures.json) | Stateless HTTP request/response fixtures across most endpoints. |
| [tests/gatekeeper/api-parity-flows.json](../../../tests/gatekeeper/api-parity-flows.json) | Stateful flows (create + resolve + export + import + queue + block + IPFS round-trips). |
| [tests/gatekeeper/metrics-parity.json](../../../tests/gatekeeper/metrics-parity.json) | Required metric names + route normalization expectations. |

The script [scripts/gatekeeper-parity.mjs](../../../scripts/gatekeeper-parity.mjs)
runs side-by-side HTTP and metrics diffs against any two implementations
listening on `GATEKEEPER_URL_A` and `GATEKEEPER_URL_B`. New implementations
SHOULD pass this script against the TypeScript reference before being
considered drop-in.

The CI workflow
[.github/workflows/docker-build-test.yml](../../../.github/workflows/docker-build-test.yml)
matrix-runs the 27-test CLI integration suite against both the TS and Rust
gatekeeper images on every PR; a third implementation can be added by:

1. Adding a `docker-compose.gatekeeper-<flavor>.yml` flavor file with the
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
