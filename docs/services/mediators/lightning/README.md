# Archon Lightning Mediator — Service Specification

Language-agnostic contract for the **Lightning mediator** — the service
that bridges Archon DIDs to the Lightning Network via LNbits and
Core Lightning (CLN). It backs the wallet-side Lightning features
(balance/invoice/pay/zap) and the L402 paywall invoices that Drawbridge
issues on inbound API calls.

The canonical implementation is
[services/mediators/lightning/](../../../../services/mediators/lightning/).

> **Related specs.** The Lightning mediator is the HTTP backend that the
> [Keymaster's](../../keymaster/README.md#12-nostr-and-lightning-passthrough)
> `/api/v1/lightning/*` routes forward to, and that Drawbridge uses for
> L402 invoice creation. It talks to [LNbits](https://lnbits.com/) for
> user-wallet operations and to CLN's REST plugin for L402. It resolves
> recipient DIDs through the [Gatekeeper](../../gatekeeper/README.md).

---

## 1. Service responsibilities

Thin HTTP wrapper over two external systems:

- **LNbits** — per-user Lightning wallets: create, get balance, create
  invoice, pay invoice, check payment, list payments. One wallet per
  Archon identity.
- **CLN** (via the `clnrest` plugin) — the node's own Lightning wallet,
  used for L402 paywall invoices that monetize Drawbridge API access.

Plus three pieces of state in Redis:

- **Published-Lightning directory** — mapping `DID → invoiceKey` so third
  parties can pay a DID at `/invoice/:did` without knowing the LNbits
  `invoiceKey` directly.
- **L402 pending-invoice store** — short-lived records of outstanding
  invoices issued to paywalled API calls, keyed by `paymentHash`.
- **L402 payment records** — long-lived receipts of served paywalls.

The service carries no key material and is not authoritative over any
balance — all actual Lightning state lives in LNbits and CLN.

---

## 2. HTTP API contract

The service binds to `${ARCHON_BIND_ADDRESS}:${ARCHON_LIGHTNING_MEDIATOR_PORT}`
(default `0.0.0.0:4235`). Routes live under `/api/v1` with two
unversioned routes (`/ready`, `/version`, `/metrics`) plus a single
public endpoint (`/invoice/:did`).

### 2.1 Routes

| Method | Path | Admin? | Notes |
| --- | --- | :---: | --- |
| `GET` | `/ready` | no | `{ ready, dependencies: { redis, clnConfigured, lnbitsConfigured } }`. HTTP 503 if `redis` is unreachable. |
| `GET` | `/version` | no | `{ version, commit }` (commit 7 chars). |
| `GET` | `/metrics` | no | Prometheus. |
| `GET` | `/api/v1/lightning/supported` | no | `{ supported: true, mediator: "lightning-mediator", clnConfigured, lnbitsConfigured }`. Used by clients to probe capabilities before committing to Lightning operations. |
| `POST` | `/api/v1/lightning/wallet` | yes | `{ name? }` → new LNbits wallet. Returns `LnbitsWallet = { walletId, adminKey, invoiceKey }`. |
| `POST` | `/api/v1/lightning/balance` | yes | `{ invoiceKey }` → `{ balance: <sats> }`. |
| `POST` | `/api/v1/lightning/invoice` | yes | `{ invoiceKey, amount, memo }` → `LightningInvoice`. |
| `POST` | `/api/v1/lightning/pay` | yes | `{ adminKey, bolt11 }` → `LightningPayment`. |
| `POST` | `/api/v1/lightning/payment` | yes | `{ invoiceKey, paymentHash }` → `LightningPaymentStatus & { paymentHash }`. |
| `POST` | `/api/v1/lightning/payments` | yes | `{ adminKey }` → `{ payments: LnbitsPayment[] }`. |
| `POST` | `/api/v1/lightning/publish` | yes | `{ did, invoiceKey }` — stores the mapping + adds a `Lightning` service entry to the DID document. |
| `DELETE` | `/api/v1/lightning/publish/:did` | yes | Removes the mapping + DID document entry. |
| `POST` | `/api/v1/lightning/zap` | yes | `{ adminKey, did, amount, memo? }`. Resolves recipient (DID or LUD-16 address), requests an invoice, and pays it via LNbits. See [§4](#4-zap-flow). |
| `POST` | `/api/v1/l402/invoice` | yes | `{ amountSat, memo? }` — creates a CLN invoice for L402. Returns `{ paymentRequest, paymentHash, amountSat, expiry, label }`. |
| `POST` | `/api/v1/l402/check` | yes | `{ paymentHash }` → CLN `listinvoices` response (paid / pending / expired). |
| `POST` | `/api/v1/l402/pending` | yes | Body: `PendingInvoiceData`. Persists the record for later redemption. Returns HTTP 201 `{ ok: true, paymentHash }`. |
| `GET` | `/api/v1/l402/pending/:paymentHash` | yes | Returns the stored `PendingInvoiceData` or HTTP 404. |
| `DELETE` | `/api/v1/l402/pending/:paymentHash` | yes | Removes the record. |
| `GET` | `/invoice/:did` | no (public) | Query: `amount` (required sats), `memo` (optional). Looks up the DID's `invoiceKey` via `/api/v1/lightning/publish` storage, asks LNbits to create an invoice, returns `{ paymentRequest, paymentHash, ... }`. Used by external zappers and the Archon HTTP zap flow. |

All routes under `/api/v1/*` (except `/lightning/supported`) require the
admin API key:

- Header: `X-Archon-Admin-Key`
- Wrong key: HTTP 401 `{ "error": "Invalid admin API key" }`
- Missing key: HTTP 401 `{ "error": "Admin API key required" }`
- `ARCHON_ADMIN_API_KEY` **MUST** be set for production — when empty,
  all admin calls 403 with `{ "error": "Admin API key not configured" }`
  (different from Gatekeeper/Keymaster behavior, where empty = open).

CORS: none by default. The Lightning mediator is typically reached only
from the Keymaster / Drawbridge on the same private network.

Body limit: `1mb` global (enforced via Express `json({ limit: '1mb' })`).

Constant-time admin-key comparison is used (`crypto.timingSafeEqual`).

### 2.2 Error shape

Every 4xx / 5xx response: `application/json` `{ "error": "<message>" }`.
502 is used for upstream-LNbits/CLN errors; 400 for
`LightningPaymentError` (validation-class failures from LNbits); 503
when a dependency (LNbits or CLN) is not configured at startup.

---

## 3. Dependencies and readiness

### 3.1 Readiness

`/ready` checks only **Redis** reachability (ping/pong). LNbits and CLN
are tested for "configured" (non-empty URL / rune) but not probed —
they're allowed to be up-and-down independently without cycling the
mediator's readiness.

HTTP status: `200` when Redis is up, `503` when not.

### 3.2 LNbits

- Base URL: `ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL`
  (default `http://lnbits:5000`, matching the bundled compose service
  name).
- Required for everything under `/api/v1/lightning/*` and for
  `/invoice/:did`. Each admin-gated LNbits route returns HTTP 503
  `{ "error": "Lightning (LNBits) not configured" }` when the URL is
  empty.
- Wallet creation uses the LNbits admin API key implicit in the URL
  (LNbits' "Service Admin API Key" — *not* the per-user keys returned by
  `/lightning/wallet`).

### 3.3 CLN

- Base URL: `ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL`
  (default `https://cln:3001`).
- Rune: `ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE` (issued by the CLN node
  operator; grants the `invoice` and `listinvoices` permissions).
- Required for all `/api/v1/l402/*` routes. If either is empty, those
  routes return HTTP 502.
- Accepts self-signed TLS (it's the local CLN node's REST plugin).

### 3.4 Redis

- URL: `ARCHON_LIGHTNING_MEDIATOR_REDIS_URL` or falls back to
  `ARCHON_REDIS_URL` or `redis://localhost:6379`.
- Only key family: `lightning-mediator:*` (see [§5](#5-redis-key-schema)).

---

## 4. Zap flow

`POST /api/v1/lightning/zap` is the sole non-trivial handler. It
accepts a recipient in one of two forms:

### 4.1 LUD-16 (`name@domain`)

Detected by `did.includes('@') && !did.startsWith('did:')`. Flow:

1. Parse `<name>@<domain>`, construct
   `https://<domain>/.well-known/lnurlp/<urlencode(name)>`.
2. Reject if `domain` resolves to a private address
   (`localhost|127.*|10.*|172.(16-31).*|192.168.*`).
3. Fetch the LNURL-pay endpoint JSON. Reject if `status === "ERROR"` or
   missing `callback`.
4. Validate the callback URL is `https:` and not a private address.
5. Enforce `amountMsats = amount * 1000` against `minSendable` /
   `maxSendable` from the LNURL response.
6. Append `?amount=<msats>&comment=<memo>` (comment only if memo is
   non-empty) to the callback and fetch it.
7. The response's `pr` field is the BOLT11 invoice.

### 4.2 DID (`did:cid:...`)

1. Resolve the DID through the Gatekeeper; look for a service entry
   where `service.type === "Lightning"`.
2. If none: HTTP 404 `{ "error": "Recipient DID has no Lightning service
   endpoint" }`.
3. Validate the endpoint URL:
   - `.onion` hosts MUST use `http:`.
   - Non-`.onion` MUST use `https:` and MUST NOT be a private host.
4. Build `<serviceEndpoint>?amount=<sats>&memo=<memo>`.
5. If the mediator has a `publicHost` (see [§6.3](#63-public-host-resolution))
   and the endpoint's hostname matches, shortcut through the internal
   Drawbridge port (`http://drawbridge:<drawbridgePort>`) to avoid
   looping back through our own onion.
6. Fetch the invoice URL (through the Tor SOCKS proxy at
   `ARCHON_LIGHTNING_MEDIATOR_TOR_PROXY` when the destination is
   `.onion`).
7. Extract `paymentRequest` from the response.

### 4.3 Payment

Either path produces a BOLT11 string; the mediator hands it to
`lnbits.payInvoice(lnbitsUrl, adminKey, paymentRequest)` and returns
the LNbits response (`LightningPayment` shape).

---

## 5. Redis key schema

Namespace: `lightning-mediator:`. All values are JSON strings unless
noted.

| Key | Type | TTL | Contents |
| --- | --- | --- | --- |
| `lightning-mediator:published:<DID>` | STRING | none | `invoiceKey` for the DID |
| `lightning-mediator:pending:<paymentHash>` | STRING | ~ `expiresAt - now` | `PendingInvoiceData` |
| `lightning-mediator:payment:<id>` | STRING | none | `LightningPaymentRecord` |
| `lightning-mediator:payment:did:<DID>` | SET | none | Payment IDs for that DID (used by `getPaymentsByDid`) |

`PendingInvoiceData`:

```jsonc
{
  "paymentHash": "<hex>",
  "macaroonId":  "<opaque id>",
  "serializedMacaroon": "<base64>",
  "did":         "<DID>",
  "scope":       ["<cap>", ...],
  "amountSat":   <int>,
  "expiresAt":   <unix ms>,
  "createdAt":   <unix ms>
}
```

`LightningPaymentRecord`:

```jsonc
{
  "id":            "<uuid>",
  "did":           "<DID>",
  "method":        "lightning",
  "paymentHash":   "<hex>",
  "amountSat":     <int>,
  "createdAt":     <unix ms>,
  "macaroonId":    "<opaque id>",
  "scope":         ["<cap>", ...]
}
```

A new implementation MUST use this namespace and key structure if the
Redis instance is shared with the reference TypeScript service.

---

## 6. Lifecycle and configuration

### 6.1 Startup

1. Read config from env.
2. Construct the Redis store (lazy-connect).
3. Register routes and start the HTTP listener.
4. No blocking dependency probes — Gatekeeper, LNbits, and CLN are
   assumed reachable on demand.

### 6.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_LIGHTNING_MEDIATOR_PORT` | `4235` | HTTP listen port. |
| `ARCHON_BIND_ADDRESS` | `0.0.0.0` | |
| `ARCHON_ADMIN_API_KEY` | empty | **Required**; empty → all admin routes 403. |
| `ARCHON_LIGHTNING_MEDIATOR_REDIS_URL` | `${ARCHON_REDIS_URL:-redis://localhost:6379}` | |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Used to resolve recipient DIDs in zaps. |
| `ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL` | `https://cln:3001` | |
| `ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE` | empty | CLN authorization rune. |
| `ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL` | `http://lnbits:5000` | |
| `ARCHON_LIGHTNING_MEDIATOR_PUBLIC_HOST` | empty | External URL the mediator advertises (overrides onion discovery). |
| `ARCHON_DRAWBRIDGE_PUBLIC_HOST` | empty | Preferred over `PUBLIC_HOST` if set. |
| `ARCHON_DRAWBRIDGE_PORT` | `4222` | Used for internal shortcut in zap. |
| `ARCHON_LIGHTNING_MEDIATOR_TOR_PROXY` | empty | SOCKS5 proxy for `.onion` lookups. Expected form: `host:port`. |
| `GIT_COMMIT` | `unknown` | Build commit. |

### 6.3 Public host resolution

On the first call that needs a public host, the mediator resolves it in
this order and caches the result:

1. `ARCHON_DRAWBRIDGE_PUBLIC_HOST` env var
2. `ARCHON_LIGHTNING_MEDIATOR_PUBLIC_HOST` env var
3. Contents of `/data/tor/hostname` (the Tor onion hostname volume)

---

## 7. Prometheus metrics contract

| Metric | Type | Labels |
| --- | --- | --- |
| `lightning_mediator_http_requests_total` | counter | `method`, `route`, `status` |
| `lightning_mediator_version_info` | gauge | `version`, `commit` |

Plus the standard Prometheus process metrics (`process_*`). The
`route` label collapses dynamic segments:

```
/lightning/publish/<DID>  -> /lightning/publish/:did
/l402/pending/<hash>       -> /l402/pending/:paymentHash
/invoice/<DID>             -> /invoice/:did
```

Route labels do **not** include the `/api/v1` prefix (they come from
`req.path` under the already-mounted v1 router).

---

## 8. Logging conventions

`pino` at `LOG_LEVEL` (default `info`) + `morgan('dev')` for HTTP
requests. Errors logged as structured `{ err }` objects.

No fixed log lines expected from downstream consumers.

---

## 9. Reference implementation and tests

- Source: [services/mediators/lightning/](../../../../services/mediators/lightning/)
- LNbits client: [services/mediators/lightning/src/lnbits.ts](../../../../services/mediators/lightning/src/lnbits.ts)
- CLN client: [services/mediators/lightning/src/lightning.ts](../../../../services/mediators/lightning/src/lightning.ts)
- Redis store: [services/mediators/lightning/src/store.ts](../../../../services/mediators/lightning/src/store.ts)
- Image: `ghcr.io/archetech/lightning-mediator`

No dedicated conformance tests; validated end-to-end through the zap
flow in the CLI test suite and by Drawbridge integration tests.

A conformant third implementation MUST:

- Accept the same request shapes on the routes in [§2.1](#21-routes) and
  return the listed response envelopes.
- Use the Redis key schema in [§5](#5-redis-key-schema) if sharing a
  Redis namespace with the reference service.
- Enforce the LUD-16 / DID validation rules in [§4](#4-zap-flow)
  (private-host rejection, .onion-only http, etc.).
- Use constant-time admin-key comparison.
- Preserve the `/invoice/:did` public endpoint's shape so external
  zappers can pay published DIDs unchanged.
