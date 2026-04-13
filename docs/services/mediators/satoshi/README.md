# Archon Satoshi Mediator — Service Specification

Language-agnostic contract for the **Satoshi mediator** — the service
that anchors Archon DID event batches onto a Bitcoin-family blockchain
(mainnet, signet, testnet4) via `OP_RETURN` transactions, and that
imports confirmed batches back off-chain.

The canonical implementation is
[services/mediators/satoshi/](../../../../services/mediators/satoshi/).

> **Related specs.** The satoshi mediator reads from and writes to the
> [Gatekeeper](../../gatekeeper/README.md) (DID queues, blocks,
> `importBatchByCids`), resolves batch DIDs through the
> [Keymaster](../../keymaster/README.md), and delegates all Bitcoin-signing
> and UTXO management to the [satoshi-wallet](../satoshi-wallet/README.md)
> service over HTTP.

---

## 1. Service responsibilities

Three background loops over a local Bitcoin Core node + the Archon stack.

### 1.1 Block scanner (always on)

Walks the configured chain from `startBlock` forward, decoding every
`OP_RETURN` in every transaction. When an `OP_RETURN` payload decodes as
a valid `did:cid:...`, that transaction is recorded as a
**discovered item** (height, index, time, txid, did). Handles reorgs by
walking back to the nearest confirmed ancestor and resuming from there.

### 1.2 Import loop (read mode)

For each discovered item, resolves the DID as an asset (expected shape:
`{ batch: { version: 1, ops: [<CID>, ...] } }`), then calls
`gatekeeper.importBatchByCids(cids, metadata)` with anchoring metadata
derived from the Bitcoin transaction (`height`, `index`, `txid`, `batch`
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
   `{ batch: { version: 1, ops: [<CID>, ...] } }`.
3. Calls `satoshi-wallet` `/api/v1/wallet/anchor` with the batch DID as
   the `OP_RETURN` payload.
4. Records the txid + batch DID in the local registered list, clears the
   Gatekeeper queue for that registry, and starts tracking the tx as
   pending.
5. On subsequent ticks, checks whether the pending tx confirmed; if not
   and RBF is enabled, bumps the fee.

Export mode also anchors the Gatekeeper's block store: every scanned
block's `{height, hash, time}` is posted to `gatekeeper.addBlock(<chain>,
block)` so the Gatekeeper can timestamp DIDs anchored in that block.

A mediator runs in **read-only mode** when `ARCHON_SAT_EXPORT_INTERVAL=0`
(the default). In that mode it only imports; it never signs or
broadcasts. Multiple nodes typically run satoshi mediators in
read-only mode for redundancy, with one or two privileged nodes in
export mode.

The mediator carries no private key material. All BTC signing happens in
the [satoshi-wallet](../satoshi-wallet/README.md) service, which fetches
the signing mnemonic from the Keymaster when needed.

---

## 2. Wire contract — what goes on-chain

### 2.1 `OP_RETURN` payload format

A single standard `OP_RETURN` output per anchor transaction. The data
push is the UTF-8 bytes of a `did:cid:...` string — the DID of the
batch asset. Total payload size MUST stay ≤ 80 bytes (Bitcoin consensus
standardness rule); in practice the Archon batch DID is ~60 bytes.

Anchor transactions are created by the satoshi-wallet (§[satoshi-wallet
spec](../satoshi-wallet/README.md)), which builds a PSBT with:

- One or more inputs from the wallet's UTXO set.
- One output: `OP_RETURN <did-bytes>`, 0 sats.
- One change output back to the wallet's next internal address.
- Fee derived from a hybrid estimator (local `estimatesmartfee` +
  optional remote fee oracle).
- `nSequence` set for RBF (enabled globally when
  `ARCHON_SAT_RBF_ENABLED=true`).

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
`hyperswarm` registry (so the operation chain itself propagates through
the hyperswarm mediator; the BTC anchor is just a timestamp proof).

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
then resumes scanning from `height + 1`. Reorgs are counted via the
`satoshi_reorgs_total` metric.

This simple rewind is correct for the anchoring use case: any
discovered items beyond the rewind point will be re-discovered when the
canonical chain is rescanned. Imports are idempotent at the Gatekeeper
level (`importBatchByCids` with the same CIDs produces the same
`processed` result).

---

## 3. Bitcoin Core interaction

The mediator connects directly to a `bitcoind` RPC endpoint via the
`bitcoin-core` npm client (JSON-RPC over HTTP, basic auth). A
conformant implementation can use any RPC client library; the methods it
needs are:

| bitcoind method | Used for |
| --- | --- |
| `getblockchaininfo` | Startup readiness probe. |
| `getblockcount` | Scan-loop ceiling. |
| `getblockhash(height)` | Deref height → hash. |
| `getblockheader(hash)` | Confirmation check during reorg walk. |
| `getblock(hash, 2)` | Fetch block with full tx+vout for OP_RETURN scanning. |
| `estimatesmartfee(N, ECONOMICAL)` | Local fee estimate. |
| `getmempoolentry(txid)` | Current fee rate of a pending anchor tx, for RBF. |

No other methods are required. Wallet operations (`listunspent`,
`walletprocesspsbt`, `sendrawtransaction`) live in the satoshi-wallet
service.

### 3.1 Block verbosity

`getblock` is called with verbosity `2` (`BlockVerbosity.JSON_TX_DATA`)
so the response includes decoded `tx[].vout[].scriptPubKey.asm` —
parsing that field's `OP_RETURN <hex>` is how the mediator discovers
DIDs.

### 3.2 Fee estimation

The mediator uses a hybrid estimator (`getHybridFeeRateSatPerVb`):

1. Ask bitcoind for `estimatesmartfee(feeConf, "ECONOMICAL")`. If it
   returns a feerate, convert BTC/kB → sat/vB.
2. If a remote fee oracle is configured, request its
   `{ fastestFee, halfHourFee, hourFee }` JSON. Pick based on
   `feeConf`:
   - `feeConf <= 1`: `fastestFee`
   - `feeConf <= 3`: `halfHourFee`
   - else: `hourFee`
3. Use `max(local, oracle)` — conservative so an outdated local node
   doesn't starve the transaction.

If both fail, falls back to `feeFallback` (default 10 sat/vB). Fee is
capped at `feeMax` BTC per tx; RBF bumps refuse to exceed this.

Mainnet typically runs with a mempool.space oracle
(`ARCHON_SAT_FEE_ORACLE_URL=https://mempool.space/api/v1/fees/recommended`);
signet/testnet run with oracle empty.

