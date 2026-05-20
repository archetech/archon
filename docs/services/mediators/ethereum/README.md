# Archon Ethereum mediator

The Ethereum mediator anchors Archon DID batches on EVM chains through a canonical `ArchonRegistry` smart contract. It is designed for registries such as `ETH:sepolia`, `ETH:mainnet`, or EVM L2 variants configured with their own registry names and contract addresses.

The mediator has two responsibilities:

- **Import**: Scans confirmed `ArchonBatch` logs from the configured registry contract, resolves discovered batch DIDs, and imports the signed operations into Gatekeeper.
- **Export**: Polls the Gatekeeper queue for the configured registry, creates an Archon batch DID, and asks the Ethereum wallet service to submit an `anchorBatch` transaction.

The smart contract intentionally does not validate Archon DID semantics. Gatekeeper remains the validation authority; Ethereum is used as a publication, ordering, and timestamping layer.

## Canonical contract

Each public EVM registry should use one canonical contract address. For example, every `ETH:sepolia` node should scan the same Sepolia `ArchonRegistry` deployment. Custom deployments should use a distinct registry name or be clearly marked as non-canonical in node configuration.

The reference contract is in [`contracts/ArchonRegistry.sol`](contracts/ArchonRegistry.sol).

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
| `ARCHON_ETH_CONFIRMATIONS` | `12` | Confirmations before import |
| `ARCHON_ETH_LOG_CHUNK_SIZE` | `2000` | Blocks per `eth_getLogs` query |
| `ARCHON_ETH_IMPORT_INTERVAL` | `0` | Minutes between import cycles; `0` disables importing |
| `ARCHON_ETH_EXPORT_INTERVAL` | `0` | Minutes between export cycles; `0` makes the mediator read-only |
| `ARCHON_ETH_REIMPORT` | `true` | Reprocess discovered batches on startup |
| `ARCHON_ETH_DB` | `json` | Database adapter: `json`, `sqlite`, `mongodb`, or `redis` |
| `ARCHON_ETH_METRICS_PORT` | `4239` | Metrics server port |
