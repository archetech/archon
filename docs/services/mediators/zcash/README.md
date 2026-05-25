# Archon Zcash Mediator — Service Specification

Language-agnostic contract for the **Zcash mediator** — the service
that anchors Archon DID event batches onto Zcash (mainnet, testnet)
via transparent `OP_RETURN` transactions, and that imports confirmed
batches back off-chain.

The canonical implementation is
[services/mediators/zcash/](../../../../services/mediators/zcash/).

> **Related specs.** The zcash mediator reads from and writes to the
> [Gatekeeper](../../gatekeeper/README.md) (DID queues, blocks,
> `importBatchByCids`), resolves batch DIDs through the
> [Keymaster](../../keymaster/README.md), and delegates all Zcash signing
> and UTXO management to the
> [zcash-wallet](../zcash-wallet/README.md) service over HTTP.
>
> The wire contract intentionally mirrors the
> [Satoshi mediator](../satoshi/README.md) so that conformant
> implementations can share most of their scanner / persister code.

---

## 1. Service responsibilities

Three background loops over a local Zebra node + the Archon stack.

### 1.1 Block scanner (always on)

Walks the configured chain from `startBlock` forward via Zebra JSON-RPC,
decoding every `OP_RETURN` output of every transparent transaction.
When an `OP_RETURN` payload decodes as a valid `did:cid:...`, that
transaction is recorded as a **discovered item** (height, index, time,
txid, did). Handles reorgs by walking back through `previousblockhash`
to the nearest confirmed ancestor and resuming from there.

Shielded inputs and outputs are ignored; the scanner only inspects
transparent `vout[].scriptPubKey.asm` strings.

### 1.2 Import loop (read mode)

For each discovered item, resolves the DID as an asset (expected shape:
`{ batch: { version: 1, ops: [<CID>, ...] } }`), then calls
`gatekeeper.importBatchByCids(cids, metadata)` with anchoring metadata
derived from the Zcash transaction (`height`, `index`, `txid`, `batch`
= the batch DID). Followed by `gatekeeper.processEvents()` to actually
merge the events into the local DB.