### 3.3 RBF loop

When `rbfEnabled=true` and the pending anchor tx hasn't confirmed
within `feeConf` blocks, the mediator:

1. Finds the current mempool entry via `getmempoolentry(txid)`.
2. If `entry.fees.modified >= feeMax`, stops (at max fee already).
3. Computes `targetSatPerVb = getHybridFeeRateSatPerVb()`.
4. If target > current, calls satoshi-wallet `POST /wallet/bump-fee`
   with the new rate; records the new txid in `pending.txids[]`.

`pending.txids` is the full chain of RBF replacements; the mediator
considers any of them mined to confirm the batch.

---

## 4. Persisted state (`MediatorDb`)

One JSON document per chain, stored in whichever backend
`ARCHON_SAT_DB` selects. Selector: `json | sqlite | redis | mongodb`
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
    { "did": "<batch DID>", "txid": "<btc txid>" },
    ...
  ],

  "discovered": [                 // OP_RETURN DIDs seen on-chain
    {
      "height": <int>,
      "index":  <int>,            // tx index within block
      "time":   "<RFC 3339>",
      "txid":   "<btc txid>",
      "did":    "<batch DID>",
      "imported":  ImportBatchResult | undefined,   // last importBatchByCids result
      "processed": ProcessEventsResult | undefined,  // last processEvents result
      "error":  "<string>" | undefined               // last failure
    },
    ...
  ],

  "lastExport": "<RFC 3339>" | undefined,           // last export-loop run time
  "pending": {                                       // current anchor in flight
    "txids": ["<txid>", ...],                        // original + RBF replacements
    "blockCount": <int>                              // chain height at anchor time
  } | undefined
}
```

### 4.1 Filesystem layout

- JSON backend: `data/<dbName>.json` where `dbName` defaults to the
  chain name with `:` → `-` (e.g. `BTC-signet.json`).
- SQLite: `data/<dbName>.db`.
- Redis: key `satoshi-mediator:<dbName>` → JSON string.
- MongoDB: collection `satoshi-mediator`, document `_id = <dbName>`.

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

### 4.2 `ARCHON_SAT_REIMPORT`

When set `true` (default), startup clears
`imported`/`processed`/`error` on every discovered item, forcing a full
reimport pass. This is a convenience for recovering from a damaged
Gatekeeper DB without rescanning the chain — the discovered list stays,
but the import state resets.

---

## 5. HTTP API contract

Small, metrics-only. Binds to `${ARCHON_SAT_METRICS_PORT}` (default
`4234`).

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/version` | `{ version, commit }` |
| `GET` | `/metrics` | Prometheus (gauges refreshed on scrape) |

