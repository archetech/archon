# Archon Solana wallet service

The Solana wallet service owns Solana key derivation, transaction signing, and transaction broadcast for the Solana mediator. The mediator calls this service instead of holding private keys directly.

The wallet derives a Solana account from the Keymaster mnemonic using the configured SLIP-0010/BIP-44 derivation path. The default path is `m/44'/501'/0'/0'`.

## API

All wallet endpoints are under `/api/v1` and require `X-Archon-Admin-Key` when `ARCHON_ADMIN_API_KEY` is configured.

| endpoint | description |
| --- | --- |
| `GET /wallet/address` | Returns the derived Solana funding address |
| `GET /wallet/balance` | Returns SOL balance |
| `GET /wallet/info` | Returns address, balance, slot, network, and derivation path |
| `POST /wallet/airdrop` | Requests devnet/testnet SOL for the wallet |
| `POST /wallet/send` | Sends SOL |
| `POST /wallet/anchor` | Publishes an Archon batch memo |
| `GET /wallet/transaction/:txid` | Returns signature confirmation status |

## Environment variables

| variable | default | description |
| --- | --- | --- |
| `ARCHON_WALLET_PORT` | `4262` | HTTP API port |
| `ARCHON_WALLET_METRICS_PORT` | `4263` | Metrics server port |
| `ARCHON_KEYMASTER_URL` | `http://localhost:4226` | Keymaster service URL |
| `ARCHON_ADMIN_API_KEY` | none | Admin API key for service-to-service calls |
| `ARCHON_WALLET_SOL_NETWORK` | `mainnet-beta` | `mainnet-beta`, `devnet`, `testnet`, or `local` |
| `ARCHON_WALLET_SOL_RPC_URL` | `ARCHON_SOL_RPC_URL` or network derived | Solana JSON-RPC endpoint |
| `ARCHON_WALLET_SOL_COMMITMENT` | `ARCHON_SOL_COMMITMENT` or `confirmed` | Solana commitment |
| `ARCHON_SOL_MEMO_PROGRAM_ID` | Memo program | Solana Memo program ID used for anchors |
| `ARCHON_WALLET_SOL_DERIVATION_PATH` | `m/44'/501'/0'/0'` | HD derivation path |

## Testing

The Solana services use `@solana/web3.js` v3. From the repository root, install both services' dependencies before running the SDK regression tests:

```sh
npm ci
npm ci --prefix services/mediators/solana --ignore-scripts
npm ci --prefix services/mediators/solana-wallet --ignore-scripts
npm test -- --runTestsByPath tests/mediators/solana-wallet.test.ts tests/mediators/solana-finality.test.ts --coverage=false
```

These tests exercise deterministic addresses, finalized reads, bigint JSON boundaries, and real SDK signing/submission against a simulated RPC endpoint; they do not spend SOL or contact a public network.
