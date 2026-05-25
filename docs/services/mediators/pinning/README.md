# Archon Generic Pinning Mediator

The generic pinning mediator is an **auxiliary storage** service. It
drains the shared `pin` Gatekeeper queue and asks a configured IPFS
Pinning Service API (PSA) provider — Filebase, Pinata, or any other
PSA-compliant endpoint — to retain each queued operation CID.

This is parallel functionality to the
[filecoin-mediator](../filecoin/README.md): both consume the same `pin`
queue and write nothing back to Gatekeeper besides clearing completed
operations. They differ in storage backend. **Run only one mediator per
`pin` queue**, otherwise both will race to clear the same operations.

The canonical implementation is
[services/mediators/pinning/](../../../../services/mediators/pinning/).

> **Related specs.** The pinning mediator reads from the
> [Gatekeeper](../../gatekeeper/README.md) `pin` queue
> (`getQueue('pin')` / `clearQueue('pin', ops)` / `addJSON`) and talks
> to its PSA provider over plain HTTPS using a bearer token.

---

## 1. Service responsibilities

A single background import loop. No chain scanner, no export loop, no
wallet integration. There is no companion wallet service — the bearer
token is the only credential.

### 1.1 Import loop

Fires every `ARCHON_PIN_IMPORT_INTERVAL` minutes (default `1`). For
each tick:

1. `gatekeeper.getQueue('pin')` — fetch the pending operations.
2. For each operation:
   - Compute a deterministic **fingerprint**:
     `cipher.hashJSON(canonicalize(operation))`.
   - If the local state file already records this fingerprint as
     `pinned`, skip and mark the operation as completed.
   - If the state already has a provider `requestid` for this
     fingerprint (status `queued` or `pinning`), poll
     `GET ${apiUrl}/pins/<requestid>` for the latest status.
   - Otherwise pin the operation: compute its IPFS CID
     (`gatekeeper.addJSON(canonicalize(operation))`) and call
     `POST ${apiUrl}/pins` with the PSA payload (§2.2).
   - Record the resulting status (`queued` / `pinning` / `pinned` /
     `failed`) in the local state and, if `pinned`, mark the operation
     as completed.
   - On a provider error or a `failed` status, **stop processing
     further operations** and leave the rest queued for the next tick.
3. `gatekeeper.clearQueue('pin', completed)` — remove the completed
   operations from the queue.

The loop is single-flight (a re-entrant tick is dropped). Pins that
the provider has only acknowledged but not yet completed
(`queued` / `pinning`) stay in the queue and are re-polled on every
subsequent tick until they reach `pinned` or `failed`.

---

## 2. Wire contract

### 2.1 Gatekeeper

| Call | Purpose |
| --- | --- |
| `getQueue('pin')` | List operations waiting to be pinned. |
| `addJSON(canonical)` | Pin the canonical operation JSON to local IPFS, return its CID. |
| `clearQueue('pin', ops)` | Drop completed operations from the `pin` queue. |
| `isReady()` | Used by `/ready`. |

### 2.2 IPFS Pinning Service API

The mediator implements the `psa-1.0` spec sliced down to the two
calls it needs. All requests carry
`Authorization: Bearer ${ARCHON_PIN_API_TOKEN}` and
`Content-Type: application/json`, and use a 60 s timeout.

**`POST ${apiUrl}/pins`**

```jsonc
{
  "cid":  "<IPFS CID>",
  "name": "archon-<registry>-<fingerprint[0:16]>",
  "meta": {
    "archonFingerprint": "<sha256 hex>",
    "archonCid":         "<IPFS CID>",
    "archonRegistry":    "<BTC:mainnet | ETH:sepolia | hyperswarm | …>"  // omitted if unknown
  },
  "origins": ["/dns4/.../tcp/...", ...]   // omitted when ARCHON_PIN_ORIGINS is unset
}
```

**`GET ${apiUrl}/pins/<requestid>`**

Returns the current status of a previously created pin.

**Response handling (`normalizeStatus`)**

The mediator reads two fields from every provider response:

- `requestid` — opaque provider-side ID, stored for follow-up polls.
- `status` — coerced to one of `queued` / `pinning` / `pinned` /
  `failed`. Any other string (or missing field) is treated as
  `pinning`.

All other fields are stored verbatim in the local state as `response`.

### 2.3 Provider error extraction

`providerError(error)` walks the axios error in order:
`response.data.error.details` → `response.data.error.reason` →
`response.data.error` → `response.data.message` → `error.message` →
`String(error)`. This is what ends up in the log line and in
`PinRecord.lastError`.

### 2.4 Fingerprinting

Identical to the filecoin-mediator: the fingerprint is the canonical
hash of the **operation JSON**, not of the IPFS CID. Restarts and
queue redelivery do not cause duplicate pin submissions.

---

## 3. Persisted state (`JsonPinStore`)

A single JSON file at `ARCHON_PIN_STATE_PATH`
(default `./data/pinning-pins.json`):

```jsonc
{
  "version": 1,
  "pins": {
    "<fingerprint>": {
      "fingerprint": "<sha256 hex of canonical operation>",
      "cid":         "<IPFS CID>",
      "registry":    "<original registry>",
      "provider":    "filebase" | "pinata" | "<custom>",
      "requestid":   "<provider request id>",  // undefined after a final failed status that clears it
      "status":      "queued" | "pinning" | "pinned" | "failed",
      "attempts":    <int>,                    // submit + poll attempts combined
      "created":     "<RFC 3339>",
      "updated":     "<RFC 3339>",
      "response":    <last provider JSON>,                   // on `recordFailure`, the previous successful response is preserved (the failing response is not stored)
      "lastError":   "<string, set when status is failed>"   // cleared (set to undefined) on every subsequent successful (non-failed) status update
    },
    ...
  }
}
```