No `/ready`, no CORS, no admin auth. No public client-facing routes.

---

## 6. Lifecycle and configuration

### 6.1 Startup

1. Read env.
2. In export mode, require `ARCHON_NODE_ID`.
3. Open the selected backend. If that backend has no data but a JSON
   file of the same name exists, migrate from JSON to the new backend
   (one-time upgrade path).
4. If `ARCHON_SAT_REIMPORT=true`, clear per-item import state.
5. Wait for bitcoind to answer `getblockchaininfo`.
6. In export mode, wait for the satoshi-wallet `/api/v1/wallet/balance`
   to respond, then log the balance + funding address.
7. Connect to Gatekeeper + Keymaster (`waitUntilReady=true`).
8. Start the metrics HTTP server.
9. `syncBlocks()` — push every scanned block from `startBlock` up to
   tip into Gatekeeper's `addBlock` so resolution timestamps work.
10. Schedule `importLoop` every `importInterval` minutes.
11. In export mode, schedule `exportLoop` every `exportInterval`
    minutes.

### 6.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_NODE_ID` | unset (required for export) | Keymaster ID that owns anchor assets. |
| `ARCHON_ADMIN_API_KEY` | empty | Gatekeeper / Keymaster / satoshi-wallet admin key. |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | |
| `ARCHON_KEYMASTER_URL` | unset | Required for export mode (asset creation). |
| `ARCHON_WALLET_URL` | unset | Required for export mode. Points at [satoshi-wallet](../satoshi-wallet/README.md). |
| `ARCHON_SAT_CHAIN` | `BTC:mainnet` | One of `BTC:mainnet`, `BTC:testnet4`, `BTC:signet`. Becomes the registry name. |
| `ARCHON_SAT_NETWORK` | `bitcoin` | `bitcoin` / `testnet` / `regtest`. |
| `ARCHON_SAT_HOST` | `localhost` | bitcoind RPC host. |
| `ARCHON_SAT_PORT` | `8332` | bitcoind RPC port. |
| `ARCHON_SAT_USER` / `ARCHON_SAT_PASS` | empty | bitcoind RPC auth. |
| `ARCHON_SAT_IMPORT_INTERVAL` | `0` | Import loop period (minutes). `0` disables. |
| `ARCHON_SAT_EXPORT_INTERVAL` | `0` | Export loop period (minutes). `0` = read-only mode. |
| `ARCHON_SAT_FEE_BLOCK_TARGET` | `1` | Confirmation target for `estimatesmartfee`. |
| `ARCHON_SAT_FEE_FALLBACK_SAT_BYTE` | `10` | Fallback fee rate if estimator fails. |
| `ARCHON_SAT_FEE_MAX` | `0.00002` | Per-tx fee cap in BTC. RBF won't exceed. |
| `ARCHON_SAT_FEE_ORACLE_URL` | empty | Optional remote fee oracle (e.g. mempool.space). |
| `ARCHON_SAT_RBF_ENABLED` | `false` | Enable the replace-by-fee bump loop. |
| `ARCHON_SAT_START_BLOCK` | `0` | Scan from this height. Set per-chain to skip pre-launch history. |
| `ARCHON_SAT_REIMPORT` | `true` | Clear per-item import state on startup. |
| `ARCHON_SAT_DB` | `json` | Storage backend. |
| `ARCHON_SAT_DB_NAME` | `<chain>` (`:` → `-`) | Database key / filename base. |
| `ARCHON_SAT_METRICS_PORT` | `4234` | |
| `GIT_COMMIT` | `unknown` | |

