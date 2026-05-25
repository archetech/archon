# Archon Filecoin Wallet Service

The Filecoin wallet service owns Filecoin / Filecoin Pay key derivation,
Synapse session setup, IPFS DAG export, and CAR upload for the
[filecoin-mediator](../filecoin/README.md). The mediator calls this
service instead of holding any wallet material itself.

The wallet derives an FEVM-compatible f410 address from the Keymaster
mnemonic and uses it as the Filecoin Pay payer for Synapse uploads. The
default derivation path is `m/44'/461'/0'/0/0` (BIP-44 coin type 461 =
Filecoin).

The canonical implementation is
[services/mediators/filecoin-wallet/](../../../../services/mediators/filecoin-wallet/).

> **Related specs.** The filecoin-wallet is invoked exclusively by the
> [filecoin-mediator](../filecoin/README.md). It pulls its mnemonic from
> the [Keymaster](../../keymaster/README.md) and reads CAR data from the
> local IPFS HTTP API (Kubo-compatible).

---

## 1. Service responsibilities

A single synchronous pin endpoint plus a small status surface. There is
no background loop, no chain scanner, and no `/wallet/send` /
`/wallet/anchor` routes — Filecoin Pay handles deposits implicitly
during upload and there is no concept of an Archon "anchor" on Filecoin.

### 1.1 Pin flow (`POST /api/v1/wallet/pin`)

For each request:

1. `POST ${ARCHON_IPFS_API_URL}/dag/export?arg=<cid>` — fetch the CAR
   bytes for the requested CID from the local IPFS node. (Kubo's HTTP
   RPC uses POST for all endpoints, even read-only ones.)
2. Write the bytes to a temp file under `os.tmpdir()`.
3. Lazily initialise the Synapse client (`initializeSynapse`) with the
   derived private key and the configured chain (`mainnet` or
   `calibration`).
4. `synapse.storage.prepare({ dataSize })` — if Filecoin Pay needs a
   deposit or approval to cover the upload, execute that transaction
   first and record the deposit tx hash.
5. `checkUploadReadiness({ synapse, fileSize })` — fail fast with
   `Filecoin payment not ready: <reason>` if the balance still does not
   cover the upload after the deposit step.
6. `executeUpload(synapse, carStream, rootCid, { pieceMetadata })` —
   stream the CAR file to a Filecoin storage provider via Synapse,
   attaching `archonCid`, `archonFingerprint`, and `archonRegistry`
   piece metadata.
7. Delete the temp CAR file (always, even on error).
8. Return the result.

The Synapse client is cached at module scope after first use; it is
only torn down implicitly when the process restarts or when a new
mnemonic is configured.

### 1.2 Mnemonic loading

At startup the service polls `GET ${ARCHON_KEYMASTER_URL}/api/v1/wallet/mnemonic`
(with `X-Archon-Admin-Key`) up to 12 times with a 10 s backoff. If all
attempts fail, the service starts anyway with `wallet_setup_status = 0`
and every pin request will return `500` until Keymaster recovers and
the process is restarted.

---

## 2. HTTP API contract

All /api/v1 routes are mounted at `/api/v1` and require `X-Archon-Admin-Key`
matching `ARCHON_ADMIN_API_KEY`. The admin key is **mandatory**:
`ARCHON_ADMIN_API_KEY` must be set or every `/api/v1/*` request is
rejected with `403 { "error": "Admin API key not configured" }`. With
the key set, a missing header returns `401 { "error": "Admin API key
required" }` and a mismatched header returns
`401 { "error": "Invalid admin API key" }` (constant-time compared).

### 2.1 `GET /api/v1/wallet/version`

```json
{
  "version": "0.4.0",
  "commit":  "abcd123",
  "network": "calibration",
  "address": "0x…",            // null if wallet setup failed
  "derivationPath": "m/44'/461'/0'/0/0",
  "ipfsApiUrl":     "http://ipfs:5001/api/v0"
}
```

