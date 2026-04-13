# Archon Satoshi Wallet — Service Specification

Language-agnostic contract for the **Satoshi wallet** — the HD Bitcoin
wallet service used by the [satoshi-mediator](../satoshi/README.md)
to broadcast `OP_RETURN` anchor transactions. The canonical
implementation is
[services/mediators/satoshi-wallet/](../../../../services/mediators/satoshi-wallet/).

This is the only Archon component that builds and signs Bitcoin
transactions. It does not hold its own mnemonic on disk: at signing time
it fetches the wallet's BIP39 mnemonic from the local
[Keymaster](../../keymaster/README.md) (via the admin-keyed
`GET /api/v1/wallet/mnemonic`) and discards it after the signing pass.

> **Related specs.** Paired with the
> [satoshi-mediator](../satoshi/README.md) (which calls its HTTP
> routes to anchor batches and manage fees) and the
> [Keymaster](../../keymaster/README.md) (source of the mnemonic).
> The UTXO / balance / history side of the wallet is delegated to a
> locally-reachable Bitcoin Core node via RPC.

---

## 1. Service responsibilities

Two halves, both thin wrappers:

1. **Watch-only wallet** — derives xpubs from the Keymaster mnemonic,
   imports `wpkh` descriptors into Bitcoin Core as a descriptor watch-
   only wallet, and forwards balance/address/UTXO/history queries to
   Core. The descriptor wallet name is `${ARCHON_WALLET_NAME}` (default
   `archon-watch-<nodeID>`).

2. **Signing authority** — for `send`, `anchor`, and `bump-fee`
   operations, re-derives the private keys on demand from the mnemonic,
   builds a PSBT via Core (`walletcreatefundedpsbt`), signs locally with
   bitcoinjs-lib + ECPair, and broadcasts via
   `sendrawtransaction`.

The mnemonic never lives in this service's memory between requests.
Every signing call fetches it afresh and scope-bounds its use to a single
request.

---

## 2. HTTP API contract

Binds to `${ARCHON_WALLET_PORT}` (default `4240`). Routes under
`/api/v1`.

### 2.1 Routes

| Method | Path | Admin? | Notes |
| --- | --- | :---: | --- |
| `GET` | `/api/v1/wallet/version` | no | `{ version, commit }` |
| `POST` | `/api/v1/wallet/setup` | yes | Creates the watch-only wallet in Core and imports `wpkh` descriptors. Returns `{ ok: true, network, walletName, descriptors: [external, internal] }`. Idempotent — safe to re-run. |
| `GET` | `/api/v1/wallet/balance` | yes | `{ balance, unconfirmed_balance, network }` in BTC. |
| `GET` | `/api/v1/wallet/address` | yes | `{ address, network }` — next unused external bech32 address. |
| `GET` | `/api/v1/wallet/transactions?count=N&skip=N` | yes | `{ transactions: ListTransactionsEntry[], network }`. Pagination: `count` (default 10), `skip` (default 0). |
| `GET` | `/api/v1/wallet/utxos?minconf=N` | yes | `{ utxos: UnspentOutput[], network }`. `minconf` default 1. |
| `GET` | `/api/v1/wallet/fee-estimate?blocks=N` | yes | `{ feerate, blocks, network }` — BTC/kB from Core's `estimatesmartfee`. |
| `GET` | `/api/v1/wallet/info` | yes | Wallet status block (balance, tx count, network, etc.). |
| `POST` | `/api/v1/wallet/send` | yes | `{ to, amount, feeRate?, subtractFee? }` → `{ txid, ... }`. `amount` in BTC. `feeRate` in sat/vB. |
| `POST` | `/api/v1/wallet/anchor` | yes | `{ data, feeRate? }` → `{ txid, ... }`. `data` is the UTF-8 string to put in `OP_RETURN` (≤ 80 bytes). Called by satoshi-mediator. |
| `GET` | `/api/v1/wallet/transaction/:txid` | yes | `{ txid, confirmations, blockhash, fee, network }` from Core's `gettransaction`. HTTP 404 if the tx isn't in this wallet. |
| `POST` | `/api/v1/wallet/bump-fee` | yes | `{ txid, feeRate? }` → `{ txid, ... }`. RBF the given tx; `txid` MUST be a wallet tx currently in the mempool. Called by satoshi-mediator when a pending anchor stays unconfirmed. |
| `GET` | `/metrics` | no | Prometheus. Binds to `${ARCHON_WALLET_METRICS_PORT}` (default `4241`), NOT the main port. |

Every admin route requires `X-Archon-Admin-Key` matching
`ARCHON_ADMIN_API_KEY`. Missing/wrong key → HTTP 401. When
`ARCHON_ADMIN_API_KEY` is empty, routes are **open** (dev mode) — the
mediator doesn't probe for this, so you must configure it matching on
both sides.

### 2.2 Response envelope

Unlike the Keymaster, the satoshi-wallet returns raw-shaped JSON (no
top-level key wrapping). Callers read fields directly:

