# Rust Gatekeeper Drop-in Replacement Audit

**Date:** 2026-04-12 (original), updated after fixes landed
**Scope:** Compare `rust/services/gatekeeper/` against the TypeScript sources
of truth: [services/gatekeeper/server/src/gatekeeper-api.ts](../../../services/gatekeeper/server/src/gatekeeper-api.ts),
[packages/gatekeeper/src/](../../../packages/gatekeeper/src/),
and [services/gatekeeper/server/src/config.js](../../../services/gatekeeper/server/src/config.js).
**Requirement:** Rust service must be a drop-in replacement — matching routes,
request/response shapes, status codes, metrics, storage layout, DID semantics,
and container contract.

---

## Executive Summary

**Status: drop-in parity achieved.** All contract-breaking gaps identified in
the original audit were addressed before merge. This summary lists every issue
found and its current state; detailed analysis per area is below.

| # | Finding | Status |
| :- | :- | :- |
| 1 | SQLite filename differed (`archon.sqlite` vs TS `archon.db`) | **Fixed** — renamed to `archon.db` |
| 2 | No CORS middleware — browser clients would fail cross-origin | **Fixed** — `tower_http::cors::CorsLayer` with `Any` origin/methods/headers |
| 3 | `ARCHON_GATEKEEPER_JSON_LIMIT` parsed but never applied | **Fixed** — per-route `DefaultBodyLimit` layers: `json_limit` on JSON routes, `upload_limit` on `/ipfs/text` and `/ipfs/data`, unbounded on `/ipfs/stream`, matching TS express middleware layout |
| 4 | Metric `route` labels dropped `/api/v1` prefix | **Fixed** — `qualify_route()` auto-prefixes in `record_metrics` |
| 5 | `/queue/:registry/clear` returned a boolean instead of the remaining queue | **Fixed** — now returns the queue array |
| 6 | `/did/:did` fallback forwarded query params and 404'd differently | **Fixed** — no query-param forwarding; returns the local error doc at 200 when fallback is unavailable |
| 7 | `resolveDID` omitted `timestamp`, `blockid` upper/lower bounds | **Fixed** — `build_timestamp` pulls block metadata into `didDocumentMetadata.timestamp` on both store and resolver paths |
| 8 | `search` / `query` / `getDIDs` result ordering differed | **Fixed** — `SearchIndex` tracks insertion order and returns results in that order; filtered `getDIDs` preserves order |
| 9 | `importBatch` accepted empty arrays (TS throws 500) | **Fixed** — 500 with `Error: Invalid parameter: batch` on empty/non-array |
| 10 | Version string hard-coded to `"0.7.0"` | **Fixed** — sources `env!("CARGO_PKG_VERSION")` with `ARCHON_GATEKEEPER_VERSION` override |
| 11 | SQLite block `txns` always written as 0 | **Fixed** — reads `block.get("txns")` and preserves it |
| 12 | `/ipfs/stream` buffered the whole body (capped at 10 MB; TS is unbounded) | **Fixed** — axum body stream piped via `reqwest::Body::wrap_stream`; route mounted with `DefaultBodyLimit::disable()` |
| 13 | `/ipfs/stream/:cid` GET buffered the full cat response | **Fixed** — streams via `axum::body::Body::from_stream` |
| 14 | `importBatch` bottlenecked by `refresh_metrics_snapshot` on every call (~2.5 s per 100 events) | **Fixed** — refresh removed from every bulk mutating path; import queue decoupled from store mutex; `/status` reads live queue for `eventsQueue` |
| 15 | No HTTP request logging | **Fixed** — axum middleware emits `METHOD path status (Nms)` per request |
| 16 | verifyDb per-DID chatty lines missing | **Fixed** — `removing/expiring/verifying N/T` and `verifyDb: <ms>ms` ported |
| 17 | GC loop missing "waiting N minutes..." | **Fixed** |
| 18 | 404 / 5xx / 4xx responses invisible in logs | **Fixed** — centralized logging in `text_error_response` + `api_not_found` / `not_found` |
| 19 | Graceful shutdown absent | **Fixed** — SIGTERM/SIGINT drain via `with_graceful_shutdown` |
| 20 | JSON DB written with 2-space indent (TS uses 4) | **Fixed** — custom `PrettyFormatter::with_indent(b"    ")` |
| 21 | Deprecated `didDocumentRegistration.opid` / `.registration` fields not stripped on resolve | **Fixed** |

### Known non-drop-in-blocking divergences

- Mongo and SQLite connections are opened per call instead of pooled —
  correctness-equivalent, slower than TS under load, invisible to clients.
- Serde's `Map` sorts object keys alphabetically when serializing; TS
  `JSON.stringify` preserves JS insertion order. Parsed output is identical;
  byte-level JSON (e.g. on-disk DB file or raw HTTP body hash) differs.
- Default Node.js process metrics (`nodejs_*`, `process_*`) are not emitted —
  not part of the metrics contract but may show blank on existing dashboards
  that assumed them.