### 2.2 `GET /api/v1/wallet/balance`

Returns the full Filecoin Pay payment status from
`filecoin-pin/core/payments.getPaymentStatus`, with all `BigInt`s
serialised as decimal strings:

```jsonc
{
  "address":        "0x…",
  "filBalance":     "<atto-FIL string>",
  "usdfcBalance":   "<USDFC string>",
  "paymentsApproved":   true,
  "depositedUsdfc":     "<string>",
  // …additional fields from filecoin-pin's PaymentStatus
  "derivationPath": "m/44'/461'/0'/0/0"
}
```

This is the canonical place for the operator to see how much FIL /
USDFC the wallet has. The filecoin-mediator does **not** call this
endpoint preemptively — it only calls `wallet/version` (for the
funding address) after a pin failure that mentions insufficient funds.

### 2.3 `POST /api/v1/wallet/pin`

Request:

```json
{
  "cid":         "bafy…",        // required, the IPFS CID to pin
  "fingerprint": "<sha256 hex>",  // optional, echoed back and into piece metadata
  "registry":    "BTC:mainnet"    // optional, original Archon registry
}
```

Response (`WalletPinResult`):

```jsonc
{
  "requestid":   "<uuid v4>",
  "status":      "pinned",
  "cid":         "bafy…",
  "fingerprint": "<echo>",
  "registry":    "<echo>",
  "filecoin": {
    "pieceCid":      "baga…",
    "network":       "calibration",
    "ipniValidated": true,
    "depositTx":     "0x…"        // present only if Filecoin Pay deposit was made this call
  }
}
```

Errors:

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{ "error": "Missing or invalid \"cid\"" }` | `cid` missing or not a string. |
| `400` | `{ "error": "Invalid \"fingerprint\"" }` / `Invalid "registry"` | Provided fields not strings. |
| `500` | `{ "error": "Filecoin payment not ready: …" }` | Filecoin Pay balance insufficient after attempted top-up. The mediator detects `Insufficient FIL` / `USDFC` in this message and logs the funding address. |
| `500` | `{ "error": "<other>" }` | IPFS export failure, Synapse error, storage provider rejection, etc. |

The endpoint is synchronous and may take **minutes** for large payloads
(CAR export + Synapse upload + provider acknowledgement). The mediator
sends each pin request with a 300 s timeout.

### 2.4 Metrics surface

Separate Express app on `ARCHON_FIL_WALLET_METRICS_PORT` (default
`4272`):

| Method | Path | Body |
| --- | --- | --- |
| `GET` | `/health` | `{ ok: true }` |
| `GET` | `/metrics` | Prometheus |

---

## 3. Key derivation

The wallet treats Filecoin as an EVM-flavoured chain (FEVM) for
signing:

1. `bip39.mnemonicToSeedSync(mnemonic)` — BIP-39 seed.
2. `HDKey.fromMasterSeed(seed).derive(ARCHON_WALLET_FIL_DERIVATION_PATH)`
   — BIP-32 derivation. Default path `m/44'/461'/0'/0/0`.
3. Private key = child `privateKey` as `0x`-prefixed hex.
4. Address = `keccak_256(secp256k1.getPublicKey(privKey, uncompressed).slice(1)).slice(-20)`
   — standard EVM derivation, returned as `0x…` (this is the f410
   funding address for Filecoin Pay).

A given mnemonic + path therefore yields a stable address across
restarts and across host services that share the same Keymaster.

---

