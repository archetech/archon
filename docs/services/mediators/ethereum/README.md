# Archon Ethereum mediator

The Ethereum mediator anchors Archon DID batches on EVM chains through a canonical `ArchonRegistry` smart contract. It is designed for registries such as `ETH:sepolia`, `ETH:mainnet`, or EVM L2 variants configured with their own registry names and contract addresses.

The mediator has two responsibilities:

- **Import**: Scans finalized `ArchonBatch` logs from the configured registry contract, retrieves discovered batch genesis DID documents, and imports the signed operations into Gatekeeper.
- **Export**: Polls the Gatekeeper queue for the configured registry, creates an Archon batch DID on `pin` when that registry is available, falls back to `hyperswarm`, and asks the Ethereum wallet service to submit an `anchorBatch` transaction.

The smart contract intentionally does not validate Archon DID semantics. Gatekeeper remains the validation authority; Ethereum is used as a publication, ordering, and timestamping layer.

An `ArchonBatch` anchor commits to the batch DID's signed create operation.
Import uses `gatekeeper.getGenesis(did)` and reads the ordered `didDocumentData.batch.ops` list.
Retrieval checks identity/shape without requiring publisher authorization or
accepted DID history; contained operations are still authorized normally. A later
batch-asset update cannot
change the operations or their `opidx` values for the existing anchor. Missing
genesis content is retried rather than replaced with latest asset state.

## Canonical contract

Each public EVM registry should use one canonical contract address. For example, every `ETH:sepolia` node should scan the same Sepolia `ArchonRegistry` deployment. Custom deployments should use a distinct registry name or be clearly marked as non-canonical in node configuration.

The reference contract is in [`services/mediators/ethereum/contracts/ArchonRegistry.sol`](../../../../services/mediators/ethereum/contracts/ArchonRegistry.sol).

## Environment variables

| variable | default | description |
| --- | --- | --- |
| `ARCHON_NODE_ID` | none | Keymaster agent name used as batch controller |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper service URL |
| `ARCHON_KEYMASTER_URL` | none | Keymaster service URL |
| `ARCHON_WALLET_URL` | none | Ethereum wallet service URL |
| `ARCHON_ADMIN_API_KEY` | none | Admin API key for service-to-service calls |
| `ARCHON_ETH_CHAIN` | network derived | Gatekeeper registry name, e.g. `ETH:sepolia` |
| `ARCHON_ETH_NETWORK` | `mainnet` | `mainnet`, `sepolia`, `holesky`, or `local` |
| `ARCHON_ETH_CHAIN_ID` | network derived | EVM chain ID |
| `ARCHON_ETH_RPC_URL` | `http://localhost:8545` | Ethereum JSON-RPC endpoint |
| `ARCHON_ETH_CONTRACT` | none | Canonical `ArchonRegistry` contract address |
| `ARCHON_ETH_START_BLOCK` | `0` | First block to scan |
| `ARCHON_ETH_LOG_CHUNK_SIZE` | `2000` | Blocks per `eth_getLogs` query |
| `ARCHON_ETH_PENDING_TX_TIMEOUT_BLOCKS` | `120` | Blocks to wait before bumping a pending anchor transaction |
| `ARCHON_ETH_MIN_GAS_BALANCE_WEI` | `1000000000000000` | Minimum wallet balance required before anchoring |
| `ARCHON_ETH_IMPORT_INTERVAL` | `0` | Minutes between import cycles; `0` disables importing |
| `ARCHON_ETH_EXPORT_INTERVAL` | `0` | Minutes between export cycles; `0` makes the mediator read-only |
| `ARCHON_ETH_REIMPORT` | `true` | Reprocess discovered batches on startup |
| `ARCHON_ETH_DB` | `json` | Database adapter: `json`, `sqlite`, `mongodb`, or `redis` |
| `ARCHON_ETH_DB_NAME` | chain derived | Persister file/key name, derived from the registry chain by default |
| `ARCHON_ETH_METRICS_PORT` | `4239` | Metrics server port |


### Batch completion and pending events

Gatekeeper's `processEvents().pending` is a global queue count. When nonzero,
`pendingBatches` identifies the batch DIDs still represented in that queue.
After importing every CID, the mediator completes a batch only after a non-busy
processing result that has no pending events for that batch. Unrelated pending
events do not trigger reimports. This records processing completion, not final
authorization; retained history can still be replayed when missing evidence arrives.

Batch import logs report `batchImport` and `batchComplete` for this batch;
`gatekeeperQueueAfterImport` and `gatekeeperProcessing` describe the node-global
inbound queue. Persisted `imported` and `processed` keep the raw API responses.

Unavailable content, incomplete CID results, processing failures, and batches
with their own pending events remain retryable. Older Gatekeepers that omit
`pendingBatches` retain the conservative global-pending behavior. Persisted
“No progress” errors recover through the normal retry pass without database edits.


## Finalized imports and upgrade

Discovery, startup checkpoint sync, backlog metrics, and batch retries use the
RPC `finalized` block as their upper bound. The provider must support
[`eth_getBlockByNumber("finalized", false)`](https://ethereum.org/developers/docs/apis/json-rpc/#eth_getblockbynumber).
An unavailable or unsupported finalized block pauses imports; there is no
fallback to `latest`, `safe`, or a confirmation count. Anchors become visible
after finalization, rather than after a configured number of confirmations.

`ARCHON_ETH_CONFIRMATIONS` is removed and has no effect. Outbound transaction
submission, mined-transaction detection, and fee-bump timeout tracking still use
the current head. A mined outbound transaction does not authorize an import
before finality.

On upgrade, existing receipts and discoveries remain intact. If the legacy
scan cursor is ahead of finality, scanning, checkpoint sync, and the import cycle
wait until finality catches up. The mediator then checks the stored cursor hash.
A matching hash enables `finalizedImports: true` without withdrawal or rescanning.

Only an actual hash mismatch triggers legacy reorg recovery: find a surviving
checkpoint, withdraw the orphaned suffix through Gatekeeper, and prune its
discoveries before committing the recovered cursor. Withdrawal failure leaves
the cursor and discoveries intact for retry. Gatekeeper retains withdrawn signed
operations as unconfirmed hints and replays affected histories. Persisted batch
retries also check their own height against finality.

Previously imported receipts may remain visible before finality during this
transition; they are not removed merely because the import policy changed.

After this transition, ordinary reorg recovery is disabled. A finalized head
behind the persisted scan cursor, or a changed finalized cursor hash, stops
imports and requires investigation. Finalized-chain rollback is outside the
automatic recovery model. The existing canonical contract, ten-block checkpoint
cadence, event positions, and timestamps remain unchanged.

`ethereum_block_height` reports the persisted scan cursor, which can remain
ahead of finality during the legacy upgrade wait.
`ethereum_block_count` reports the persisted scan ceiling and
`ethereum_blocks_pending` reports the stored backlog. During the upgrade wait,
these retain their legacy values too; once the transition succeeds, the ceiling
and backlog use finalized blocks.
The ordinary `ethereum_reorgs_total` counter is removed.