### 6.3 Shutdown

No explicit handlers. On SIGTERM the process exits; pending imports
(in memory) are lost, but the persisted DB remains. The next startup
resumes from the stored `height`/`hash`.

---

## 7. Prometheus metrics contract

Gauges (refreshed on every `/metrics` scrape):

| Metric | Notes |
| --- | --- |
| `satoshi_block_height` | last scanned height |
| `satoshi_block_count` | chain tip |
| `satoshi_blocks_pending` | `blockCount - height` |
| `satoshi_blocks_scanned` | cumulative |
| `satoshi_txns_scanned` | cumulative |
| `satoshi_dids_discovered` | `discovered.length` |
| `satoshi_dids_registered` | `registered.length` |
| `satoshi_pending_txs` | `pending.txids.length` or 0 |
| `satoshi_import_loop_running` | 0 / 1 |
| `satoshi_export_loop_running` | 0 / 1 |

Counters:

| Metric | Notes |
| --- | --- |
| `satoshi_import_errors_total` | failed `importBatchByCids` calls |
| `satoshi_reorgs_total` | detected chain reorgs |
| `satoshi_batches_anchored_total` | successful OP_RETURN anchors |
| `satoshi_rbf_bumps_total` | RBF fee bump events |

Histograms:

| Metric | Buckets |
| --- | --- |
| `satoshi_import_batch_duration_seconds` | `[0.1, 0.5, 1, 2, 5, 10, 30, 60]` |
| `satoshi_anchor_batch_duration_seconds` | `[0.5, 1, 2, 5, 10, 30, 60, 120]` |

Plus `service_version_info{version,commit}` and standard Prometheus
process metrics.

The reference Grafana dashboards live at
[observability/grafana/provisioning/dashboards/satoshi-mediator-mainnet.json](../../../../observability/grafana/provisioning/dashboards/satoshi-mediator-mainnet.json)
and `satoshi-mediator-signet.json`.

---

## 8. Logging conventions

Plain `console.log`. Each scanned block logs
`<height>/<tip> blocks (NN%)` and each OP_RETURN hit logs a triple
`<height> <index:04d> <txid>`. Export-loop anchors log the
fee-rate decision and the resulting txid. RBF activity logs
`RBF: Bumping fee from X sat/vB (estimate: Y sat/vB)`.

No structured logging in the TS reference; implementations MAY add
structured output but SHOULD keep the human-readable lines stable.

---

## 9. Reference implementation and tests

- Source: [services/mediators/satoshi/](../../../../services/mediators/satoshi/)
- DB backends: [src/db/](../../../../services/mediators/satoshi/src/db/)
- Compose files:
  [docker-compose.btc-mainnet.yml](../../../../docker-compose.btc-mainnet.yml),
  [docker-compose.btc-signet.yml](../../../../docker-compose.btc-signet.yml),
  [docker-compose.btc-testnet4.yml](../../../../docker-compose.btc-testnet4.yml).
- Image: `ghcr.io/archetech/satoshi-mediator`
- Grafana dashboards: `satoshi-mediator-mainnet.json`, `-signet.json`.

No dedicated conformance tests. Validation is manual: stand up a
bitcoind + satoshi-wallet + satoshi-mediator trio on signet/testnet4,
create an ephemeral DID with `registry=BTC:signet`, watch the mediator
anchor it, wait for confirmation, and verify the resolution includes
`didDocumentMetadata.timestamp.upperBound.blockid` matching the
expected block.

A conformant third implementation MUST:

- Parse OP_RETURN payloads and detect valid `did:cid:...` strings.
- Handle reorgs by walking `previousblockhash` until
  `confirmations > 0`.
- Persist the `MediatorDb` shape in §4, including the atomic
  `updateDb` contract.
- Call `gatekeeper.importBatchByCids` with the exact `metadata` shape
  in §2.3 so resolution timestamps work.
- When exporting, delegate BTC signing to the satoshi-wallet HTTP API
  (§3 of the [satoshi-wallet spec](../satoshi-wallet/README.md)).
- Call `gatekeeper.addBlock(<chain>, { height, hash, time })` for every
  scanned block.