## 4. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_FIL_WALLET_PORT` | `4270` | Main HTTP API port. |
| `ARCHON_FIL_WALLET_METRICS_PORT` | `4272` | Metrics HTTP port. |
| `ARCHON_KEYMASTER_URL` | `http://localhost:4226` | Source of the wallet mnemonic. |
| `ARCHON_ADMIN_API_KEY` | unset | Required on every `/api/v1/*` request; also sent to Keymaster when fetching the mnemonic. |
| `ARCHON_WALLET_FIL_DERIVATION_PATH` | `m/44'/461'/0'/0/0` | BIP-32 path. |
| `ARCHON_FIL_NETWORK` | `calibration` | `mainnet` or `calibration`. Any other value crashes at startup. |
| `ARCHON_FIL_RPC_URL` | unset | Optional explicit Filecoin JSON-RPC URL passed to Synapse. When unset, Synapse uses its built-in default for the selected network. |
| `ARCHON_IPFS_API_URL` | `http://localhost:5001/api/v0` | Kubo HTTP API. `ARCHON_IPFS_URL` accepted as alias. The wallet normalises trailing slashes and appends `/api/v0` if missing. |
| `GIT_COMMIT` | `unknown` | Embedded in `/version` and `wallet_version_info`. |

The wallet does **not** read any of the `ARCHON_WALLET_BTC_*`,
`ARCHON_WALLET_ETH_*`, or `ARCHON_WALLET_ZEC_*` variables; coin-type
461 isolation is intentional.

---

## 5. Lifecycle

### 5.1 Startup

1. Read env (any unsupported `ARCHON_FIL_NETWORK` value crashes here).
2. Wire Express, JSON body parser, request-duration middleware, and
   the `/api/v1` admin-key guard.
3. Try to load the mnemonic from Keymaster (12 × 10 s).
4. On success: derive the address, cache it, set
   `wallet_setup_status = 1`.
5. On final failure: log the error, set
   `wallet_setup_status = 0`, and start anyway so `/health` and
   `/metrics` still serve.
6. Start the main HTTP server and the metrics HTTP server.
7. Register SIGINT / SIGTERM handlers that close the main server and
   exit `0`.

### 5.2 Reconfiguring the wallet

There is no `/wallet/setup` endpoint. To rotate the mnemonic, change
the Keymaster wallet and restart the filecoin-wallet container; the
Synapse client cache is cleared on `configureWallet`.

---

## 6. Prometheus metrics

| Metric | Type | Notes |
| --- | --- | --- |
| `filecoin_wallet_http_requests_total{method,route,status}` | Counter | Per-route HTTP request counts. |
| `filecoin_wallet_http_request_duration_seconds{method,route}` | Histogram | Buckets `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 30, 120]`. |
| `filecoin_wallet_pins_total{status="pinned"\|"failed"}` | Counter | Outcomes of `POST /wallet/pin`. |
| `wallet_setup_status` | Gauge | `1` if the mnemonic loaded and address derived, else `0`. |
| `wallet_version_info{version,commit}` | Gauge | Always `1`. |

Plus standard `prom-client` default process / nodejs metrics.

---

## 7. Reference implementation and tests

- Source: [services/mediators/filecoin-wallet/](../../../../services/mediators/filecoin-wallet/)
- Image: `ghcr.io/archetech/filecoin-wallet`
- Companion mediator spec: [filecoin/README.md](../filecoin/README.md)

No dedicated conformance tests. Validation is manual: stand up
filecoin-wallet against Filecoin calibration, pin a small CID (e.g. a
hello-world JSON pinned to local IPFS first via `gatekeeper.addJSON`),
verify `wallet/balance` shows the deposit, then re-pin and confirm the
second call skips the deposit transaction.

A conformant third implementation MUST:

- Accept `{ cid, fingerprint?, registry? }` at
  `POST /api/v1/wallet/pin` and return the `WalletPinResult` shape in
  §2.3, including a stable `requestid` per call.
- Export CAR data from the configured IPFS HTTP API rather than
  fetching from a public gateway, so requests stay within the operator's
  trust boundary.
- Require a configured `ARCHON_ADMIN_API_KEY` and reject every
  `/api/v1/*` request that does not present a matching
  `X-Archon-Admin-Key` (403 when unconfigured, 401 when missing or
  mismatched). The wallet has no anonymous mode.
- Not expose any private-key, sign, or send routes — Filecoin Pay
  flows are the only intended use of this wallet.