Retries failed items periodically — most failures are "DID not found"
(the referenced operation hasn't propagated through the hyperswarm yet)
and resolve on their own.

### 1.3 Export loop (write mode only, opt-in)

Fires every `exportInterval` minutes. When the Gatekeeper's registry
queue (`gatekeeper.getQueue(<chain>)`) has pending operations:

1. Pushes each operation JSON to IPFS via `gatekeeper.addJSON`,
   collecting the CIDs.
2. Creates an asset DID via Keymaster containing the batch:
   `{ batch: { version: 1, ops: [<CID>, ...] } }`. The asset is
   registered to `hyperswarm`, not to the ZEC registry, so the
   operation chain itself propagates through the hyperswarm mediator
   while the Zcash anchor is purely a timestamp proof.
3. Computes a fee rate using the hybrid estimator (§3.2) and calls
   zcash-wallet `/api/v1/wallet/anchor` with the batch DID as the
   `OP_RETURN` payload and the selected `feeRate`.
4. Records the txid + batch DID in the local registered list, clears
   the Gatekeeper queue for that registry, and starts tracking the tx
   as pending.
5. On subsequent ticks, polls zcash-wallet
   `GET /api/v1/wallet/transaction/<txid>` until the transaction
   reaches `confirmations > 0`, then clears the pending state.

Export mode also anchors the Gatekeeper's block store: every scanned
block's `{height, hash, time}` is posted to `gatekeeper.addBlock(<chain>,
block)` so the Gatekeeper can timestamp DIDs anchored in that block.

A mediator runs in **read-only mode** when `ARCHON_ZEC_EXPORT_INTERVAL=0`
(the default). In that mode it only imports; it never signs or
broadcasts. Multiple nodes typically run zcash mediators in read-only
mode for redundancy, with one or two privileged nodes in export mode.

The mediator carries no private key material. All Zcash signing happens
in the [zcash-wallet](../zcash-wallet/README.md) service, which fetches
the signing mnemonic from the Keymaster when needed.

---

## 2. Wire contract — what goes on-chain

### 2.1 `OP_RETURN` payload format

A single standard `OP_RETURN` output per anchor transaction. The data
push is the UTF-8 bytes of a `did:cid:...` string — the DID of the
batch asset. Total payload size MUST stay ≤ 80 bytes (Zcash transparent
standardness rule, identical to Bitcoin); in practice the Archon batch
DID is ~60 bytes.

Anchor transactions are created by the zcash-wallet (§3 of the
[zcash-wallet spec](../zcash-wallet/README.md)), which derives a
transparent address window from the Keymaster mnemonic and builds a
transparent transaction with:

- One or more inputs from the wallet's transparent UTXO set.
- One output: `OP_RETURN <did-bytes>`, 0 zats.
- One change output back to the wallet's next internal transparent
  address.
- Fee derived from the mediator's hybrid estimator (§3.2).

Replace-by-fee is **not** supported on transparent Zcash anchors in
v1: `zcash-wallet` returns `501` for `/wallet/bump-fee` and the
mediator treats any pending tx as untouchable until it confirms.

### 2.2 Batch DID asset shape

The batch asset (created via Keymaster) has `didDocumentData`:

```jsonc
{
  "batch": {
    "version": 1,
    "ops": [
      "<CID>",                    // CID of an Archon Operation JSON
      ...
    ]
  }
}
```

- `version` MUST be `1` (the mediator skips any other version).
- `ops` MUST be a non-empty array of strings; each string is the CID of
  an operation already pinned on IPFS via Gatekeeper `addJSON`.

The asset is owned by `ARCHON_NODE_ID` and registered to the
`hyperswarm` registry.

### 2.3 Importing a discovered batch

When the scanner finds a transaction whose `OP_RETURN` is a valid DID,
the import path:

1. `asset = keymaster.resolveAsset(did)` — follow the DID document.
2. Extract `asset.batch.ops[]`.
3. Call `gatekeeper.importBatchByCids(ops, { registry: <chain>, time:
   block.time, ordinal: [height, index], registration: { height, index,
   txid, batch: did } })`.
4. Call `gatekeeper.processEvents()` to drain.

The `registration` metadata is what later powers
`didDocumentMetadata.timestamp.upperBound` in DID resolution (see
[Gatekeeper spec §6.3](../../gatekeeper/README.md#63-block-timestamps)).

### 2.4 Reorg handling

Every scan cycle, the mediator checks whether the last scanned block
hash still has `confirmations > 0` via `getblockheader`. If not, it
walks `previousblockhash` backwards until it finds a block that does,
subtracting that block's transaction count from `txnsScanned`, then
resumes scanning from `height + 1`. Reorgs are counted via the
`zcash_reorgs_total` metric.

Imports are idempotent at the Gatekeeper level
(`importBatchByCids` with the same CIDs produces the same `processed`
result), so any discovered items beyond the rewind point will be
re-discovered and re-imported as the canonical chain is rescanned.

---

## 3. Zcash (Zebra) interaction

The mediator connects directly to a Zebra JSON-RPC endpoint
(`POST /` with `{ jsonrpc, id, method, params }`) via plain axios.
Zebra exposes chain RPCs but **no wallet RPCs** — all wallet work is
delegated to the zcash-wallet service.

| Zebra method | Used for |
| --- | --- |
| `getblockchaininfo` | Startup readiness probe. |
| `getblockcount` | Scan-loop ceiling. |
| `getblockhash(height)` | Deref height → hash. |
| `getblockheader(hash)` | Confirmation check during reorg walk; also fetches `time` and `nTx` for sync mode. |
| `getblock(hash, 2)` | Fetch block with full tx+vout for OP_RETURN scanning. |
| `getnetworkinfo` | `relayfee` for the local half of the hybrid fee estimator. |

No other Zebra methods are required.

### 3.1 Block verbosity

`getblock` is called with verbosity `2`
(`BlockVerbosity.JSON_TX_DATA`) so the response includes decoded
`tx[].vout[].scriptPubKey.asm` — parsing the
`OP_RETURN <hex>` token of that field is how the mediator discovers
DIDs.

### 3.2 Fee estimation

`getHybridFeeRateZatPerVb` mirrors the Satoshi mediator's hybrid
estimator:

1. Ask Zebra for `getnetworkinfo`. If `relayfee` is present, convert
   ZEC/kB → zat/vB (`relayfee / 1000 * 1e8`).
2. If a remote fee oracle is configured, request its
   `{ fastestFee, halfHourFee, hourFee }` JSON and select based on
   `feeConf`:
   - `feeConf <= 1`: `fastestFee`
   - `feeConf <= 3`: `halfHourFee`
   - else: `hourFee`
3. Use `max(local, oracle)`. If both fail, falls back to `feeFallback`
   (default 10 zat/vB).

The chosen `feeRate` is passed to the zcash-wallet `POST /wallet/anchor`
call as the `feeRate` field.

### 3.3 RBF

Not supported in v1. `ARCHON_ZEC_RBF_ENABLED` is accepted for config
parity but the export loop logs `Zcash transparent fee bumping is not
supported; waiting for pending transaction confirmation` and stops
exporting until the pending tx confirms (or is mined-out by the
mempool, which forces operator intervention).

---

## 4. Persisted state (`MediatorDb`)

One JSON document per chain, stored in whichever backend
`ARCHON_ZEC_DB` selects. Selector: `json | sqlite | redis | mongodb`
(default `json`).

```jsonc
{
  "height": <int>,                // last scanned height
  "hash":   "<block hash>",       // last scanned hash (used for reorg detection)
  "time":   "<RFC 3339>",         // last scanned block time
  "blockCount":    <int>,         // chain tip at last scan
  "blocksScanned": <int>,         // total blocks scanned since startBlock
  "blocksPending": <int>,         // blockCount - height
  "txnsScanned":   <int>,         // cumulative tx count processed

  "registered": [                 // batches this mediator anchored
    { "did": "<batch DID>", "txid": "<zec txid>" },
    ...
  ],

  "discovered": [                 // OP_RETURN DIDs seen on-chain
    {
      "height": <int>,
      "index":  <int>,            // tx index within block
      "time":   "<RFC 3339>",
      "txid":   "<zec txid>",
      "did":    "<batch DID>",
      "imported":  ImportBatchResult | undefined,
      "processed": ProcessEventsResult | undefined,
      "error":  "<string>" | undefined
    },
    ...
  ],

  "lastExport": "<RFC 3339>" | undefined,
  "pending": {                                       // current anchor in flight
    "txids": ["<txid>"],                              // always single-entry in v1 (no RBF)
    "blockCount": <int>
  } | undefined
}
```

### 4.1 Filesystem layout

- JSON backend: `data/<dbName>-mediator.json` where `dbName` defaults to
  the chain name with `:` → `-` (e.g. `data/ZEC-mainnet-mediator.json`).
- SQLite: `data/<dbName>-mediator.db`.
- Redis: key `zec-mediator/<dbName>` → JSON string.
- MongoDB: database `zec-mediator`, collection named after the registry
  (`<dbName>`), single document retrieved via `findOne({})`.

The backend is abstracted via a `MediatorDbInterface`:

```ts
interface MediatorDbInterface {
  loadDb(): Promise<MediatorDb | null>;
  saveDb(data: MediatorDb): Promise<boolean>;
  updateDb(mutator: (db: MediatorDb) => void | Promise<void>): Promise<void>;
}
```

`updateDb` MUST be atomic (load → mutate → save). The TS reference
uses an async-promise lock inside each backend.

On startup, if the selected non-JSON backend has no data but a JSON
file of the same name exists, the JSON contents are migrated into the
new backend (one-time upgrade path identical to the Satoshi mediator).

### 4.2 `ARCHON_ZEC_REIMPORT`

When set `true` (default), startup clears
`imported`/`processed`/`error` on every discovered item, forcing a full
reimport pass. This is a convenience for recovering from a damaged
Gatekeeper DB without rescanning the chain — the discovered list stays,
but the import state resets.

### 4.3 Discovered-list dedupe

The reference also runs a one-shot `dedupeDiscovered()` on startup
that collapses any duplicate `(height, index, txid, did)` entries that
might have been written by older versions. New writes use the same key
to prevent re-introducing duplicates.

---

## 5. HTTP API contract

Small, metrics-only. Binds to `${ARCHON_ZEC_METRICS_PORT}` (default
`4238`).

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/version` | `{ version, commit }` |
| `GET` | `/metrics` | Prometheus (gauges refreshed on scrape) |