The store is loaded lazily on first import-loop tick and rewritten in
full on every record update. Switching `ARCHON_PIN_PROVIDER` against
the same state file is supported — records keyed under the previous
provider stay readable. Cross-provider `pinned` records are **not**
re-submitted (a stored `pinned` status short-circuits and the op is
treated as done regardless of which provider pinned it); only
`queued` / `pinning` / `failed` records under a stale provider are
re-submitted under the new one.

---

## 4. HTTP API contract

Metrics-only, binds to `ARCHON_PIN_METRICS_PORT` (default `4273`).

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/health` | `{ ok: true }` |
| `GET` | `/ready` | `{ ready: <bool>, provider: "<name>" }` — true iff Gatekeeper is ready. |
| `GET` | `/version` | `{ version, commit, provider }` |
| `GET` | `/metrics` | Prometheus |

No `/api/v1/*` routes, no admin auth on the metrics surface, no public
client-facing routes.

---

## 5. Lifecycle and configuration

### 5.1 Startup

1. Read env. `ARCHON_PIN_API_TOKEN` is **required**; the process
   crashes at provider construction if it is empty.
2. Connect to Gatekeeper.
3. Log the active provider name and API URL.
4. Start the metrics HTTP server.
5. If `importInterval > 0`, run one immediate import tick, then
   `setInterval(importInterval * 60_000)`.

### 5.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_NODE_ID` | unset | Logged at startup; not required (no on-chain identity). |
| `ARCHON_ADMIN_API_KEY` | unset | Sent as `X-Archon-Admin-Key` to Gatekeeper. |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper service URL. |
| `ARCHON_PIN_PROVIDER` | `filebase` | Friendly name; used in metrics labels and `/version`. Picks the default `apiUrl` (`filebase` → `https://api.filebase.io/v1/ipfs`, `pinata` → `https://api.pinata.cloud/psa`). |
| `ARCHON_PIN_API_URL` | provider-derived | Override the PSA base URL. Trailing slashes are stripped. |
| `ARCHON_PIN_API_TOKEN` | unset (**required**) | Bearer token sent on every PSA request. |
| `ARCHON_PIN_ORIGINS` | empty | Comma-separated list of `multiaddr` strings included as `origins` in the pin payload to help the provider locate the CID on the Archon swarm. |
| `ARCHON_PIN_IMPORT_INTERVAL` | `1` | Minutes between import-loop ticks. `0` disables the loop. |
| `ARCHON_PIN_METRICS_PORT` | `4273` | Metrics HTTP port. |
| `ARCHON_PIN_STATE_PATH` | `./data/pinning-pins.json` | Local state file. |
| `GIT_COMMIT` | `unknown` | Embedded in `/version` and `service_version_info`. |

### 5.3 Shutdown

No explicit signal handlers. On SIGTERM the process exits; pins
already submitted to the provider are not cancelled, and the
follow-up `/pins/<requestid>` poll will resume on the next startup
from the persisted `requestid`.

---

## 6. Prometheus metrics contract

Gauges:

| Metric | Notes |
| --- | --- |
| `pinning_mediator_queue_depth` | Operations returned by the last `getQueue('pin')` call. |
| `pinning_mediator_pin_records{provider,status}` | Records in the local state per status (`queued`, `pinning`, `pinned`, `failed`). |
| `pinning_mediator_import_active` | 0 / 1 — single-flight loop guard. |

Counters:

| Metric | Notes |
| --- | --- |
| `pinning_mediator_pins_total{provider,status}` | Per-tick outcomes. `status` ∈ `pinned`, `pinning` (per-tick count of operations still in `pinning`/`queued` state, including re-polls of the same fingerprint), `failed`. |

Plus `service_version_info{version,commit}` and standard Prometheus
process metrics.

---

## 7. Logging conventions

Plain `console.log` / `console.error`:

- `empty pin queue` — per tick when nothing is queued.
- `Pinned N pin operation(s) with <provider>` — successful tick summary.
- `N pin operation(s) still pending with <provider>` — operations
  acknowledged but not yet `pinned`.
- `Pinning failed[: <message>]; leaving remaining operation(s) queued` —
  failure path.

---

## 8. Reference implementation and tests

- Source: [services/mediators/pinning/](../../../../services/mediators/pinning/)
- Image: `ghcr.io/archetech/pinning-mediator`
- Alternative storage backend: [filecoin/README.md](../filecoin/README.md)
  — same `pin` queue contract, durable storage on Filecoin via Synapse
  instead of a hosted PSA provider.

A conformant third implementation MUST:

- Drain Gatekeeper's `pin` queue exactly as in §1.1, using
  `clearQueue('pin', ops)` only for operations whose provider status
  is `pinned`.
- Use the canonical-JSON-hash fingerprint for deduplication and as the
  primary key of the local state.
- Speak the IPFS Pinning Service API as in §2.2 — `POST /pins` /
  `GET /pins/:requestid` with `Authorization: Bearer <token>` — so any
  PSA-1.0 compliant endpoint works without code changes.
- Treat the four PSA statuses (`queued` / `pinning` / `pinned` /
  `failed`) as canonical and coerce anything else to `pinning` so the
  next tick re-polls.
