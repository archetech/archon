# Archon Solana mediator

The Solana mediator anchors Archon DID batches on Solana by publishing Archon-formatted memos. It supports canonical `SOL:mainnet-beta` and `SOL:devnet` registries.

The mediator has two responsibilities:

- **Import**: Scans Solana Memo program transactions for Archon batch memos, resolves discovered batch DIDs, and imports the signed operations into Gatekeeper.
- **Export**: Polls the Gatekeeper queue for the configured registry, creates an Archon batch DID, and asks the Solana wallet service to submit a memo transaction.

The memo payload intentionally does not validate Archon DID semantics. Gatekeeper remains the validation authority; Solana is used as a publication, ordering, and timestamping layer.

Each import cycle also syncs finalized Solana block checkpoints into Gatekeeper for every produced block whose block height is divisible by 100. The mediator uses Solana slots as an internal scan cursor, but Gatekeeper block records and DID registration metadata use produced block heights so independent nodes can derive the same lower-bound timestamps.

## Canonical memo format

The Solana registries use the Solana Memo program with an Archon-specific payload prefix:

```text
ARCHON_BATCH_V1:{"batchHash":"0x...","batchDid":"did:cid:...","opCount":1}
```

Every node on a canonical Solana registry should scan the same registry address and payload format. The default registry address is derived from the Memo program ID and registry name. Wallet anchors include that address as a Memo instruction signer so discovery can query a narrow address instead of the global Memo program. A future custom Solana program can replace this format under a distinct registry name or explicit non-canonical configuration.

## Environment variables

| variable | default | description |
| --- | --- | --- |
| `ARCHON_NODE_ID` | none | Keymaster agent name used as batch controller |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper service URL |
| `ARCHON_KEYMASTER_URL` | none | Keymaster service URL |
| `ARCHON_WALLET_URL` | none | Solana wallet service URL |
| `ARCHON_ADMIN_API_KEY` | none | Admin API key for service-to-service calls |
| `ARCHON_SOL_CHAIN` | network derived | Gatekeeper registry name, e.g. `SOL:devnet` |
| `ARCHON_SOL_NETWORK` | `mainnet-beta` | `mainnet-beta`, `devnet`, `testnet`, or `local` |
| `ARCHON_SOL_RPC_URL` | network derived | Solana JSON-RPC endpoint |
| `ARCHON_SOL_COMMITMENT` | `confirmed` | Solana commitment: `processed`, `confirmed`, or `finalized` |
| `ARCHON_SOL_MEMO_PROGRAM_ID` | Memo program | Solana Memo program ID to scan and publish to |
| `ARCHON_SOL_START_BLOCK` | `0` | First produced block height to checkpoint and import/register |
| `ARCHON_SOL_SIGNATURE_PAGE_LIMIT` | `100` | Signatures per `getSignaturesForAddress` page |
| `ARCHON_SOL_SIGNATURE_PAGE_MAX` | `20` | Maximum signature pages per import loop |
| `ARCHON_SOL_PENDING_TX_TIMEOUT_SLOTS` | `150` | Slots to wait before re-anchoring a stale pending transaction |
| `ARCHON_SOL_MIN_BALANCE_LAMPORTS` | `10000000` | Minimum wallet balance required before anchoring |
| `ARCHON_SOL_IMPORT_INTERVAL` | `0` | Minutes between import cycles; `0` disables importing |
| `ARCHON_SOL_EXPORT_INTERVAL` | `0` | Minutes between export cycles; `0` makes the mediator read-only |
| `ARCHON_SOL_REIMPORT` | `true` | Reprocess discovered batches on startup |
| `ARCHON_SOL_DB` | `json` | Database adapter: `json`, `sqlite`, `mongodb`, or `redis` |
| `ARCHON_SOL_DB_NAME` | chain derived | Persister file/key name, derived from the registry chain by default |
| `ARCHON_SOL_METRICS_PORT` | `4249` | Metrics server port |
