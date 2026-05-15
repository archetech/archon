# filecoin-wallet

REST service that pins Archon DID operation CIDs to Filecoin using the [filecoin-pin](https://www.npmjs.com/package/filecoin-pin) / Synapse SDK.

## What it does

Each Archon DID operation is stored as a DAG-CBOR node on IPFS. When a user opts in to Filecoin storage, this service:

1. Exports the operation as a CAR file via the IPFS `dag/export` API
2. Checks Filecoin Pay balance readiness (USDFC stablecoin via Synapse)
3. Uploads the CAR to a Filecoin storage provider
4. Waits for IPNI (InterPlanetary Network Indexer) to confirm retrievability

Pin state is held in memory; each pin record tracks status (`queued → pinning → pinned | failed`), the operation CID, the DID it belongs to, and the resulting Filecoin piece CID.

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/wallet/anchor` | none | Submit a CID for pinning |
| `GET` | `/api/v1/wallet/pins` | none | List all pin records |
| `GET` | `/api/v1/wallet/pin/:id` | none | Get pin status by request ID |
| `DELETE` | `/api/v1/wallet/pin/:id` | admin key | Remove a pin record |
| `GET` | `/api/v1/wallet/balance` | admin key | Filecoin Pay balance info |
| `GET` | `/api/v1/wallet/version` | none | Service version + config |

Metrics (Prometheus) exposed on port 4243.

## Configuration

| Variable | Description |
|----------|-------------|
| `ARCHON_FIL_PRIVATE_KEY` | `0x`-prefixed secp256k1 private key (Option A) |
| `ARCHON_FIL_WALLET_ADDRESS` | Wallet address for session key auth (Option B) |
| `ARCHON_FIL_SESSION_KEY` | Session key for session key auth (Option B) |
| `ARCHON_FIL_NETWORK` | `calibration` or `mainnet` (default: `calibration`) |
| `ARCHON_IPFS_API_URL` | Kubo API endpoint (default: `http://localhost:5001`) |
| `ARCHON_ADMIN_API_KEY` | Key required for admin endpoints |
| `ARCHON_FIL_WALLET_PORT` | HTTP port (default: `4242`) |

**First-time setup** — deposit USDFC into Filecoin Pay before first use:
```bash
npx filecoin-pin payments setup --network calibration --private-key 0x...
npx filecoin-pin payments deposit --network calibration --private-key 0x... --amount 10
```

## Run

```bash
npm install
npm run dev     # tsx (development)
npm run build   # compile to dist/
npm start       # node dist/wallet-api.js (production)
```
