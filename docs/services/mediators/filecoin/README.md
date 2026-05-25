# Archon Filecoin Storage Mediator

The Filecoin mediator is an **auxiliary storage** service. It drains the
shared `pin` Gatekeeper queue and asks the
[filecoin-wallet](../filecoin-wallet/README.md) service to store each
queued operation CID on Filecoin via Synapse / Filecoin Pay.

Filecoin is **not** a canonical DID registry in Archon. Operations keep
their original registry (e.g. `BTC:mainnet`, `ETH:sepolia`, `hyperswarm`)
and are copied to Filecoin only for storage durability. The mediator
holds no key material; signing and payment are delegated to the wallet
service.

The canonical implementation is
[services/mediators/filecoin/](../../../../services/mediators/filecoin/).

> **Related specs.** The filecoin mediator reads from the
> [Gatekeeper](../../gatekeeper/README.md) `pin` queue
> (`getQueue('pin')` / `clearQueue('pin', ops)` / `addJSON`) and
> delegates all Filecoin-side work to the
> [filecoin-wallet](../filecoin-wallet/README.md) over HTTP.

---

## 1. Service responsibilities

A single background import loop. There is no chain scanner and no
export-to-registry loop — Filecoin is write-only storage from this
mediator's perspective, and the `pin` queue is populated by Gatekeeper
when operations are accepted on any registry.

### 1.1 Import loop

Fires every `ARCHON_FIL_IMPORT_INTERVAL` minutes (default `1`). For
each tick:

1. `gatekeeper.getQueue('pin')` — fetch the pending operations.
2. For each operation:
   - Compute a deterministic **fingerprint**:
     `cipher.hashJSON(canonicalize(operation))`.
   - If the local state file already records this fingerprint as
     `pinned`, skip and mark the operation as completed.
   - Otherwise compute the operation's IPFS CID
     (`gatekeeper.addJSON(canonicalize(operation))`) and call
     wallet `POST /api/v1/wallet/pin { cid, fingerprint, registry }`.
   - On success, record `pinned` in the local state and mark the
     operation as completed.
   - On failure, record `failed` for that fingerprint, log the error,
     **stop processing further operations**, and leave the rest
     queued for the next tick.
3. `gatekeeper.clearQueue('pin', completed)` — remove the completed
   operations from the queue.

The loop is single-flight (a re-entrant call is dropped) and uses a
300 s timeout on the wallet call.

### 1.2 Funding hints

When a pin failure message contains `Insufficient FIL` or `USDFC`, the
mediator calls wallet `GET /api/v1/wallet/version` and logs the funding
address and network so the operator knows where to top up:

```
Filecoin wallet needs calibration FIL. Send calibration FIL to 0x…
```

---

## 2. Wire contract

The mediator does not write any DIDs to the Gatekeeper. The only writes
are to its own local state file. It speaks to two collaborators over
HTTP:

### 2.1 Gatekeeper

| Call | Purpose |
| --- | --- |
| `getQueue('pin')` | List operations waiting to be pinned. |
| `addJSON(canonical)` | Pin the canonical operation JSON to local IPFS, return its CID. |
| `clearQueue('pin', ops)` | Drop completed operations from the `pin` queue. |
| `isReady()` | Used by `/ready`. |

### 2.2 filecoin-wallet

| Call | Purpose |
| --- | --- |
| `POST /api/v1/wallet/pin { cid, fingerprint, registry }` | Export the IPFS DAG for `cid` as CAR data and upload it through Synapse. |
| `GET /api/v1/wallet/version` | Called on every `/ready` probe to determine readiness, and also used to fetch the funding `address` when a failure hints at insufficient funds. |

All calls include `X-Archon-Admin-Key: ${ARCHON_ADMIN_API_KEY}` when the
key is configured.

### 2.3 Fingerprinting

The fingerprint is the canonical hash of the **operation JSON**, not of
the IPFS CID. This is what is used to deduplicate across ticks: an
operation that has already been pinned on Filecoin will be skipped even
if Gatekeeper re-enqueues it under a different CID encoding.

---

## 3. Persisted state (`JsonPinStore`)

A single JSON file at `ARCHON_FIL_STATE_PATH`
(default `./data/filecoin-pins.json`):

```jsonc
{
  "version": 1,
  "pins": {
    "<fingerprint>": {
      "fingerprint": "<sha256 hex of canonical operation>",
      "cid":         "<IPFS CID of canonical operation>",
      "registry":    "<original registry, e.g. BTC:mainnet>",
      "status":      "pinned" | "failed",
      "attempts":    <int>,
      "created":     "<RFC 3339>",
      "updated":     "<RFC 3339>",
      "wallet":      <opaque WalletPinResult JSON from filecoin-wallet>,
      "lastError":   "<string, set when status is failed>"
    },
    ...
  }
}
```

