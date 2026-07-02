# Archon Drawbridge — Service Specification

Language-agnostic contract for **Drawbridge** — the public-facing API
gateway that fronts the [Gatekeeper](../gatekeeper/README.md), the
[Lightning mediator](../mediators/lightning/README.md), the
[Herald](../herald/README.md) name service, and the
[DIDComm relay](../didcomm/README.md). It enforces an
[L402](https://docs.lightning.engineering/the-lightning-network/l402)
("Lightning HTTP 402") paywall and a subscription-credential
alternative on every protected route, then proxies the request upstream.

The canonical implementation is
[services/drawbridge/server/](../../../services/drawbridge/server/).

> **Related specs.** Drawbridge is a thin proxy. The behaviour of every
> protected endpoint is the same as the corresponding Gatekeeper /
> Lightning-mediator / Herald endpoint — read those specs for the
> downstream contract. This document covers only what Drawbridge adds
> on top: the L402 challenge/response, subscription auth, per-operation
> pricing, rate limiting, and the route prefix layout.

---

## 1. Service responsibilities

The Drawbridge sits on the public network edge of an Archon node. It
has three jobs:

1. **Gate access.** Every read/write request to the gatekeeper and
   lightning-mediator is challenged with one of two mutually-exclusive
   auth schemes:
   - **L402** — clients pay a small Lightning invoice, receive a
     macaroon-bearer-token pair, and present it on subsequent calls.
   - **Subscription** — clients present a `X-Subscription-DID` header
     proving they hold a valid subscription credential issued by this
     deployment's owner; no payment per request.
2. **Proxy upstream.** Authenticated calls to gatekeeper-shaped routes
   (`/api/v1/did`, `/dids`, `/ipfs/*`, `/block/*`, `/search`, `/query`)
   are forwarded to the local Gatekeeper. Lightning routes are
   forwarded to the local Lightning mediator. Herald routes
   (`/.well-known/*`, `/names/*`) are forwarded to the local Herald. The
   DIDComm relay is fronted at `/didcomm/*` (not paywalled — DIDComm has
   its own signed-challenge auth).
3. **Public surface for the Lightning + name layers.** A few unprotected
   endpoints exist for clients that need to learn about the node before
   authenticating: `/ready`, `/version`, `/status`, `/capabilities`,
   `/didcomm-endpoint`, `/invoice/:did`, the Herald well-known endpoints.

### Optional services

DIDComm, Lightning, and Herald name resolution are **optional** — a node
may not deploy them. Each is "offered" iff its downstream URL is
configured (see [§8.2](#82-environment-variables)); an operator opts a
service *out* by setting its URL **empty** (e.g. `ARCHON_DIDCOMM_URL=`).
When a service is off:

- `GET /api/v1/capabilities` reports it `false`, and
- its proxy mount (`/didcomm`, `/api/v1/lightning`, `/invoice/:did`,
  `/names`) returns **HTTP 501** `{ "error": "<service> is not enabled
  on this node" }` rather than proxying to an absent upstream.

Clients (e.g. keymaster) read the manifest once and fail fast with a
clear message instead of discovering absence via a transport error.

It carries no key material. The macaroon root secret
(`ARCHON_DRAWBRIDGE_MACAROON_SECRET`) is the only sensitive material on
disk; it MUST be ≥ 32 characters and is used only to sign + verify the
service's own macaroons (HMAC-SHA-256 internal to macaroons.js).

---

## 2. HTTP API contract

Binds to `${ARCHON_BIND_ADDRESS}:${ARCHON_DRAWBRIDGE_PORT}` (default
`0.0.0.0:4222`).

### 2.1 Public routes (no auth)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/ready` | Returns `<bool>` — proxies upstream Gatekeeper readiness. `false` on connect failure. |
| `GET` | `/api/v1/version` | `{ version, commit }` (commit is `GIT_COMMIT` sliced to 7 chars; the sentinel string `"unknown"` is returned when `GIT_COMMIT` is unset). |
| `GET` | `/api/v1/capabilities` | `{ didcomm, lightning, names }` — which optional services this node offers (each `true` iff its downstream URL is configured). Reflects node *intent* (config), not live health. See [Optional services](#optional-services). |
| `GET` | `/api/v1/status` | `{ service: "drawbridge", upstream: GatekeeperStatus, uptime: <seconds>, memoryUsage: <node memUsage> }`. HTTP 502 if Gatekeeper is unreachable. |
| `GET` | `/api/v1/didcomm-endpoint` | `{ endpoint: <string\|null> }` — this node's public DIDComm relay endpoint for `publish-didcomm` auto-discovery: `<ARCHON_DRAWBRIDGE_PUBLIC_HOST>/didcomm`, else the Tor onion fronting this node, else `null`. |
| `POST` | `/api/v1/l402/pay` | Final step of L402 flow. Body: `{ paymentHash }`. Marks the matching macaroon as paid + returns the bearer credential. See [§4.4](#44-payment-completion). |
| `GET` | `/invoice/:did` | Forwarded to lightning-mediator's `/invoice/:did`. Returns `{ paymentRequest, paymentHash, ... }`. Used by external zappers to pay any DID that has published a Lightning service. **501** if Lightning is disabled. |
| `*` | `/didcomm/**` | Forwarded to the local DIDComm relay (path prefix `/didcomm` stripped). Carries the relay's own routes (mailbox `messages/*`, signed-`challenge`, egress `deliver`). Not paywalled — DIDComm authenticates with its own signed challenge. **501** if DIDComm is disabled. `application/didcomm-encrypted+json` bodies are captured as text and forwarded verbatim. |
| `GET` | `/.well-known/*` | Forwarded to Herald (e.g. `lnurlp/<name>`, `webfinger`, `names`). |
| `GET\|POST\|PUT\|DELETE` | `/names/*` | Forwarded to Herald (`/api/*`). **501** if name resolution is disabled. |
| `*` | `/1.0/identifiers/**` | Forwarded verbatim to the Gatekeeper's standards-conformant DID resolution / dereferencing surface (`/1.0/identifiers/:did`, `/:did/data`, `/:did/registration`; see [Gatekeeper spec §2.6](../gatekeeper/README.md)). **Not paywalled** — public DID resolution for interop with universal resolvers, which do not speak L402. Proxied unchanged (no prefix stripped), so the Gatekeeper's resolution triple, raw dereferenced resources, and status/error shapes pass through intact. |
| `GET` | `/metrics` | Prometheus exposition. |

### 2.2 L402 admin routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/l402/status` | Returns service-level L402 status: `{ enabled, lightning, pricing: [<operationKey>, ...] }`. |
| `POST` | `/api/v1/l402/revoke` | Body: `{ macaroonId: <macaroonId> }`. Revokes the macaroon (subsequent verifications return invalid). |
| `GET` | `/api/v1/l402/payments/:did` | List of `PaymentRecord` for the DID. |

All admin routes require the `X-Archon-Admin-Key` header. When the
server `ARCHON_ADMIN_API_KEY` is unconfigured (empty), admin routes
return HTTP 403 `{ "error": "Admin API key not configured" }`. When
configured, a missing or mismatched client header returns HTTP 401.
Constant-time comparison is used.

### 2.3 Authenticated proxy routes

The following all require auth (subscription header **or** valid L402
bearer). On 402 challenge, the response is HTTP 402 with a
`WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"` header
and a JSON body with the same fields.

Each route is a 1:1 forward to the upstream Gatekeeper after auth
passes; the response shape is identical to the Gatekeeper's. See the
[Gatekeeper spec §2](../gatekeeper/README.md#2-http-api-contract) for
each route's contract.

| Method | Path |
| --- | --- |
| `GET` | `/api/v1/registries` |
| `POST` | `/api/v1/did` |
| `POST` | `/api/v1/did/generate` |
| `GET` | `/api/v1/did/:did` (forwards `versionTime`/`versionSequence`/`confirm`/`verify` query params) |
| `POST` | `/api/v1/dids` |
| `POST` | `/api/v1/dids/export` |
| `POST/GET` | `/api/v1/ipfs/json[/:cid]` |
| `POST/GET` | `/api/v1/ipfs/text[/:cid]` |
| `POST/GET` | `/api/v1/ipfs/data[/:cid]` |
| `POST/GET` | `/api/v1/ipfs/stream[/:cid]` (true streaming both directions; no body buffering) |
| `GET` | `/api/v1/block/:registry/latest` |
| `GET` | `/api/v1/block/:registry/:blockId` |
| `GET` | `/api/v1/search?q=` |
| `POST` | `/api/v1/query` |

Plus a wildcard mount of all Lightning routes, forwarded to the
Lightning mediator:

| Method | Path |
| --- | --- |
| `*` | `/api/v1/lightning/**` |

The path tail is appended onto the upstream URL untouched. See the
[Lightning mediator spec](../mediators/lightning/README.md).

### 2.4 Body limits

Global Express limits (`json`, `urlencoded`, `text`, `raw` for
`application/octet-stream`): **10 MB** each. A dedicated `text` parser
for `application/didcomm-encrypted+json` (also 10 MB) captures DIDComm
envelopes so they survive proxying to the relay byte-for-byte. The IPFS
stream POST (`/api/v1/ipfs/stream`) explicitly bypasses the raw parser
so the upstream Kubo client can stream the request body directly.

### 2.5 CORS

- Default routes: `cors()` with permissive defaults (any origin, no
  credentials).
- Herald-bound routes (`/.well-known/*`, `/names/*`): `cors({ origin:
  true, credentials: true })` — required for browser flows that depend
  on session cookies (Herald login, OAuth/OIDC).

### 2.6 Error envelope

All error responses are `application/json` `{ "error": "<message>" }`
unless a downstream proxy returned its own body verbatim. Standard
status codes:

- `401` — auth header malformed or admin key wrong
- `402` — L402 challenge (with `WWW-Authenticate` header)
- `403` — admin not configured / scope insufficient
- `429` — rate-limited
- `501` — the requested optional service (DIDComm / Lightning / names) is not enabled on this node
- `502` — upstream Gatekeeper / Lightning / Herald / DIDComm unreachable
- `503` — Lightning service unavailable (L402 invoice creation failed)

### 2.7 Route-normalization for metrics

The `route` label is the request path with dynamic segments collapsed:

```
/did/<did>                 -> /did/:did
/invoice/<did>             -> /invoice/:did
/ipfs/json/<cid>           -> /ipfs/json/:cid
/ipfs/text/<cid>           -> /ipfs/text/:cid
/ipfs/data/<cid>           -> /ipfs/data/:cid
/ipfs/stream/<cid>         -> /ipfs/stream/:cid
/queue/<registry>          -> /queue/:registry
/block/<registry>/latest   -> /block/:registry/latest
/block/<registry>/<id>     -> /block/:registry/:blockId
/payments/<did>            -> /payments/:did
```

The label does NOT include the `/api/v1` prefix.

---

## 3. Authentication

Two parallel auth schemes; either one passes the request through. Both
are evaluated in this order on every protected route:

1. **Subscription auth** (cheap, header-only). If the request carries a
   `X-Subscription-DID` header containing a DID that resolves to an
   asset the deployment owner has issued as a subscription credential,
   the request is marked authenticated and proceeds.

2. **L402 auth** (paid). If subscription auth didn't apply, the L402
   middleware looks for an `Authorization: L402 <macaroon>:<preimage>`
   header. If valid, proceeds. Otherwise, issues a 402 challenge.

If `ARCHON_DRAWBRIDGE_L402_ENABLED=false`, the auth middleware chain
is empty and all proxy routes are open. This is intentional for
private / single-tenant deployments.

### 3.1 Bypass routes

The L402 middleware (mounted on the `/api/v1` router) has a hard-coded
bypass list for paths that should never be paywalled. Paths are matched
against the request path with the `/api/v1` prefix stripped:

- Exact matches (any method): `/ready`, `/version`, `/status`, `/metrics`, `/capabilities`, `/didcomm-endpoint`
- Prefix matches (any method): anything under `/l402/`
- GET-only prefix matches: anything under `/did/` or `/ipfs/`

(Auth is also applied per-route — only the protected proxy routes spread
the auth middleware into their handler chain — so the public routes
above carry no auth regardless; the bypass list is belt-and-suspenders.)

All other routes are handled outside this router and so are not subject
to the L402 middleware at all (e.g. `/invoice/:did`, `/didcomm/*`,
`/.well-known/*`, `/names/*`).

Implementations MUST honor this list — clients depend on at least
`/ready`, `/version`, and the GET DID/IPFS read paths being free.

---

## 4. L402 protocol

The L402 protocol is a Lightning-paid HTTP authentication scheme. The
Drawbridge implements a slight variant compatible with
[macaroons.js](https://github.com/nitram509/macaroons.js):

### 4.1 Challenge

When auth fails on a protected route, Drawbridge:

1. Determines the operation key (e.g. `resolveDID`, `getDIDs`) by
   matching the route to the pricing config (see [§5](#5-pricing)).
2. Looks up the price (in sats) for that operation, falling back to
   `ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS` (default 10).
3. Asks the Lightning mediator's `POST /api/v1/l402/invoice` to create
   a CLN invoice for that amount.
4. Generates a fresh macaroon ID (16 random bytes hex) and builds a
   macaroon with these caveats:
   - `did = <header X-DID or empty>`
   - `scope = <operation key>`
   - `expiry = <now + ARCHON_DRAWBRIDGE_INVOICE_EXPIRY seconds>` (default 3600)
   - `payment_hash = <invoice payment hash>`
5. Persists the pending macaroon record via `POST /api/v1/l402/pending`
   on the Lightning mediator (the mediator owns the key-value store
   for invoice → macaroon lookup).
6. Returns:
   - HTTP 402
   - `WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"`
   - JSON body `{ macaroon, invoice }` for clients that don't parse
     the header.

### 4.2 Macaroon format

Macaroons are built with [macaroons.js](https://github.com/nitram509/macaroons.js)
and serialized with the library's default (binary, base64-wrapped).
Caveats are encoded as plain text strings of the form `<key> = <value>`:

```
did = did:cid:bagaaiera...
scope = resolveDID
expiry = 1726700000
max_uses = 100
payment_hash = abc123...
```

Implementations SHOULD use a macaroons.js-compatible library
(macaroons.py, libmacaroons, macaroon-rs, etc.). A minimal
custom implementation MUST:

- Use HMAC-SHA-256 with `rootSecret = ARCHON_DRAWBRIDGE_MACAROON_SECRET`
  as the keyed-MAC primitive.
- Serialize per [the macaroons protocol v1](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/).
- Include the location string `http://localhost:<port>` (yes, even on
  remote servers — the location is informational, not a routing hint).

### 4.3 Token redemption

Clients pay the invoice, retrieve the preimage from their Lightning
wallet, and resubmit:

```
Authorization: L402 <base64-macaroon>:<hex-preimage>
```

Drawbridge's L402 middleware:

1. Splits on `:`.
2. Verifies `sha256(preimage) == payment_hash` from the macaroon
   caveats.
3. Verifies the macaroon signature against `rootSecret`.
4. Checks each caveat is satisfied:
   - `did` matches the request's `X-DID` (or empty).
   - `scope` matches the operation key for the requested route.
   - `expiry > now`.
   - `currentUses < maxUses` (incremented on every accepted request).
   - `payment_hash` matches the now-verified preimage.
5. Looks up the persisted macaroon record; rejects if revoked.
6. Allows the request to proceed; on the response `finish` event, if
   the upstream status was `< 500`, increments `currentUses` in the
   store.

On any failure: HTTP 401 with a fresh 402 challenge.

### 4.4 Payment completion

`POST /api/v1/l402/pay` exists for a polling flow where the client wants
Drawbridge to confirm the payment server-side rather than presenting
the credential immediately:

1. Body: `{ paymentHash }`. (Any `preimage` in the body is IGNORED.)
2. Drawbridge fetches the pending macaroon record via the Lightning
   mediator (`GET /api/v1/l402/pending/:paymentHash`).
3. Fetches the preimage server-side from the Lightning mediator
   (`/api/v1/l402/check`) and verifies it matches the payment hash.
4. Persists the macaroon record (now no longer "pending").
5. Records the payment in the store.
6. Deletes the pending entry on the Lightning mediator.
7. Returns `{ macaroonId, macaroon, paymentHash, method, amountSat, preimage }`.

---

## 5. Pricing

Per-operation prices are loaded at startup. Only two individual
operations have dedicated environment-variable overrides:

- `ARCHON_DRAWBRIDGE_PRICE_CREATE_DID` — sats for `createDID`
  (accepts `>= 0`).
- `ARCHON_DRAWBRIDGE_PRICE_RESOLVE_DID` — sats for `resolveDID`
  (must be `> 0`).

For any other operation, set the JSON override
`ARCHON_DRAWBRIDGE_PRICING` (see [§8.2](#82-environment-variables)).
The full set of operation keys (used by the route-to-scope mapper):

| Key | Routes |
| --- | --- |
| `resolveDID` | `GET /did/:did` |
| `createDID` | `POST /did` |
| `generateDID` | `POST /did/generate` |
| `getDIDs` | `POST /dids` |
| `exportDIDs` | `POST /dids/export` |
| `importDIDs` | `POST /dids/import` |
| `removeDIDs` | `POST /dids/remove` |
| `exportBatch` | `POST /batch/export` |
| `importBatch` | `POST /batch/import` |
| `importBatchByCids` | `POST /batch/import/cids` |
| `getQueue` | `GET /queue/:registry` |
| `clearQueue` | `POST /queue/:registry/clear` |
| `processEvents` | `POST /events/process` |
| `listRegistries` | `GET /registries` |
| `searchDIDs` | `GET /search` |
| `queryDIDs` | `POST /query` |
| `getBlock` | `GET /block/:registry/:blockId` and `/latest` |
| `addBlock` | `POST /block/:registry` |
| `addJSON` | `POST /ipfs/json` |
| `getJSON` | `GET /ipfs/json/:cid` |
| `addText` | `POST /ipfs/text` |
| `getText` | `GET /ipfs/text/:cid` |
| `addData` | `POST /ipfs/data` |
| `getData` | `GET /ipfs/data/:cid` |

The IPFS streaming routes (`/ipfs/stream`, `/ipfs/stream/:cid`) have no
explicit scope entry and so fall through to the default price.

Any operation without an explicit price uses
`ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS`. `createDID` accepts a value of
`0` (free); `resolveDID` requires `> 0`. Other free operations must be
configured via the `ARCHON_DRAWBRIDGE_PRICING` JSON override or by
disabling L402 entirely.

---

## 6. Rate limiting

Per-DID sliding window stored in Redis. Request ledger key:
`drawbridge:ratelimit:<did>` (a sorted set of per-request members
scored by timestamp, TTL = `rateLimitWindow` seconds). Each
authenticated request adds an entry; if more than `rateLimitMax`
entries fall in the last `rateLimitWindow` seconds, the request is
rejected with HTTP
429 `{ "error": "Rate limit exceeded", "resetAt": <unix> }`.

Defaults: 100 requests / 60 seconds. Configured via:

- `ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX`
- `ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW`

Anonymous (unauthenticated) requests are rate-limited per-IP. The DID
used for rate-limiting is read from the `X-DID` request header (the L402
middleware also uses this header for the macaroon's `did` caveat).

---

## 7. Storage contract (Redis)

Namespace: `drawbridge:`. All values are JSON strings unless noted.

| Key | Type | TTL | Contents |
| --- | --- | --- | --- |
| `drawbridge:macaroon:<id>` | STRING | none | `MacaroonRecord` |
| `drawbridge:payment:<id>` | STRING | none | `PaymentRecord` |
| `drawbridge:payments:did:<did>` | SORTED SET | none | Payment IDs for that DID, scored by `createdAt` |
| `drawbridge:ratelimit:<did>` | SORTED SET | `windowSeconds` | Sliding-window members scored by request timestamp |

`MacaroonRecord`:

```jsonc
{
  "id":           "<hex>",
  "did":          "<DID or empty>",
  "scope":        ["resolveDID", ...],
  "createdAt":    <unix ms>,
  "expiresAt":    <unix ms>,
  "maxUses":      <int>,
  "currentUses":  <int>,
  "paymentHash":  "<hex>",
  "revoked":      <bool>
}
```

`PaymentRecord` — same shape as in the
[Lightning mediator spec §5](../mediators/lightning/README.md#5-redis-key-schema).

A new implementation MUST use this schema if the Redis instance is
shared with the reference TypeScript service.

---

## 8. Lifecycle and configuration

### 8.1 Startup

1. Read env. **Validate `ARCHON_DRAWBRIDGE_MACAROON_SECRET` is ≥ 32
   chars** — exit 1 on failure.
2. Connect to Gatekeeper (`waitUntilReady=true`, retry-with-backoff).
   Exit on persistent failure.
3. Initialize the Redis store.
4. Load the pricing config from env.
5. Build the auth middleware chain (subscription + L402, or empty if
   L402 disabled).
6. Register routes and start the HTTP listener.

### 8.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_DRAWBRIDGE_PORT` | `4222` | HTTP listen port. |
| `ARCHON_BIND_ADDRESS` | `0.0.0.0` | |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Upstream Gatekeeper. |
| `ARCHON_HERALD_URL` | `http://localhost:4230` | Upstream Herald (for `/.well-known/*` and `/names/*`). Set **empty** to disable name resolution (capability `names:false`, `/names` → 501). |
| `ARCHON_LIGHTNING_MEDIATOR_URL` | `http://localhost:4235` | Upstream for Lightning routes + L402 invoice/pending storage. Set **empty** to disable Lightning (capability `lightning:false`, `/lightning` + `/invoice/:did` → 501). |
| `ARCHON_DIDCOMM_URL` | `http://localhost:4236` | Upstream DIDComm relay proxied at `/didcomm`. Set **empty** to disable DIDComm (capability `didcomm:false`, `/didcomm` → 501). *The bundled compose defaults this **empty** (DIDComm is opt-in, off by default); enabling requires the `didcomm` profile **and** setting this URL.* |
| `ARCHON_DRAWBRIDGE_PUBLIC_HOST` | empty | Public base URL this node is reachable at (clearnet host or Tor onion). Used by `/didcomm-endpoint` to advertise `<host>/didcomm`. |
| `ARCHON_DRAWBRIDGE_TOR_HOSTNAME_FILE` | `/data/tor/hostname` | When `PUBLIC_HOST` is empty, `/didcomm-endpoint` falls back to the Tor onion read from this shared hidden-service hostname file. |
| `ARCHON_REDIS_URL` | `redis://localhost:6379` | Macaroon/payment/rate-limit store. |
| `ARCHON_ADMIN_API_KEY` | empty | Required for L402 admin routes. Empty → admin routes 403. |
| `ARCHON_DRAWBRIDGE_L402_ENABLED` | `false` | When `false`, all proxy routes open. |
| `ARCHON_DRAWBRIDGE_MACAROON_SECRET` | empty (**required**) | HMAC root secret. ≥ 32 chars. |
| `ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS` | `10` | Per-request price for unmapped operations. |
| `ARCHON_DRAWBRIDGE_INVOICE_EXPIRY` | `3600` | Macaroon expiry, seconds. |
| `ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX` | `100` | |
| `ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW` | `60` | Seconds. |
| `ARCHON_DRAWBRIDGE_PRICE_CREATE_DID` | unset | Sats price for `createDID` (accepts `>= 0`). |
| `ARCHON_DRAWBRIDGE_PRICE_RESOLVE_DID` | unset | Sats price for `resolveDID` (must be `> 0`). |
| `ARCHON_DRAWBRIDGE_PRICING` | unset | JSON pricing override; `{ "operations": { "<scope>": { "amountSat": <n>, "description": "..." } } }`. Merged on top of the per-operation env vars. |
| `GIT_COMMIT` | `unknown` | Build commit. |

> **Off-switch semantics.** The optional-service URLs
> (`ARCHON_DIDCOMM_URL`, `ARCHON_LIGHTNING_MEDIATOR_URL`,
> `ARCHON_HERALD_URL`) are read with `??`, not `||`: an **unset** var
> falls back to the default (service on), while an **explicitly empty**
> value disables the service. This is what drives `/capabilities` and
> the 501 gating.

### 8.3 Shutdown

SIGTERM/SIGINT → close HTTP listener → disconnect Redis → exit 0.

---

## 9. Prometheus metrics contract

| Metric | Type | Labels |
| --- | --- | --- |
| `drawbridge_http_requests_total` | counter | `method`, `route`, `status` |
| `drawbridge_http_request_duration_seconds` | histogram (buckets: `0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5`) | `method`, `route` |
| `drawbridge_l402_challenges_total` | counter | `did_known` (`"true"`/`"false"`) |
| `drawbridge_l402_verifications_total` | counter | `result` (`"success"`/`"failure"`) |
| `drawbridge_version_info` | gauge | `version`, `commit` |

Plus the standard Prometheus process metrics. Route normalization rules
in [§2.7](#27-route-normalization-for-metrics).

---

## 10. Logging conventions

`pino` at `LOG_LEVEL` (default `info`); HTTP via `pino-http` in
production or `morgan('dev')` otherwise. Errors logged as structured
`{ err }` objects with the upstream URL when a proxy call fails.

No log lines are contractual for downstream consumers.

---

## 11. Reference implementation and tests

- Source: [services/drawbridge/server/](../../../services/drawbridge/server/)
- Macaroon helpers: [src/macaroon.ts](../../../services/drawbridge/server/src/macaroon.ts)
- Auth middleware: [src/middleware/auth.ts](../../../services/drawbridge/server/src/middleware/auth.ts), [src/middleware/l402-auth.ts](../../../services/drawbridge/server/src/middleware/l402-auth.ts), [src/middleware/subscription-auth.ts](../../../services/drawbridge/server/src/middleware/subscription-auth.ts)
- Pricing: [src/pricing.ts](../../../services/drawbridge/server/src/pricing.ts)
- Rate limiter: [src/rate-limiter.ts](../../../services/drawbridge/server/src/rate-limiter.ts)
- Redis store: [src/store.ts](../../../services/drawbridge/server/src/store.ts)
- Image: `ghcr.io/archetech/drawbridge`
- Compose: [docker/compose/drawbridge.yml](../../../docker/compose/drawbridge.yml)

No dedicated unit tests. Validation is end-to-end via:

- The CLI test suite (which exercises a Drawbridge in front of the
  Gatekeeper container during PR builds).
- Manual L402 round-trips against a signet/regtest CLN node.

A conformant third implementation MUST:

- Honor the route table in [§2](#2-http-api-contract) including the
  bypass list in [§3.1](#31-bypass-routes), the body limits, and the
  Herald-CORS exception.
- Serve `GET /api/v1/capabilities` and apply the optional-service
  off-switch + 501 gating ([§1 Optional services](#optional-services)):
  a service whose downstream URL is empty reports `false` and its proxy
  mount returns 501.
- Validate the macaroon secret length and exit on failure.
- Implement the L402 challenge wire format exactly: HTTP 402,
  `WWW-Authenticate: L402 macaroon="...", invoice="..."`, JSON body
  with the same fields.
- Use a macaroons-protocol-v1-compatible serializer for tokens.
- Verify `sha256(preimage) == payment_hash` constant-time.
- Use the Redis key schema in [§7](#7-storage-contract-redis) if
  sharing a Redis instance with the reference service.
- Forward each upstream call with the admin header injected when
  `ARCHON_ADMIN_API_KEY` is configured (so the upstream services accept
  the proxy request).
- Expose the metrics in [§9](#9-prometheus-metrics-contract).