---

## 1. HTTP / Routing Parity

### 1.1 Route table

Legend: **OK** = matches TS; **PARTIAL** = route exists but behaviour diverges;
**MISMATCH** = incompatible.

| Route | Method | Status | Notes |
| --- | --- | :---: | --- |
| `/api/v1/ready` | GET | OK | [api.rs:57](src/api.rs#L57) returns `Json(bool)`. |
| `/api/v1/version` | GET | PARTIAL | [api.rs:62](src/api.rs#L62) uses `config.version` hard-coded to `"0.7.0"` ([config.rs:70](src/config.rs#L70)); TS reads `pkg.version` from `package.json`. Must be wired to image build or will drift. |
| `/api/v1/status` | GET | PARTIAL | Shape matches, but `memoryUsage.heapTotal / heapUsed / external / arrayBuffers` are always `0` (documented, [api.rs:102-108](src/api.rs#L102-L108)). RSS parsed from `/proc/self/status`. |
| `/api/v1/did` | POST | PARTIAL | [api.rs:167](src/api.rs#L167). Error path returns `text/plain` body `"Error: <msg>"` ([api.rs:210](src/api.rs#L210)); TS sends `error.toString()` which is typically `"Error: <msg>"` — close but any non-Error thrown value diverges. |
| `/api/v1/did/generate` | POST | PARTIAL | Rust wraps all errors as `{"error": str}` ([api.rs:160](src/api.rs#L160)); TS returns `err?.response?.data ?? err` which can be raw upstream body. Acceptable for CLI callers but divergent. |
| `/api/v1/did/:did` | GET | MISMATCH | See §1.3 below. |
| `/api/v1/dids` and `/api/v1/dids/` | POST | PARTIAL | Both aliases exist ([app.rs:147-148](src/app.rs#L147-L148)). Ordering & extra options differ — see §1.4. |
| `/api/v1/dids/remove` | POST | PARTIAL | Admin‑gated. Accepts both `[..]` and `{"dids":[..]}`; TS only expects a bare array. Extra form is additive, not harmful. Error on empty/invalid input returns 500 `"Error: Invalid parameter: dids"` ([api.rs:407](src/api.rs#L407)) vs TS throwing an `InvalidParameterError`. |
| `/api/v1/dids/export` | POST | OK | |
| `/api/v1/dids/import` | POST | PARTIAL | Admin‑gated. Rejects non-array with text body `"TypeError: dids.flat is not a function"` ([api.rs:451](src/api.rs#L451)) — mimics TS runtime error string, OK for parity. |
| `/api/v1/batch/export` | POST | OK | Admin‑gated. Sort key matches TS (`operation.proof.created`). |
| `/api/v1/batch/import` | POST | **MISMATCH** | Admin‑gated. TS throws `InvalidParameterError('batch')` on empty arrays (500 error). Rust accepts `[]` and returns `{queued:0, processed:0, rejected:0, total:<queueLen>}` ([api.rs:558-583](src/api.rs#L558-L583)). |
| `/api/v1/batch/import/cids` | POST | PARTIAL | Admin‑gated. If metadata is missing → 500 text (matches). On missing `metadata.registry` / `metadata.time` / `metadata.ordinal`, Rust falls back to `"hyperswarm"` / `now()` / `[]` ([api.rs:662-669](src/api.rs#L662-L669)) — TS would throw `InvalidParameterError('metadata')`. |
| `/api/v1/queue/:registry` | GET | OK | Admin‑gated. |
| `/api/v1/queue/:registry/clear` | POST | **MISMATCH** | TS returns the remaining queue array (gatekeeper-api.ts:1519-1520). Rust returns boolean `ok` ([api.rs:768](src/api.rs#L768)). |
| `/api/v1/registries` | GET | OK | |
| `/api/v1/db/reset` | GET | OK | Admin‑gated. `NODE_ENV=production` rejection matches. |
| `/api/v1/db/verify` | GET | OK | Admin‑gated. Extra behaviour: Rust rebuilds the search index after verify; TS does not. Metric-friendly, harmless. |
| `/api/v1/events/process` | POST | OK | Admin‑gated. `busy` path returns `{"busy": true}` via `skip_serializing_if` — wire shape matches. |
| `/api/v1/ipfs/json` + `/api/v1/ipfs/json/:cid` | POST/GET | PARTIAL | See §1.5 IPFS. |
| `/api/v1/ipfs/text` + `/api/v1/ipfs/text/:cid` | POST/GET | PARTIAL | `upload_limit` respected. |
| `/api/v1/ipfs/data` + `/api/v1/ipfs/data/:cid` | POST/GET | PARTIAL | `upload_limit` respected. |
| `/api/v1/ipfs/stream` + `/api/v1/ipfs/stream/:cid` | POST/GET | PARTIAL | Stream is buffered in memory, not streamed — see §1.5. |
| `/api/v1/block/:registry/latest` | GET | OK | |
| `/api/v1/block/:registry/:blockId` | GET | OK | Parses numeric blockId as height, string as hash (matches TS [gatekeeper-api.ts:2060](../../../services/gatekeeper/server/src/gatekeeper-api.ts#L2060)). |
| `/api/v1/block/:registry` | POST | OK | Admin‑gated. |
| `/api/v1/search` | GET | PARTIAL | Result ordering differs — §5.1. |
| `/api/v1/query` | POST | PARTIAL | Result ordering differs — §5.1. Also: `$in` rejection returns 500 instead of 400. |
| `/api/*` (fallback) | ANY | OK | Both return `404 {"message":"Endpoint not found"}`. |
| `/metrics` | GET | PARTIAL | See §5.2. |

### 1.2 Middleware / startup

**CORS missing.** TS configures `app.use(cors())` + `app.options('*', cors())`
([gatekeeper-api.ts:162-163](../../../services/gatekeeper/server/src/gatekeeper-api.ts#L162-L163)).
[app.rs:134-177](src/app.rs#L134-L177) has no CORS layer. Any browser client
hitting Rust gatekeeper from a different origin will fail preflight. This is
the single most likely cutover breakage for consumers like KeymasterUI.

**JSON body limit not enforced.** `Config.json_limit` is populated in
[config.rs:48-55](src/config.rs#L48-L55) but never referenced by the router.
Axum's `Json<Value>` extractor defaults to a 2 MB cap. TS default is `4mb`. Any
create/update operation larger than 2 MB will be 422'd by Rust while TS
accepts. Wire a `DefaultBodyLimit::max(config.json_limit)` on the `/api/v1`
router or per‑route.

**Graceful shutdown.** TS installs SIGTERM/SIGINT handlers and calls
`db.stop()`. Rust's [app.rs:105](src/app.rs#L105) calls `axum::serve` with no
shutdown handler; databases don't get an explicit close (redis connection is
dropped, sqlite reopens per call, mongo reopens per call). Non-blocking but
noisy in container logs and inconsistent with TS.

**Request logging.** TS uses `pino`/`morgan` HTTP logging; Rust uses
`tracing_subscriber` ([app.rs:179-183](src/app.rs#L179-L183)). Output format is
different — not a contract item.

### 1.3 `/api/v1/did/:did` resolver behaviour

[api.rs:1008-1169](src/api.rs#L1008-L1169) vs
[gatekeeper-api.ts:795-833](../../../services/gatekeeper/server/src/gatekeeper-api.ts#L795-L833):

- **Forwards query params to fallback.** Rust appends URL-encoded `?k=v` query
  params to the universal resolver URL ([api.rs:1083-1091](src/api.rs#L1083-L1091)).
  TS does not — it sends only `/1.0/identifiers/<did>`. This can produce
  different responses from the universal resolver for the same request.
- **404 vs 200-with-error behaviour diverges.** TS always returns 200 with
  `didResolutionMetadata.error` on not-found (either the local error doc or
  fallback). Rust returns 404 `{"error":"DID not found"}` when fallback fails
  and the DID has no local events ([api.rs:1070-1074](src/api.rs#L1070-L1074)).
- **Rust returns full resolver body bytes** for successful fallback; TS parses
  then re-serializes with `res.json(resolved)`. Equivalent wire JSON but
  Content-Type/encoding can differ.
- **Client 404 shape divergence.** TS on error returns `{"error":"DID not
  found"}` with status 404 — matches. Rust sometimes returns the error doc
  shape (`didResolutionMetadata.error = notFound`) with 200. Two different
  shapes for the same semantic failure.

### 1.4 `POST /api/v1/dids` / `/dids/` listing

[api.rs:215-323](src/api.rs#L215-L323) vs
[gatekeeper.ts:905-950](../../../packages/gatekeeper/src/gatekeeper.ts#L905-L950):

- **Sort order differs.** Rust sorts filtered results by `updated` timestamp
  ([api.rs:303](src/api.rs#L303)). TS preserves `getAllKeys()` iteration order.
  Any client that relied on unordered stability will see a different order.
- **Extra options parsed.** Rust extracts `versionTime` and `versionSequence`
  from the body ([api.rs:247-253](src/api.rs#L247-L253)); TS's `getDIDs` does
  not support per‑DID version targeting in listing. Additive; harmless for TS
  callers but a shape they don't expect.
- **`resolve:false` + `updatedAfter` returns filtered string list** — matches
  TS.
- **`confirm`/`verify` are plumbed into resolve but NOT honored in the simple
  path.** When no `resolve`/`updatedAfter`/`updatedBefore` is present, Rust
  returns the raw DID list without applying `confirm`/`verify`. TS behaves the
  same in that path, so this is OK.

### 1.5 IPFS endpoints

- TS uses a `KuboClient` which addresses `/api/v0/block/put`, `/api/v0/add`,
  `/api/v0/cat`. Rust replicates the `block/put` + `/add` + `/cat` multipart
  dance against the configured `ipfs_url`. This should produce identical CIDs
  for identical content but has not been confirmed against all payload sizes /
  types (see [PORT_CHECKLIST.md:135-137](PORT_CHECKLIST.md#L135-L137)).
- **`/ipfs/stream` POST streams the axum request body straight into the Kubo
  multipart part** via `reqwest::Body::wrap_stream` and is mounted on a router
  layer with `DefaultBodyLimit::disable()` so the payload is unbounded — matches
  the TS behaviour of piping `req` directly into the IPFS client with no server
  cap.
- **GET `/ipfs/stream/:cid`** builds the response body via
  `axum::body::Body::from_stream(response.bytes_stream())`, so chunks hit the
  client as Kubo produces them — matching TS `res.write(chunk)` streaming.
- **`Content-Type` on GET `/ipfs/data/:cid`** is always
  `application/octet-stream` in both implementations. OK.
- **Filename sanitation.** Rust strips `"` out of the `filename` query param
  before placing it into `Content-Disposition` ([api.rs:1433](src/api.rs#L1433)),
  which TS's `res.attachment(filename)` does not — behaviour is slightly
  safer, but response header differs.

---

## 2. Admin auth

Spec ([COMPATIBILITY_CONTRACT.md:56-62](COMPATIBILITY_CONTRACT.md#L56-L62)):
header `X-Archon-Admin-Key`, 401 + `{"error":"Unauthorized — valid admin API
key required"}` on missing/invalid.

[api.rs:1633-1651](src/api.rs#L1633-L1651) matches exactly (body string
uses the em-dash, matching TS).

Routes protected by Rust (via inline `require_admin_key`):
`/dids/remove`, `/dids/import`, `/batch/export`, `/batch/import`,
`/batch/import/cids`, `/queue/:registry`, `/queue/:registry/clear`,
`/db/reset`, `/db/verify`, `/events/process`, `/block/:registry`. TS protects
the same set (via `requireAdminKey` inline or `adminRouter`). **Admin surface
matches.**

One stylistic divergence: TS uses an Express router (`adminRouter`) for some
routes and inline middleware for others; Rust is inline everywhere. No
functional impact.

---

## 3. Core gatekeeper logic

### 3.1 Proof verification (`proofs.rs`)

- `verify_proof_format` ([proofs.rs:139-166](src/proofs.rs#L139-L166)) matches
  TS [gatekeeper.ts:356-385](../../../packages/gatekeeper/src/gatekeeper.ts#L356-L385)
  exactly (same type check, RFC3339 date check, purpose allowlist, `#` split).
- `verify_create_operation_impl` mirrors TS except:
  - **Error messages are rendered with the same `Invalid operation: <detail>`
    prefix**, making TS/Rust error comparisons in fixtures stable.
  - Asset create: Rust resolves the controller via `resolve_local_doc_async`
    with `confirm: true` and `version_time = proof.created` — matches TS.
- `verify_update_operation_impl` matches TS (asset controller recursion, key
  pick from `verificationMethod[0]`, same error strings).
- `canonical_json` ([proofs.rs:491-523](src/proofs.rs#L491-L523)) is proven
  equivalent to the TS `canonicalizeJSON` by a shared fixture
  ([lib.rs:297-317](src/lib.rs#L297-L317)). **Good.**
- `generate_json_cid` uses CID v1 codec `0x0200` (application/json multicodec)
  — matches TS `generateCID`. Shared vector `tests/gatekeeper/deterministic-vectors.json`
  is green in tests.

### 3.2 Resolver (`resolver.rs`)

[resolver.rs:47-258](src/resolver.rs#L47-L258) implements a mostly‑faithful
port of TS `resolveDID`. Divergences:

- **`timestamp` metadata is dropped.** TS builds a
  `{chain, opid, lowerBound, upperBound}` block‑anchored timestamp from
  `db.getBlock()` on each event ([gatekeeper.ts:701-748](../../../packages/gatekeeper/src/gatekeeper.ts#L701-L748)).
  Rust never calls `get_block` during resolution. Any consumer reading
  `didDocumentMetadata.timestamp` will see it **missing** from Rust output but
  **populated** on TS output for DIDs with block‑registered updates. This is a
  resolved‑document contract break for BTC‑anchored registries.
- **`didResolutionMetadata.retrieved`** — TS emits millisecond-precision
  `new Date().toISOString()`; Rust emits `rfc3339_opts(Millis, true)`
  ([store.rs:239-244](src/store.rs#L239-L244)). Both look like
  `2026-04-12T10:11:12.345Z`. OK.
- **TS strips deprecated `@context`, `didDocumentRegistration.opid`, and
  `didDocumentRegistration.registration` before returning**
  ([gatekeeper.ts:848-853](../../../packages/gatekeeper/src/gatekeeper.ts#L848-L853)).
  Rust never inserts `@context` in the outer doc, but also does not strip
  `opid`/`registration` from `didDocumentRegistration` if the stored
  registration contained them. In practice the Rust stored registration is
  whatever the create payload supplied, so if callers previously relied on
  this scrub they'll see those keys pass through.
- **`versionSequence`** is serialized as a string (`.to_string()`) in Rust
  ([resolver.rs:177](src/resolver.rs#L177), [store.rs:1709](src/store.rs#L1709)),
  matching TS's string form. Good.

### 3.3 Create / update / delete

[events.rs:126-260](src/events.rs#L126-L260) handles `POST /api/v1/did`:

- Verifies → generates DID (create) or reads `operation.did` (update/delete) →
  resolves current registry → checks supported registries → appends an event
  with `registry:"local"` ordinal `[0]`. Matches TS [gatekeeper.ts:540-903](../../../packages/gatekeeper/src/gatekeeper.ts#L540-L903).
- `event.time` for create uses `operation.created` (matches TS). For
  update/delete uses `proof.created`, else `created`, else empty string
  ([events.rs:201-207](src/events.rs#L201-L207)). TS only considers
  `proof.created` — Rust's extra fallbacks are additive but produce different
  behaviour if the caller omitted `proof.created`.
- Uses per‑DID tokio mutex ([events.rs:262-278](src/events.rs#L262-L278)) ≈ TS
  `withDidLock`.

### 3.4 Event import / processing

[events.rs:317-745](src/events.rs#L317-L745) implements `importBatch` and
`processEvents`:

- `ADDED`/`MERGED`/`REJECTED`/`DEFERRED` state machine matches TS
  ([gatekeeper.ts:987-1105](../../../packages/gatekeeper/src/gatekeeper.ts#L987-L1105)).
- **Empty batch divergence:** TS throws `InvalidParameterError('batch')` when
  `batch.length < 1` ([gatekeeper.ts:1278-1281](../../../packages/gatekeeper/src/gatekeeper.ts#L1278-L1281)).
  Rust accepts empty arrays and returns zero‑counts ([events.rs:317-365](src/events.rs#L317-L365)).
- **`eventsSeen` key** uses `${registry}/${proofValue}` in both. OK.
- **Queue persistence divergence:** TS holds `this.eventsQueue` in RAM. Rust
  stores it in `JsonDbFile.import_queue` ([store.rs:1014-1032](src/store.rs#L1014-L1032))
  — but the field is `#[serde(skip)]` ([store.rs:34-35](src/store.rs#L34-L35))
  so it's also effectively RAM‑only. Matches TS behaviour.
- `processEvents` busy‑lock and loop‑until‑idempotent match TS. Rust does not
  reset the queue on error (TS does: `this.eventsQueue = []` in catch). Minor.

### 3.5 Types / JSON field parity

All TS interfaces from `packages/gatekeeper/src/types.ts` are mapped into
Rust. Field‑name preservation:

- `EventRecord` ([store.rs:18-29](src/store.rs#L18-L29)) mirrors `GatekeeperEvent`.
- `ProcessEventsResult` ([events.rs:32-43](src/events.rs#L32-L43)) uses
  `skip_serializing_if = "Option::is_none"` so fields are omitted when unset
  — matches TS's loose `{busy:true}` or `{added,merged,rejected,pending}`.
- `CheckDidsResult` ([resolver.rs:15-36](src/resolver.rs#L15-L36)) — explicit
  `#[serde(rename = "byType")]` etc. preserves camelCase. Field names match
  TS `CheckDIDsResult`.
- **`VerifyDbResult`** fields (`total, verified, expired, invalid`) match TS.

Noted: [PORT_CHECKLIST.md:33](PORT_CHECKLIST.md#L33) still lists
"Preserve JSON field names and optionality exactly" as **unchecked**. Concrete
remaining gap: `EventRecord.ordinal` is `Option<Vec<u64>>` ([store.rs:23](src/store.rs#L23))
but TS `GatekeeperEvent.ordinal` is `number[]` (typed as required on the
wire via JSON Schema in the swagger docs, but optional in the TS interface).
Acceptable given TS fixtures sometimes omit `ordinal`.

---

## 4. Storage backends

Rust combines all four backends into one `JsonDb` struct with a `DbBackend`
enum ([store.rs:44-66](src/store.rs#L44-L66)). Each backend method dispatches
at runtime.

### 4.1 Filenames and paths (**breaking**)

| Backend | TS path | Rust path | Status |
| --- | --- | --- | :---: |
| JSON | `data/archon.json` | `data/archon.json` | **OK** |
| SQLite | `data/archon.db` | `data/archon.sqlite` | **MISMATCH** |
| Redis | `archon/*` namespace | `archon/*` namespace | **OK** |
| MongoDB | `archon` database | `archon` database | **OK** |

The SQLite filename change ([store.rs:1742](src/store.rs#L1742)) means a
container swapping the Rust image onto an existing mounted volume will see
an empty database. Either rename the Rust default to `archon.db` or add a
`ARCHON_GATEKEEPER_SQLITE_PATH` knob.

### 4.2 Redis keyspace

Key templates match TS exactly:

| Purpose | TS template | Rust template |
| --- | --- | --- |
| DID events | `${dbName}/dids/${suffix}` | `{namespace}/dids/{suffix}` |
| Operation | `${dbName}/ops/${opid}` | `{namespace}/ops/{opid}` |
| Queue | `${dbName}/registry/${registry}/queue` | `{namespace}/registry/{registry}/queue` |
| Block | `${dbName}/registry/${registry}/blocks/${hash}` | `{namespace}/registry/{registry}/blocks/{hash}` |
| Height map | `${dbName}/registry/${registry}/heightMap` | `{namespace}/registry/{registry}/heightMap` |
| Max height | `${dbName}/registry/${registry}/maxHeight` | `{namespace}/registry/{registry}/maxHeight` |

- `dbName` = `"archon"` (hardcoded in [gatekeeper-api.ts:98](../../../services/gatekeeper/server/src/gatekeeper-api.ts#L98)).
- `namespace` = `"archon"` (hardcoded in [store.rs:1747](src/store.rs#L1747)).

Operation stripping on write and hydration on read (`redis_event_to_stored_value`
/ `hydrate_redis_event`, [store.rs:213-237](src/store.rs#L213-L237)) mirror
TS. The Redis `clearQueue` Lua script in Rust is an exact byte copy of TS's
([store.rs:1185-1209](src/store.rs#L1185-L1209) vs [redis.ts:204-229](../../../packages/gatekeeper/src/db/redis.ts#L204-L229)).

`DbBackend::load_state` **never pulls the Redis data into memory**
([store.rs:1772](src/store.rs#L1772)), so every read acquires the redis
connection mutex and hits the network. Matches TS behaviour (TS always queries
Redis too). OK.

**Concurrent Redis writes use a single `StdMutex<redis::Connection>`.** TS's
`runExclusive` queue is per-instance and async‑friendly; Rust's std Mutex
blocks the whole tokio task while holding it (`with_redis_connection` is a
sync closure). Under load this will serialize all Redis IO onto whichever
tokio worker happens to be running — potential throughput regression but not
a correctness issue.

### 4.3 SQLite

Schema matches TS ([store.rs:1859-1906](src/store.rs#L1859-L1906)):

- `dids(id PK, events TEXT)` — matches.
- `queue(id PK, ops TEXT)` — matches.
- `blocks(registry, hash, height, time TEXT, txns INTEGER, PK(registry, hash))` +
  unique index on `(registry, height)` — matches.
- `operations(opid PK, operation TEXT)` — matches.

**Gaps:**

- **`add_block` writes `txns = 0_i64` literally** ([store.rs:1325](src/store.rs#L1325)),
  regardless of what the incoming block contained. TS writes the provided
  `txns`. If any downstream consumer reads `txns` from the blocks table they
  will see `0` from Rust‑written rows.
- **No transactions.** TS wraps `addEvent`/`setEvents` in `BEGIN IMMEDIATE …
  COMMIT` and serialises via a single‑promise lock. Rust opens a fresh
  `Connection` for each operation ([store.rs:1852-1858](src/store.rs#L1852-L1858)) and
  uses implicit auto‑commit. Concurrent writers can interleave an event
  insertion with the DID `setEvents` overwrite. Under single‑writer assumption
  this is fine, but TS gave stronger guarantees.
- **No connection pooling.** Opening a fresh sqlite connection every call is
  expensive. Functional but slow.

### 4.4 MongoDB

Indexes match TS (`dids.id`, `blocks.(registry, height)` unique,
`blocks.(registry, hash)` unique, `operations.opid` unique — [store.rs:1773-1807](src/store.rs#L1773-L1807)).
Collection names (`dids`, `queue`, `operations`, `blocks`) match.

**Gaps:**

- `add_block` serialises the block via `bson::to_document` then **overwrites
  `registry`** — TS inserts only the BlockInfo fields into the document. For
  hash-based lookups this is equivalent. `get_block` decodes back to JSON and
  may include the `_id` BSON ObjectId the driver inserts on upsert — verify
  the response shape matches TS strictly.
- Blocking `mongodb::sync::Client` is opened per call ([store.rs:319-324](src/store.rs#L319-L324))
  — TS uses a persistent client. Performance regression.
- `get_operation` strips `_id` and `opid` via projection ([store.rs:1005](src/store.rs#L1005))
  — correct.

### 4.5 JSON backend

[store.rs:1760-1766](src/store.rs#L1760-L1766) loads `archon.json` and holds
it in memory; every mutation calls `save()` which pretty‑prints with 4 spaces
— *but Rust uses `to_string_pretty`* ([store.rs:1813](src/store.rs#L1813))
which defaults to 2 spaces. TS writes with `JSON.stringify(db, null, 4)`
([json.ts:26](../../../packages/gatekeeper/src/db/json.ts#L26)). On‑disk file
is functionally equivalent but byte‑different — any diff‑based tests or
backup tooling that compares file contents will see churn.

`JsonDbFile` fields (`dids`, `queue`, `blocks`, `ops`) match the
`JsonDbFile` interface in types.ts. `hashes` field that TS types declare
optionally is not ported — Rust will silently drop it on save/load. Low risk
because nothing writes `hashes`, but it's a field‑parity gap.

---

## 5. Search, metrics, config, loops

### 5.1 Search index

[search_index.rs](src/search_index.rs) ports `searchDocs` / `queryDocs`:

- Indexes only `didDocumentData` — matches TS.
- `searchDocs` does a substring JSON‑string scan — matches TS.
- `queryDocs` supports `$in` with the same JSON‑path dialect:
  `a.b`, `a.b.*`, `a.b.*.c`, `a.b[*]`, `a.b[*].c` — matches TS.
- **Result ordering**: both `searchDocs` and `queryDocs` sort the output
  alphabetically ([search_index.rs:42](src/search_index.rs#L42), [search_index.rs:61](src/search_index.rs#L61)).
  TS preserves insertion order (Map iteration order). Any fixture that
  compares exact arrays will fail on Rust.
- `query_docs` returns `Ok([])` when `where` is empty — matches TS.
- `query_docs` errors when `$in` is missing → `anyhow` Err at
  `api.rs`, which returns **500** with `{error:…}`. TS **throws** then
  Express catches → 500. Route-level 400 is not produced here; OK to match.

### 5.2 Metrics

Metric **names** ([metrics.rs:102-134](src/metrics.rs#L102-L134)):

- `http_requests_total {method, route, status}` ✓
- `http_request_duration_seconds {method, route, status}` — buckets match TS
  (`0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5`). ✓
- `did_operations_total {operation, registry, status}` ✓
- `events_queue_size {registry}` ✓
- `gatekeeper_dids_total` (Gauge) ✓
- `gatekeeper_dids_by_type {type}` ✓
- `gatekeeper_dids_by_registry {registry}` ✓
- `service_version_info {version, commit}` ✓

**Route label divergence (contract break).** TS `normalizePath` is invoked
with `req.path`, which is the full path including `/api/v1`. Resulting labels
are `/api/v1/did/:did` etc., as specified in
[COMPATIBILITY_CONTRACT.md:140-148](COMPATIBILITY_CONTRACT.md#L140-L148).

Rust `record_metrics` call sites pass the **bare** suffix (`"/did/:did"`,
`"/dids/"`, `"/status"`, …, [api.rs:59](src/api.rs#L59) and throughout). So
the emitted labels are:

- TS: `route="/api/v1/did/:did"`
- Rust: `route="/did/:did"`

Grafana dashboards and Prometheus alert rules that match `route=~"^/api/v1/"`
will not match the Rust output. **Prefix each recorded route with
`/api/v1`** (or have the handlers pass `request.uri().path()` to
`record_metrics` + rely on `normalize_path`).

Aside: the `not_found` handler does call `normalize_path(uri.path())` so 404s
*do* contain the `/api/v1` prefix, meaning labels are inconsistent
between 2xx and 4xx responses today.

**Default Node metrics not present.** TS calls
`promClient.collectDefaultMetrics`, exposing `process_cpu_seconds_total`,
`nodejs_heap_size_total_bytes`, etc. Rust does not emit any process/runtime
metrics. The contract only pins the custom metrics, so not a violation — but
existing dashboards showing `process_*` metrics will go blank.

### 5.3 Config

[config.rs:27-72](src/config.rs#L27-L72) covers every env var from
[COMPATIBILITY_CONTRACT.md:69-84](COMPATIBILITY_CONTRACT.md#L69-L84).
Defaults align. Extra knobs in Rust not in TS contract:

- `ARCHON_DATA_DIR` (default `data`) — used for JSON / SQLite paths.
- `ARCHON_GATEKEEPER_VERSION` — overrides the hard-coded `"0.7.0"` fallback.
- `ARCHON_REDIS_URL`, `ARCHON_MONGODB_URL` — TS reads these too, so parity.
- `ARCHON_GATEKEEPER_IMPORT_TRACE` — debug-only, no wire impact.

Config gaps:

- `json_limit` parsed but not wired into the router (see §1.2).
- Default registries in Rust fall back to `["local","hyperswarm"]` when
  `ARCHON_GATEKEEPER_REGISTRIES` is unset/empty ([config.rs:46-47](src/config.rs#L46-L47))
  — matches TS's Gatekeeper constructor default. OK.
- `max_queue_size` hard‑coded to 100 ([config.rs:64](src/config.rs#L64))
  — matches TS's `maxQueueSize` default.

### 5.4 Maintenance loops

[resolver.rs:525-557](src/resolver.rs#L525-L557) replicates the TS status
and GC loops. Structural notes:

- **Both status and GC loops start with an initial delay** equal to the
  configured interval. TS's `setTimeout(gcLoop, interval)` does the same for
  GC. For status, TS calls `reportStatus()` **once at boot** then
  `setInterval(reportStatus, interval)`; Rust calls `log_status_snapshot`
  once at boot ([app.rs:63](src/app.rs#L63)) then starts the interval. OK.
- **GC loop order differs.** TS runs `verifyDb` then `checkDIDs`
  ([gatekeeper-api.ts:2217-2226](../../../services/gatekeeper/server/src/gatekeeper-api.ts#L2217-L2226)).
  Rust runs `verify_db_impl` then `refresh_metrics_snapshot` (which calls
  `check_dids_impl`). Functionally the same.
- **`ready` latch.** Rust sets `state.ready.store(true)` immediately before
  `axum::serve` ([app.rs:104](src/app.rs#L104)). TS sets `serverReady = true`
  *after* the HTTP server announces it is listening ([gatekeeper-api.ts:2411](../../../services/gatekeeper/server/src/gatekeeper-api.ts#L2411)).
  Rust flips ready *before* the listener starts accepting — effectively the
  same because `axum::serve` is synchronous up to the bind, but the race
  window for probe traffic is marginally different.

---

## 6. Container / deployment

- Port default `4224` ✓
- Bind default `0.0.0.0` ✓
- `ARCHON_DATA_DIR=data` default ✓
- Admin header name ✓
- `GIT_COMMIT` truncated to 7 chars ([config.rs:65-69](src/config.rs#L65-L69)) ✓

Gaps: see SQLite filename (§4.1) and CORS (§1.2).

---

## 7. Prioritised punch list

### Must fix before cutover

1. **Add CORS middleware** to the Rust router so browser clients keep working.
2. **Apply `config.json_limit`** as a body limit on the `/api/v1` router.
3. **Prefix metric route labels with `/api/v1`** so existing dashboards and
   alerting match.
4. **Rename SQLite file to `archon.db`** (or load both filenames) so existing
   volumes keep working.
5. **Fix `/api/v1/queue/:registry/clear` response** — return the remaining
   queue array, not `true`.
6. **Wire `config.version`** from build metadata (or read `package.json` /
   `Cargo.toml` via a build script) so `/version` and `service_version_info`
   are accurate.
7. **Reject empty `importBatch` and missing `importBatchByCids` metadata** with
   500 to match TS error surface.

### Should fix

8. **Populate `didDocumentMetadata.timestamp`** from the block store during
   resolve — BTC/signet/testnet consumers depend on it.
9. **Stop forwarding query params to the universal resolver fallback.**
10. **Preserve insertion order in `searchDocs` and `queryDocs` results**, or
    add a stable tie‑breaker TS already has.
12. **Write the real `txns` value into the SQLite `blocks.txns` column.**
13. **Use a persistent Mongo/SQLite connection** (pool or long‑lived) to
    match TS performance.
14. **Install a graceful‑shutdown handler** (SIGTERM/SIGINT) that closes DB
    connections cleanly.

### Nice to have

15. Emit Rust process metrics (`process_*`) via `prometheus::process_collector`
    so dashboards don't blank out.
16. Use `serde_json::to_string_pretty` with 4‑space indent (or custom
    formatter) to match TS on‑disk JSON byte-for-byte.
17. Strip `didDocumentRegistration.opid` and `didDocumentRegistration.registration`
    on resolve output, as TS does.
18. Match TS's SIGTERM/SIGINT handling and structured log keys so operator
    tooling (alerts on `error` text) keeps working.

---

## Appendix A — Files audited

- TS sources: [gatekeeper-api.ts](../../../services/gatekeeper/server/src/gatekeeper-api.ts),
  [config.js](../../../services/gatekeeper/server/src/config.js),
  [gatekeeper.ts](../../../packages/gatekeeper/src/gatekeeper.ts),
  [types.ts](../../../packages/gatekeeper/src/types.ts),
  [search-index.ts](../../../packages/gatekeeper/src/search-index.ts),
  [db/json.ts](../../../packages/gatekeeper/src/db/json.ts),
  [db/abstract-json.ts](../../../packages/gatekeeper/src/db/abstract-json.ts),
  [db/redis.ts](../../../packages/gatekeeper/src/db/redis.ts),
  [db/sqlite.ts](../../../packages/gatekeeper/src/db/sqlite.ts),
  [db/mongo.ts](../../../packages/gatekeeper/src/db/mongo.ts).
- Rust sources: [src/api.rs](src/api.rs), [src/app.rs](src/app.rs),
  [src/config.rs](src/config.rs), [src/events.rs](src/events.rs),
  [src/lib.rs](src/lib.rs), [src/metrics.rs](src/metrics.rs),
  [src/proofs.rs](src/proofs.rs), [src/resolver.rs](src/resolver.rs),
  [src/search_index.rs](src/search_index.rs), [src/store.rs](src/store.rs).
- Reference docs: [COMPATIBILITY_CONTRACT.md](COMPATIBILITY_CONTRACT.md),
  [PORT_CHECKLIST.md](PORT_CHECKLIST.md).