```jsonc
// GET /api/v1/wallet/balance
{ "balance": 0.5, "unconfirmed_balance": 0.0, "network": "signet" }

// POST /api/v1/wallet/anchor
{ "txid": "abc...", "network": "signet" }
```

### 2.3 Error shape

`application/json` `{ "error": "<message>" }` with an appropriate
status:

- `400` for client-side validation (missing / invalid params, OP_RETURN
  > 80 bytes, etc.).
- `404` for `gettransaction` misses.
- `500` for anything else.

### 2.4 Body limits

Express default (~100 KB). All bodies are tiny; no custom limit needed.

### 2.5 CORS

None by default. The wallet is meant to be reached only from the
satoshi-mediator on the same private network.

---

## 3. Key derivation

The wallet uses **BIP84** (native SegWit P2WPKH) derivation throughout:

```
m / 84' / <coin_type>' / 0' / <chain> / <index>
```

| Field | Value |
| --- | --- |
| purpose | `84'` (BIP84) |
| coin_type | `0'` for `mainnet`, `1'` for `signet`/`testnet4` |
| account | `0'` (single account per wallet) |
| chain | `0` (external) / `1` (internal/change) |
| index | non-hardened, grows as needed |

Address type: bech32 `wpkh(...)`. Master/account xpub uses
`xprv`/`xpub` version bytes for mainnet and `tprv`/`tpub` for
signet/testnet4.

### 3.1 Descriptors

On `POST /wallet/setup`, the service:

1. `createwallet` with `disable_private_keys=true, blank=true,
   descriptors=true` — creates a pure-descriptor watch-only wallet in
   Core. Loads it if it already exists.
2. Builds two descriptors with origin info:
   ```
   external: wpkh([<fingerprint>/84h/<coin>h/0h]<xpub>/0/*)
   internal: wpkh([<fingerprint>/84h/<coin>h/0h]<xpub>/1/*)
   ```
3. Calls `importdescriptors` with both descriptors, marking them active
   and assigning ranges (default 1000 addresses each; the service
   refreshes the range on setup if Core has consumed too many).

Because Core holds the xpubs only, it can generate addresses and
track UTXOs but cannot sign. Signing is done locally in this service.

### 3.2 Signing flow

For `/send`, `/anchor`, `/bump-fee`:

1. `fetchMnemonic()` — `GET {keymasterURL}/api/v1/wallet/mnemonic` with
   the admin header.
2. `walletcreatefundedpsbt(inputs=[], outputs=[...], feeRate?)` — asks
   Core to build a funded PSBT from the watch-only wallet's UTXOs.
3. For each input in the PSBT, rederive the signing keypair by
   following the key origin info in the PSBT's input records (BIP174
   — Core populates `bip32Derivation` fields).
4. Sign each input with bitcoinjs-lib.
5. Finalize the PSBT and extract the fully-signed transaction.
6. `sendrawtransaction(<hex>)` and return the txid.

For `bump-fee`, the same flow plus `bumpfee` from Core's RPC which
returns a new PSBT; same signing pass follows.

`OP_RETURN` anchors add a single zero-value
`scriptPubKey: OP_RETURN <data-push>` output to the PSBT. `data` is
encoded as UTF-8 bytes. Size validation enforces `bytes <= 80`.

---

## 4. Bitcoin Core interaction

### 4.1 Connection

JSON-RPC over HTTP, basic auth:

```
http://<btcUser>:<btcPass>@<btcHost>:<btcPort>/wallet/<walletName>
```

Wallet name is a URL segment on the RPC path (Core's multi-wallet
addressing convention). The mediator relies on Core being configured
with `-txindex=0` (default) — `gettransaction` works against wallet
txs, which is all the mediator touches.

### 4.2 RPC methods used

| bitcoind method | Used by |
| --- | --- |
| `createwallet` | `/wallet/setup` |
| `loadwallet` | `/wallet/setup` (fallback when wallet already exists) |
| `listdescriptors` | `/wallet/setup` (idempotency check) |
| `importdescriptors` | `/wallet/setup` |
| `getwalletinfo` | `/wallet/info` |
| `getbalances` | `/wallet/balance` |
| `getnewaddress` (with `bech32` type) | `/wallet/address` |
| `listtransactions` | `/wallet/transactions` |
| `listunspent` | `/wallet/utxos` |
| `estimatesmartfee` | `/wallet/fee-estimate` and inside `/send`/`/anchor` when no `feeRate` is supplied |
| `walletcreatefundedpsbt` | `/send`, `/anchor` |
| `gettransaction` | `/wallet/transaction/:txid` |
| `bumpfee` | `/wallet/bump-fee` |
| `sendrawtransaction` | `/send`, `/anchor`, `/bump-fee` |
| `getblockcount` | metrics |

### 4.3 Network handling

`ARCHON_WALLET_NETWORK` must match the Core node's network. Accepted
values and their Core equivalents:

| WalletNetwork | Core chain | Default port |
| --- | --- | --- |
| `mainnet` | `main` | 8332 |
| `signet` | `signet` | 38332 |
| `testnet4` | `testnet4` | 48332 |

