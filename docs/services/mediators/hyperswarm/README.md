# Archon Hyperswarm Mediator — Service Specification

Language-agnostic contract for the **Hyperswarm mediator** — the service
that carries Archon DID operations between nodes over the public
[hyperswarm](https://github.com/holepunchto/hyperswarm) P2P network.

The canonical implementation is
[services/mediators/hyperswarm/](../../../../services/mediators/hyperswarm/).
Any implementation that honors this spec is drop-in compatible: other nodes
on the hyperswarm topic will exchange operations with it without modification.

> **Related specs.** Reads from / writes to the
> [Gatekeeper](../../gatekeeper/README.md) via HTTP, resolves its own node DID
> through the [Keymaster](../../keymaster/README.md), and advertises an IPFS
> peer identity via Kubo. Read those specs first.

---

## 1. Service responsibilities

The hyperswarm mediator is a stateless relay. On startup it:

1. Reads its own node DID from `ARCHON_NODE_ID` (must already exist in the
   associated Keymaster).
2. Joins a single public hyperswarm topic derived from `ARCHON_PROTOCOL`.
3. Announces its own IPFS peer ID and multiaddrs on that DID document
   (`didDocumentData.node`), so other nodes can peer with it directly.
4. Runs three concurrent loops:
   - **Export loop** — periodically flushes the Gatekeeper's `hyperswarm`
     registry queue to all connected peers, then clears the queue.
   - **Connection loop** — announces itself with `ping` and walks known
     peer DIDs to maintain IPFS peering.
   - **Sync queue** — on every new peer connection, once the import queue
     is idle, asks the peer to share its DB via a `sync` message.
5. Accepts inbound messages (`batch`, `queue`, `sync`, `ping`) from peers
   and feeds them into the import queue → Gatekeeper `importBatch` /
   `processEvents`.

It is **not** responsible for:

- DID storage or resolution (Gatekeeper does that)
- wallet or key management (Keymaster)
- anchoring to any blockchain (satoshi-mediator)
- Lightning / zaps (lightning-mediator)

The mediator carries **no private key material**. Its only trust surface
is the admin API key it uses to call Gatekeeper and Keymaster on the
local node.

---

## 2. Hyperswarm topic and peering

### 2.1 Topic derivation

```
topic = sha256(ARCHON_PROTOCOL)         // 32 bytes, used as the hyperswarm discovery key
```

Default `ARCHON_PROTOCOL` is `/ARCHON/v0.1`. All nodes that want to peer
MUST share the same protocol string.

Each mediator joins the topic as both **client** and **server** (`{client:
true, server: true}`) so peers can dial either direction.

### 2.2 Peer identification

Three layers of identity are in play:

| Layer | What | Lives where |
| --- | --- | --- |
| Transport | hyperswarm peer keypair (ed25519) | generated per process, printed as `shortName(key)` in logs |
| Application | `ARCHON_NODE_NAME` free-form label | exchanged in every message's `node` field |
| Protocol | node DID (`ARCHON_NODE_ID`) | resolved via Keymaster, published in `ping.peers[]` |

The DID is the stable identity across restarts. The hyperswarm keypair is
regenerated every process lifetime (the connection is ephemeral; identity
comes from the DID document contents).

### 2.3 IPFS peering

On startup, the mediator:

1. Resets the local IPFS peering list (`ipfs peering rm --all`).
2. Publishes its own IPFS peer ID + multiaddrs to its node DID document
   via `keymaster.mergeData(nodeDID, { node: { name, ipfs: { id, addresses } } })`.
3. On receiving `ping` messages with `peers[]`, resolves each peer DID,
   extracts `didDocumentData.node.ipfs`, and calls `ipfs peering add`.

The goal is convergent IPFS peering across the hyperswarm: every node
discovers every other node's IPFS endpoint and pins peering with it.

---

## 3. Wire protocol

Every message is a single UTF-8 JSON object per hyperswarm `conn.write`
call. There is no length framing — the receiver uses `JSON.parse` on the
entire `data` event buffer. **Messages MUST fit within one write-buffer
boundary (8 MB in the reference implementation).** Senders that build
larger batches split them recursively before sending.

### 3.1 Envelope

Every message shares:

```jsonc
{
  "type":   "batch" | "queue" | "sync" | "ping",
  "time":   "<RFC 3339>",                // producer clock; informational
  "node":   "<free-form node name>",      // e.g. "gondor" — matches ARCHON_NODE_NAME
  "relays": ["<hexkey>", ...]             // peer keys this message has already passed through
}
```

The `relays` field prevents infinite forwarding loops. A relayer appends
its own peer key before forwarding.

### 3.2 `batch` message

Carries an array of DID `Operation`s pulled from the sender's Gatekeeper
DID chains.

```jsonc
{
  "type": "batch",
  "time": "...",
  "node": "...",
  "relays": [],
  "data": [Operation, ...]                // bare operations, not GatekeeperEvents
}
```

On receipt: the receiver wraps each operation in a `GatekeeperEvent`
(registry `"hyperswarm"`, ordinal `[producerTime, index]`, time = now)
and submits via `gatekeeper.importBatch(events)`. See
[§4.2](#42-mergebatch).

### 3.3 `queue` message

Same payload as `batch`, but the sender is **relaying operations from
its local outbound queue** (the Gatekeeper's `hyperswarm` registry
queue) rather than from its DB. The receiver MUST:

1. `importBatch` the payload (as with `batch`).
2. Append the sender's peer key to `relays`.
3. Forward the message to every other peer not already in `relays`.

### 3.4 `sync` message

Zero-payload request. When a peer sends `sync`, the receiver responds by
streaming `batch` messages that together cover its entire Gatekeeper DB:

```
for did_batch in chunks(getDIDs(), 1000):
    events = gatekeeper.exportBatch(did_batch)         // non-local events only
    operations = events.map(e => e.operation)
    send_batch(conn, operations)                        // splits if > 8 MB
```

Used at connection time to catch up a new peer with historical state.
Senders SHOULD wait until their own import queue is idle before emitting
`sync` to avoid echoing in-flight batches back.

### 3.5 `ping` message

Liveness + peer announcement.

```jsonc
{
  "type": "ping",
  "time": "...",
  "node": "...",
  "relays": [],
  "peers": ["<DID>", ...]                 // DIDs of peers the sender knows
}
```

The receiver updates `connectionInfo[peerKey].nodeName` and walks
`peers[]` to add new IPFS peerings.

### 3.6 Batch size limit

Sender: 8 MB per single `conn.write`. If a batch exceeds the limit,
recursively split in half and send each half. If a single operation
exceeds the limit, log an error and drop it.

Receiver: no explicit size cap, but garbage messages fail JSON parse and
are logged + counted.

### 3.7 Deduplication

A sender's retransmits (e.g. via `queue` → relay) may reach the same
receiver multiple times. The receiver MUST hash each incoming batch
(`cipher.hashJSON(operations)`) and drop duplicates:

```
batchesSeen[hash(data)] = true      // in-memory, ephemeral
```

The `mediator_duplicate_batches_total` counter tracks these drops.

---

## 4. Gatekeeper interaction

### 4.1 Export loop (outbound)

Interval: `ARCHON_HYPR_EXPORT_INTERVAL` seconds (default `2`). On each tick:

1. `batch = gatekeeper.getQueue("hyperswarm")` — grab the outbound queue.
2. If non-empty:
   a. Build a `queue` message (`{ type: "queue", data: batch, ... }`).
   b. `gatekeeper.clearQueue("hyperswarm", batch)` — remove those
      operations from the server queue.
   c. Relay the message to every connected peer (`relays: []`).
   d. `mergeBatch(batch)` locally (re-submits to own Gatekeeper; idempotent).
3. If the import queue is non-empty, re-schedule 60s later; otherwise
   schedule at `exportInterval`.

Skipping 3 when the import queue is idle prevents the export loop from
running faster than the importer can drain.

### 4.2 `mergeBatch(batch)`

```
for chunk in chunks(batch, BATCH_SIZE):          # BATCH_SIZE = 100
    events = wrap_as_gatekeeper_events(chunk, registry="hyperswarm",
                                              ordinal=[producerTime, i])
    gatekeeper.importBatch(events)                # queued in gatekeeper
gatekeeper.processEvents()                        # drain the queue
```

`mergeBatch` is called after every received `batch`/`queue` message and
after every export-loop `flushQueue` (to re-import the sender's own ops).

### 4.3 `shareDb(conn)`

Walks every DID in `gatekeeper.getDIDs()` in 1000-DID chunks, calls
`gatekeeper.exportBatch(chunk)`, extracts `event.operation` from each
result, and sends via `batch` messages (split to fit the 8 MB write
limit).

`exportBatch` already filters out `local` registry events, so the
output is safe to broadcast — it contains only operations that have
already been committed somewhere non-local.

### 4.4 Concurrency

Three async queues, all `concurrency: 1`:

| Queue | Task | Gate |
| --- | --- | --- |
| `syncQueue` | Send `sync` to a new connection | Waits for `importQueue` to drain (10s polling) before sending |
| `importQueue` | Call `mergeBatch` for inbound `batch` / `queue` | Gated on `gatekeeper.isReady()` |
| `exportQueue` | Call `shareDb` in response to `sync` | Gated on `gatekeeper.isReady()` |

Implementations MAY use any concurrency primitive; the contract is that
no two `mergeBatch` or `shareDb` calls overlap, and that `sync` messages
don't go out while the mediator is still draining its own inbox.

---

## 5. HTTP API contract

The mediator exposes a tiny HTTP surface for health/metrics only —
there are no admin or client routes.

Binds to `${ARCHON_HYPR_METRICS_PORT}` (default `4232`).

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/health` | `{ "ok": true }` (always) |
| `GET` | `/ready` | `{ "ready": <all-deps-ready> }` — `true` iff Gatekeeper, Keymaster, IPFS, and own node info are all healthy |
| `GET` | `/version` | `{ "version": string, "commit": string }` |
| `GET` | `/metrics` | Prometheus exposition (see [§7](#7-prometheus-metrics-contract)) |

No CORS, no admin auth, no rate limiting. The port is intended to be
scraped by Prometheus on a private network only.

---

## 6. Lifecycle and configuration

### 6.1 Startup

1. Read config from env.
2. Connect to Gatekeeper (`waitUntilReady=true`, 5s poll).
3. Connect to Keymaster (`waitUntilReady=true`, 5s poll).
4. `ARCHON_NODE_ID` MUST be set; resolve it via Keymaster; if it doesn't
   resolve, exit.
5. Connect to IPFS (`waitUntilReady=true`, 5s poll) and
   `resetPeeringPeers()`.
6. Read own IPFS peer ID + addresses.
7. Start the metrics HTTP server.
8. Start export loop and connection loop.
9. Publish `{ node: { name, ipfs: { id, addresses } } }` onto the node
   DID document via `keymaster.mergeData(nodeDID, ...)`.
10. Create the swarm and join the topic.

### 6.2 Connection loop

Interval: 60 seconds.

1. If no active connections, destroy + recreate the swarm
   (`createSwarm()`).
2. Prune `connectionInfo` entries that haven't produced data in > 3
   minutes.
3. Build a `ping` message listing all known peer DIDs and relay it to
   every connection.
4. Log the current set of IPFS peerings.

### 6.3 Shutdown

`graceful-goodbye` handler calls `swarm.destroy()`. No explicit
Gatekeeper / Keymaster cleanup — those are HTTP clients.

### 6.4 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_NODE_ID` | unset, **required** | Name of this node's agent ID in the Keymaster wallet. |
| `ARCHON_NODE_NAME` | `anon` | Free-form label used in message `node` field. |
| `ARCHON_PROTOCOL` | `/ARCHON/v0.1` | Hyperswarm topic seed. Must match peers you want to talk to. |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | |
| `ARCHON_KEYMASTER_URL` | `http://localhost:4226` | |
| `ARCHON_IPFS_URL` | `http://localhost:5001/api/v0` | Kubo HTTP API. |
| `ARCHON_ADMIN_API_KEY` | empty | Used for both Gatekeeper and Keymaster admin calls. |
| `ARCHON_HYPR_EXPORT_INTERVAL` | `2` | Export loop interval, seconds. |
| `ARCHON_HYPR_METRICS_PORT` | `4232` | Metrics HTTP port. |
| `ARCHON_DEBUG` | `false` | Reserved; currently ignored. |
| `GIT_COMMIT` | `unknown` | Build commit (truncated to 7 chars). |

---

## 7. Prometheus metrics contract

### 7.1 Custom metrics

| Metric | Type | Labels |
| --- | --- | --- |
| `mediator_active_connections` | gauge | (none) |
| `mediator_import_queue_depth` | gauge | (none) |
| `mediator_export_queue_depth` | gauge | (none) |
| `mediator_sync_queue_depth` | gauge | (none) |
| `mediator_known_nodes` | gauge | (none) — DIDs with resolved `node.ipfs` info |
| `mediator_known_peers` | gauge | (none) — distinct IPFS peer IDs |
| `mediator_messages_received_total` | counter | `type` (`batch`/`queue`/`sync`/`ping`) |
| `mediator_messages_relayed_total` | counter | (none) |
| `mediator_operations_imported_total` | counter | (none) |
| `mediator_operations_exported_total` | counter | (none) |
| `mediator_connections_total` | counter | `event` (`established`/`closed`) |
| `mediator_duplicate_batches_total` | counter | (none) |
| `mediator_errors_total` | counter | `operation` (`sync`/`import`/`export`/`peer`/`parse`) |
| `mediator_import_batch_duration_seconds` | histogram | buckets: `[0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60]` |
| `mediator_export_db_duration_seconds` | histogram | buckets: `[0.1, 0.5, 1, 2, 5, 10, 30, 60, 120]` |
| `service_version_info` | gauge | `version`, `commit` |

Gauges are refreshed on every `/metrics` scrape via `updateGauges()`.
Plus the standard Prometheus process metrics.

### 7.2 No route labels

This service only has the health/version/metrics routes, all of which
have trivial paths. Implementations MAY but need not add an
`http_requests_total{method,route,status}` counter; the existing Grafana
dashboards don't depend on one.

---

## 8. Logging conventions

Plain stdout via `console.log`. Notable recurring lines:

- `new hyperswarm peer id: <shortId> (<nodeName>) joined topic: <shortTopic> using protocol: <protocol>`
- `received connection from: <shortPeer>`
- `--- N nodes connected, detected nodes: <names...>`
- `received <type> from: <shortPeer> (<nodeName>)`
- `* merging batch (N events) from: <shortPeer> (<nodeName>) *`
- `importBatch: <shortHash> merging N events...`
- `mergeBatch: {added, merged, rejected, pending}`
- `export loop waiting Ns for import queue to clear: N...`
- `export loop waiting Ns...`

New implementations SHOULD keep the shapes of these messages stable if
dashboards/log aggregators are parsing them.

---

## 9. Reference implementation and tests

- Source: [services/mediators/hyperswarm/](../../../../services/mediators/hyperswarm/)
- Image: `ghcr.io/archetech/hyperswarm-mediator`
- Grafana dashboard:
  [observability/grafana/provisioning/dashboards/hyperswarm-mediator.json](../../../../observability/grafana/provisioning/dashboards/hyperswarm-mediator.json)
- No dedicated integration tests — validation is end-to-end via the CLI
  test suite and real peers on the hyperswarm.

A conformant third implementation MUST:

- Exchange `batch` / `queue` / `sync` / `ping` messages byte-compatible
  with the reference above.
- Join the same topic derived from the same `ARCHON_PROTOCOL`.
- Call Gatekeeper's `importBatch` / `processEvents` / `getQueue` /
  `clearQueue` / `exportBatch` / `addBlock` endpoints (all documented in
  the [Gatekeeper spec](../../gatekeeper/README.md)).
- Call Keymaster's `resolveDID` and `mergeData` (Keymaster spec §7).
- Publish its own IPFS peer info on its node DID and honor inbound peer
  announcements.