The store is loaded lazily on first import-loop tick and rewritten in
full on every record update. There is no other backend (no SQLite /
Redis / Mongo variant for filecoin pins).

---

## 4. HTTP API contract

Metrics-only, binds to `ARCHON_FIL_METRICS_PORT` (default `4271`).

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/health` | `{ ok: true }` |
| `GET` | `/ready` | `{ ready: <bool> }` — true iff Gatekeeper is ready AND `wallet/version` responds. |
| `GET` | `/version` | `{ version, commit }` |
| `GET` | `/metrics` | Prometheus |

No `/api/v1/*` routes, no admin auth, no public client surface.

---

## 5. Lifecycle and configuration

### 5.1 Startup

1. Read env.
2. Connect to Gatekeeper (`waitUntilReady=true` implicit in
   `gatekeeper.connect`).
3. Log the configured wallet URL (no readiness probe — the wallet may
   still be syncing its mnemonic at boot).
4. Start the metrics HTTP server.
5. If `importInterval > 0`, run one immediate import tick, then
   `setInterval(importInterval * 60_000)`.

### 5.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_NODE_ID` | unset | Logged at startup; not required for filecoin (no on-chain identity). |
| `ARCHON_ADMIN_API_KEY` | unset | Sent as `X-Archon-Admin-Key` to Gatekeeper and filecoin-wallet. |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper service URL. |
| `ARCHON_WALLET_URL` | `http://localhost:4270` | filecoin-wallet service URL. `ARCHON_FIL_WALLET_URL` accepted as alias. |
| `ARCHON_FIL_IMPORT_INTERVAL` | `1` | Minutes between import-loop ticks. `0` disables the loop (mediator becomes idle). |
| `ARCHON_FIL_METRICS_PORT` | `4271` | Metrics HTTP port. |
| `ARCHON_FIL_STATE_PATH` | `./data/filecoin-pins.json` | Local state file. |
| `GIT_COMMIT` | `unknown` | Embedded in `/version` and `service_version_info`. |

### 5.3 Shutdown

No explicit signal handlers. On SIGTERM the process exits; an
in-flight pin upload will be aborted by Node's socket teardown and
re-attempted on the next tick (the wallet may still complete the
underlying Synapse upload, but the local record will be re-created
under the same fingerprint).

---

## 6. Prometheus metrics contract

Gauges:

| Metric | Notes |
| --- | --- |
| `filecoin_mediator_queue_depth` | Operations returned by the last `getQueue('pin')` call. |
| `filecoin_mediator_pin_records{status="pinned"\|"failed"}` | Count of records in the local state file. |
| `filecoin_mediator_import_active` | 0 / 1 — single-flight loop guard. |

Counters:

| Metric | Notes |
| --- | --- |
| `filecoin_mediator_pins_total{status="pinned"\|"failed"}` | Per-tick pin attempt outcomes. |

Plus `service_version_info{version,commit}` and standard Prometheus
process metrics.

---

## 7. Logging conventions

Plain `console.log` / `console.error`:

- `empty pin queue` — per tick when nothing is queued.
- `Pinned N pin operation(s) to Filecoin` — successful tick summary.
- `Filecoin pin failed: <message>; leaving remaining operation(s) queued` — failure path.
- `Filecoin wallet needs <network> <token>. Send <network> <token> to <address>` — funding hint, only when the failure message names a token.

---

## 8. Reference implementation and tests

- Source: [services/mediators/filecoin/](../../../../services/mediators/filecoin/)
- Image: `ghcr.io/archetech/filecoin-mediator`
- Companion wallet spec: [filecoin-wallet/README.md](../filecoin-wallet/README.md)
- Generic alternative: [pinning/README.md](../pinning/README.md) — same
  `pin` queue contract, but uses an IPFS Pinning Service API (Filebase,
  Pinata, etc.) instead of Filecoin/Synapse. Run only one mediator per
  `pin` queue.

A conformant third implementation MUST:

- Drain Gatekeeper's `pin` queue exactly as in §1.1, using
  `clearQueue('pin', ops)` only for operations it successfully pinned.
- Use the canonical-JSON-hash fingerprint described in §2.3 for
  deduplication, so restarts do not re-upload the same operation.
- Not mutate operation registration metadata; Filecoin is auxiliary
  storage only.