No `/ready`, no CORS, no admin auth. No public client-facing routes.

---

## 6. Lifecycle and configuration

### 6.1 Startup

1. Read env.
2. In export mode, require `ARCHON_NODE_ID` (the process logs an
   error and exits otherwise).
3. Open the selected backend; migrate from JSON file if needed.
4. Run `dedupeDiscovered()`.
5. If `ARCHON_ZEC_REIMPORT=true`, clear per-item import state.
6. Wait for Zebra to answer `getblockchaininfo` (2 s retry).
7. In export mode, require `ARCHON_WALLET_URL` and wait for the
   zcash-wallet `/api/v1/wallet/balance` to respond (5 s retry).
   Once it does, log the balance and funding address.
8. Connect to Gatekeeper + Keymaster (`waitUntilReady=true`,
   `intervalSeconds=5`).
9. Start the metrics HTTP server.
10. `syncBlocks()` — push every block from `startBlock` (or the
    Gatekeeper's last known ZEC block + 1) up to tip into
    `gatekeeper.addBlock` so resolution timestamps work.
11. Schedule `importLoop` every `importInterval` minutes (if > 0).
12. In export mode, schedule `exportLoop` every `exportInterval`
    minutes.

### 6.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_NODE_ID` | unset (required for export) | Keymaster ID that owns anchor assets. |
| `ARCHON_ADMIN_API_KEY` | unset | Gatekeeper / Keymaster / zcash-wallet admin key. |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | |
| `ARCHON_KEYMASTER_URL` | unset | Required for export mode (asset creation). |
| `ARCHON_WALLET_URL` | unset | Required for export mode. Points at [zcash-wallet](../zcash-wallet/README.md). |
| `ARCHON_ZEC_CHAIN` | `ZEC:mainnet` | One of `ZEC:mainnet`, `ZEC:testnet`. Becomes the registry name. |
| `ARCHON_ZEC_NETWORK` | `mainnet` | `mainnet` / `testnet` / `regtest`. |
| `ARCHON_ZEC_HOST` | `100.70.86.134` | Zebra RPC host. |
| `ARCHON_ZEC_PORT` | `8232` | Zebra RPC port. |
| `ARCHON_ZEC_USER` / `ARCHON_ZEC_PASS` | empty | Optional Zebra RPC basic auth. |
| `ARCHON_ZEC_IMPORT_INTERVAL` | `0` | Import loop period (minutes). `0` disables. |
| `ARCHON_ZEC_EXPORT_INTERVAL` | `0` | Export loop period (minutes). `0` = read-only mode. |
| `ARCHON_ZEC_FEE_BLOCK_TARGET` | `1` | Selects oracle bucket: `<=1` → fastest, `<=3` → half-hour, else hour. |
| `ARCHON_ZEC_FEE_FALLBACK_ZAT_BYTE` | `10` | Fallback fee rate (zat/vB) when both local and oracle estimators fail. |
| `ARCHON_ZEC_FEE_MAX` | `0.0001` | Minimum wallet balance (ZEC) required before exporting. |
| `ARCHON_ZEC_FEE_ORACLE_URL` | empty | Optional remote fee oracle with mempool.space-compatible `{ fastestFee, halfHourFee, hourFee }` JSON. |
| `ARCHON_ZEC_RBF_ENABLED` | `false` | Accepted for config parity. v1 logs a notice and never bumps. |
| `ARCHON_ZEC_START_BLOCK` | `0` | Scan from this height. Set per-chain to skip pre-launch history. |
| `ARCHON_ZEC_REIMPORT` | `true` | Clear per-item import state on startup. |
| `ARCHON_ZEC_DB` | `json` | Storage backend. |
| `ARCHON_ZEC_DB_NAME` | `<chain>` (`:` → `-`) | Database key / filename base. |
| `ARCHON_ZEC_METRICS_PORT` | `4238` | |
| `GIT_COMMIT` | `unknown` | |

### 6.3 Shutdown

No explicit handlers. On SIGTERM the process exits; pending imports
(in memory) are lost, but the persisted DB remains. The next startup
resumes from the stored `height`/`hash` and re-issues
`syncBlocks()` to refill any missed Gatekeeper block entries.

### 6.4 Gatekeeper registries

The configured chain must also be enabled on the Gatekeeper, e.g.
`ARCHON_GATEKEEPER_REGISTRIES=hyperswarm,ZEC:mainnet`. Without that
entry, `gatekeeper.getQueue(REGISTRY)` will return empty and
`importBatchByCids` will reject the metadata.

---

## 7. Prometheus metrics contract

Gauges (refreshed on every `/metrics` scrape from the persisted DB):

| Metric | Notes |
| --- | --- |
| `zcash_block_height` | last scanned height |
| `zcash_block_count` | chain tip |
| `zcash_blocks_pending` | `blockCount - height` |
| `zcash_blocks_scanned` | cumulative |
| `zcash_txns_scanned` | cumulative |
| `zcash_dids_discovered` | `discovered.length` |
| `zcash_dids_registered` | `registered.length` |
| `zcash_pending_txs` | `pending.txids.length` or 0 |
| `zcash_import_loop_running` | 0 / 1 |
| `zcash_export_loop_running` | 0 / 1 |

Counters:

| Metric | Notes |
| --- | --- |
| `zcash_import_errors_total` | failed `importBatchByCids` calls |
| `zcash_reorgs_total` | detected chain reorgs |
| `zcash_batches_anchored_total` | successful OP_RETURN anchors |

Histograms:

| Metric | Buckets |
| --- | --- |
| `zcash_import_batch_duration_seconds` | `[0.1, 0.5, 1, 2, 5, 10, 30, 60]` |
| `zcash_anchor_batch_duration_seconds` | `[0.5, 1, 2, 5, 10, 30, 60, 120]` |

Plus `service_version_info{version,commit}` and standard Prometheus
process metrics.

There is no `zcash_rbf_bumps_total` counter — RBF is unsupported in
v1.

---

## 8. Logging conventions

Plain `console.log`. Each scanned block logs
`<height>/<tip> blocks (NN.NN%)`; each transaction logs a triple
`<height> <index:04d> <txid>`; OP_RETURN hits are persisted but not
called out separately. Export-loop anchors log
`Anchoring with fee rate: X.X zat/vB` and `Transaction broadcast with
txid: <txid>`. Pending-tx polls log `pending txid <txid>`.

No structured logging in the TS reference; implementations MAY add
structured output but SHOULD keep the human-readable lines stable.

---

## 9. Reference implementation and tests

- Source: [services/mediators/zcash/](../../../../services/mediators/zcash/)
- DB backends: [src/db/](../../../../services/mediators/zcash/src/db/)
- Companion wallet spec: [zcash-wallet/README.md](../zcash-wallet/README.md)
- Sibling spec (shared wire shape): [satoshi/README.md](../satoshi/README.md)
- Image: `ghcr.io/archetech/zcash-mediator`

No dedicated conformance tests. Validation is manual: stand up a
Zebra + zcash-wallet + zcash-mediator trio on testnet, create an
ephemeral DID with `registry=ZEC:testnet`, watch the mediator anchor
it, wait for confirmation, and verify the resolution includes
`didDocumentMetadata.timestamp.upperBound.blockid` matching the
expected block.

A conformant third implementation MUST:

- Parse OP_RETURN payloads on transparent Zcash outputs and detect
  valid `did:cid:...` strings.
- Ignore shielded inputs/outputs entirely.
- Handle reorgs by walking `previousblockhash` until
  `confirmations > 0`, adjusting `txnsScanned` accordingly.
- Persist the `MediatorDb` shape in §4, including the atomic
  `updateDb` contract.
- Call `gatekeeper.importBatchByCids` with the exact `metadata` shape
  in §2.3 so resolution timestamps work.
- When exporting, delegate Zcash signing to the zcash-wallet HTTP API
  ([zcash-wallet spec](../zcash-wallet/README.md)) and pass an
  explicit `feeRate` computed from §3.2.
- Call `gatekeeper.addBlock(<chain>, { height, hash, time })` for every
  scanned block.
- Treat `/wallet/bump-fee` as unavailable (`501`) and wait out
  pending anchors rather than attempting RBF.
