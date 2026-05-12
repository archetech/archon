# Archon Zcash Wallet

Transparent Zcash wallet service with the same Archon-facing HTTP
contract as `satoshi-wallet`.

The service is designed for Zebra nodes that expose chain and
address-index RPCs but not wallet RPCs. It fetches the Keymaster
mnemonic for each signing request, derives transparent Zcash keys
locally, scans a deterministic address window, builds transparent
transactions, signs them locally, and broadcasts through Zebra.

## Scope

- Transparent addresses only (`t1...` / testnet transparent addresses).
- No shielded or unified-address support in v1.
- OP_RETURN anchors are transparent and public.
- `/wallet/bump-fee` exists for API compatibility but returns `501`.

## HTTP API

Routes match `satoshi-wallet` as closely as possible:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/wallet/version` | `{ version, commit }` |
| `POST` | `/api/v1/wallet/setup` | Checks Zebra RPC support and returns deterministic transparent ranges. |
| `GET` | `/api/v1/wallet/balance` | `{ balance, unconfirmed_balance, network }` in ZEC. |
| `GET` | `/api/v1/wallet/address` | First unused external transparent address. |
| `GET` | `/api/v1/wallet/transactions?count=N&skip=N` | Address-index transaction view. |
| `GET` | `/api/v1/wallet/utxos?minconf=N` | Transparent UTXOs. |
| `GET` | `/api/v1/wallet/fee-estimate?blocks=N` | Zebra relay fee shaped like satoshi-wallet fee estimates. |
| `GET` | `/api/v1/wallet/info` | Status, xpub, configured range size. |
| `POST` | `/api/v1/wallet/send` | `{ to, amount, feeRate?, subtractFee? }`, amount in ZEC. |
| `POST` | `/api/v1/wallet/anchor` | `{ data, feeRate? }`, UTF-8 OP_RETURN payload up to 80 bytes. |
| `GET` | `/api/v1/wallet/transaction/:txid` | Verbose raw transaction result normalized for wallet callers. |
| `POST` | `/api/v1/wallet/bump-fee` | Returns `501` in v1. |

Admin routes require `X-Archon-Admin-Key`, matching
`ARCHON_ADMIN_API_KEY`, exactly like the current `satoshi-wallet`
implementation.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_WALLET_PORT` | `4250` | Main HTTP port. |
| `ARCHON_WALLET_METRICS_PORT` | `4251` | Prometheus port. |
| `ARCHON_WALLET_NETWORK` | `mainnet` | `mainnet` or `testnet`. |
| `ARCHON_WALLET_ZEC_HOST` | `100.70.86.134` | Zebra RPC host. |
| `ARCHON_WALLET_ZEC_PORT` | `8232` | Zebra RPC port. |
| `ARCHON_WALLET_ZEC_USER` / `ARCHON_WALLET_ZEC_PASS` | empty | Optional RPC basic auth. |
| `ARCHON_WALLET_NAME` | `archon-zec-<nodeID>` | Logical wallet name in API responses. |
| `ARCHON_WALLET_GAP_LIMIT` | `20` | External and internal address scan window. |
| `ARCHON_WALLET_ZEC_DEFAULT_FEE_ZAT` | `10000` | Default transparent transaction fee. |
| `ARCHON_WALLET_ZEC_FALLBACK_FEE_ZAT_KB` | `10000` | Fallback fee-estimate rate in zats/kB. |
| `ARCHON_KEYMASTER_URL` | `http://localhost:4226` | Keymaster mnemonic source. |
| `ARCHON_ADMIN_API_KEY` | unset | Required for admin routes. |

`ARCHON_WALLET_BTC_*` host/user/pass variables are accepted as fallbacks
to make local satoshi-wallet style configuration easier to reuse.

## Zebra Requirements

The configured Zebra endpoint must support:

- `getblockcount`
- `getaddressutxos`
- `getaddresstxids`
- `getaddressbalance`
- `getrawtransaction`
- `sendrawtransaction`

`/wallet/setup` fails clearly if the address-index methods are missing.

## Smoke Test

```bash
curl -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
  http://100.70.86.134:8232/
```

Broadcasting `/wallet/send` or `/wallet/anchor` requires funded
transparent UTXOs in the derived Keymaster wallet range.