Only these three are supported — `regtest` is intentionally omitted.

---

## 5. Lifecycle and configuration

### 5.1 Startup

1. Read env; validate network.
2. Wait for Core by polling until `walletcreatefundedpsbt` or
   `getblockchaininfo` succeeds (the TS reference waits implicitly
   during `/wallet/setup`).
3. Start the metrics HTTP server (separate port).
4. Start the main HTTP server.

The service does NOT eagerly run `/wallet/setup` — the first caller
must POST to it explicitly. This lets the deployer decide when the
watch-only wallet is created (typically the satoshi-mediator hits it on
its own startup).

### 5.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_WALLET_PORT` | `4240` | Main HTTP port. |
| `ARCHON_WALLET_METRICS_PORT` | `4241` | Prometheus port (separate listener). |
| `ARCHON_KEYMASTER_URL` | `http://localhost:4226` | |
| `ARCHON_ADMIN_API_KEY` | empty | Shared admin key between Keymaster / wallet / mediator. |
| `ARCHON_WALLET_BTC_HOST` | `localhost` | bitcoind RPC host. |
| `ARCHON_WALLET_BTC_PORT` | `38332` (signet) | bitcoind RPC port. |
| `ARCHON_WALLET_BTC_USER` / `ARCHON_WALLET_BTC_PASS` | empty | bitcoind RPC auth. |
| `ARCHON_WALLET_NAME` | `archon-watch-<nodeID>` | Core wallet name. |
| `ARCHON_WALLET_NETWORK` | `signet` | `mainnet` / `signet` / `testnet4`. |
| `ARCHON_WALLET_GAP_LIMIT` | `20` | Descriptor gap limit (address lookahead). |
| `ARCHON_WALLET_FEE_TARGET` | `6` | Confirmation target for `estimatesmartfee`. |
| `ARCHON_NODE_ID` | unset | Used only to form the default wallet name. |
| `GIT_COMMIT` | `unknown` | |

### 5.3 Shutdown

No explicit handler; the HTTP server closes on SIGTERM/SIGINT by
default. The watch-only wallet stays loaded in Core across restarts.

---

## 6. Prometheus metrics contract

Binds to the metrics port (separate from the API port). Refreshed every
60 seconds in the background:

| Metric | Type | Labels |
| --- | --- | --- |
| `wallet_setup_status` | gauge | (none) — 1 if the watch-only wallet is ready, 0 otherwise |
| `wallet_balance_confirmed` | gauge | (none) — BTC |
| `wallet_balance_unconfirmed` | gauge | (none) — BTC |
| `wallet_utxo_count` | gauge | (none) |
| `wallet_fee_estimate` | gauge | (none) — sat/vB |
| `wallet_block_height` | gauge | (none) |
| `wallet_sends_total` | counter | `status` (`success` / `failed`) |
| `wallet_http_requests_total` | counter | `method`, `route`, `status` |

Plus `service_version_info{version,commit}` and standard Prometheus
process metrics.

Route normalization on the `route` label:

```
/wallet/transaction/<txid>  -> /wallet/transaction/:txid
```

Everything else is static.

---

## 7. Logging conventions

`pino` (production) or `morgan('dev')` (development). Errors are
structured via `pino` with `{ err }`. Nothing in the log output is
contractual for dashboards or log aggregators today.

---

## 8. Reference implementation and tests

- Source: [services/mediators/satoshi-wallet/](../../../../services/mediators/satoshi-wallet/)
- Derivation helpers: [src/derivation.ts](../../../../services/mediators/satoshi-wallet/src/derivation.ts)
- BTC wallet helpers (PSBT/sign/anchor/bump): [src/btc-wallet.ts](../../../../services/mediators/satoshi-wallet/src/btc-wallet.ts)
- Image: `ghcr.io/archetech/satoshi-wallet`

Verified end-to-end against:

- signet + real Bitcoin Core on the
  [docker-compose.btc-signet.yml](../../../../docker-compose.btc-signet.yml)
  stack.
- The satoshi-mediator anchor + RBF flow.

No isolated unit tests; conformance is observed via the mediator.

A conformant third implementation MUST:

- Honor the HTTP route table in [§2.1](#21-routes) including admin-key
  enforcement and response shapes.
- Use BIP84 derivation with coin_type 0 (mainnet) or 1 (testnet/signet)
  exactly.
- Create / import descriptors into a Core descriptor-wallet named
  `walletName`, with both external (`/0/*`) and internal (`/1/*`)
  ranges.
- Fetch the mnemonic from Keymaster on demand — never persist it.
- Cap `OP_RETURN` payloads at 80 UTF-8 bytes.
- Support RBF via `bump-fee` (requires the pending tx to opt in by
  setting `nSequence` appropriately; Core's `bumpfee` handles this when
  the original tx was created with default policy).
- Expose the metrics in [§6](#6-prometheus-metrics-contract) for the
  existing Grafana dashboards.
