# Archon Ethereum wallet service

The Ethereum wallet service owns EVM key derivation, signing, gas estimation, and transaction broadcast for the Ethereum mediator. The mediator calls this service instead of holding private keys directly.

The wallet derives an Ethereum account from the Keymaster mnemonic using the configured BIP-44 derivation path. The default path is `m/44'/60'/0'/0/0`.

## API

All wallet endpoints are under `/api/v1` and require `X-Archon-Admin-Key` when `ARCHON_ADMIN_API_KEY` is configured.

| endpoint | description |
| --- | --- |
| `GET /wallet/version` | Returns `{version, commit}` (unauthenticated) |
| `POST /wallet/setup` | Eagerly initializes the wallet |
| `GET /wallet/address` | Returns the derived EVM funding address |
| `GET /wallet/balance` | Returns ETH balance |
| `GET /wallet/fee-estimate` | Returns current gas fee data |
| `GET /wallet/info` | Returns address, balance, nonce, chain, and derivation path |
| `POST /wallet/send` | Sends ETH |
| `POST /wallet/anchor` | Calls `ArchonRegistry.anchorBatch` |
| `POST /wallet/bump-fee` | Replaces a pending wallet transaction with the same nonce and higher fee |
| `GET /wallet/transaction/:txid` | Returns transaction receipt/confirmation status |

## Environment variables

| variable | default | description |
| --- | --- | --- |
| `ARCHON_WALLET_PORT` | `4252` | HTTP API port |
| `ARCHON_WALLET_METRICS_PORT` | `4253` | Metrics server port |
| `ARCHON_KEYMASTER_URL` | `http://localhost:4226` | Keymaster service URL |
| `ARCHON_ADMIN_API_KEY` | none | Admin API key for service-to-service calls |
| `ARCHON_WALLET_ETH_NETWORK` | `ARCHON_ETH_NETWORK` or `mainnet` | `mainnet`, `sepolia`, `holesky`, or `local` |
| `ARCHON_WALLET_ETH_CHAIN_ID` | network derived | EVM chain ID |
| `ARCHON_WALLET_ETH_RPC_URL` | `ARCHON_ETH_RPC_URL` or `http://localhost:8545` | Ethereum JSON-RPC endpoint |
| `ARCHON_WALLET_ETH_DERIVATION_PATH` | `m/44'/60'/0'/0/0` | HD derivation path |
