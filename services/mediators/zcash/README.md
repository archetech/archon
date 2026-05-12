# Archon Zcash mediator

The Zcash mediator mirrors the Satoshi mediator import/export flow for
transparent Zcash anchors. It scans Zebra blocks for `OP_RETURN`
payloads containing `did:cid:` batch DIDs, imports discovered batches
into Gatekeeper, and exports queued operations by calling the companion
`zcash-wallet` service.

## Responsibilities

- **Import**: scan confirmed Zcash blocks for Archon batch DIDs in
  transparent transaction `OP_RETURN` outputs.
- **Export**: batch Gatekeeper queue operations for `ZEC:*` registries,
  publish the batch asset via Keymaster, and ask `zcash-wallet` to anchor
  the batch DID.
- **Block sync**: report Zcash block hashes/heights to Gatekeeper under
  the configured registry.

The mediator uses Zebra for chain RPCs and the `zcash-wallet` service for
funding, signing, and broadcasting transparent transactions. Shielded and
unified-address flows are intentionally out of scope for v1.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `ARCHON_NODE_ID` | unset | Required for export mode. |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper service URL. |
| `ARCHON_KEYMASTER_URL` | unset | Keymaster service URL. |
| `ARCHON_ADMIN_API_KEY` | unset | Shared admin key. |
| `ARCHON_WALLET_URL` | unset | Required for export mode; points to `zcash-wallet`. |
| `ARCHON_ZEC_CHAIN` | `ZEC:mainnet` | Registry name. |
| `ARCHON_ZEC_NETWORK` | `mainnet` | `mainnet`, `testnet`, or `regtest`. |
| `ARCHON_ZEC_HOST` | `100.70.86.134` | Zebra RPC host. |
| `ARCHON_ZEC_PORT` | `8232` | Zebra RPC port. |
| `ARCHON_ZEC_USER` / `ARCHON_ZEC_PASS` | unset | Optional Zebra RPC auth. |
| `ARCHON_ZEC_IMPORT_INTERVAL` | `0` | Minutes between import loops; `0` disables importing. |
| `ARCHON_ZEC_EXPORT_INTERVAL` | `0` | Minutes between export loops; `0` makes the mediator read-only. |
| `ARCHON_ZEC_FEE_BLOCK_TARGET` | `1` | Fee target used for local/oracle fee choice. |
| `ARCHON_ZEC_FEE_FALLBACK_ZAT_BYTE` | `10` | Fallback zats/vB for wallet anchor calls. |
| `ARCHON_ZEC_FEE_MAX` | `0.0001` | Minimum balance threshold before exporting. |
| `ARCHON_ZEC_FEE_ORACLE_URL` | unset | Optional external fee oracle with mempool.space-compatible fields. |
| `ARCHON_ZEC_RBF_ENABLED` | `false` | Kept for config parity; fee bumping is unsupported in v1. |
| `ARCHON_ZEC_START_BLOCK` | `0` | First block height to scan/sync. |
| `ARCHON_ZEC_REIMPORT` | `true` | Reprocess discovered batches on startup. |
| `ARCHON_ZEC_DB` | `json` | `json`, `sqlite`, `mongodb`, or `redis`. |
| `ARCHON_ZEC_DB_NAME` | derived from chain | Persister name/key. |
| `ARCHON_ZEC_METRICS_PORT` | `4238` | Metrics HTTP port. |

## Notes

- The registry must also be configured in Gatekeeper, for example
  `ARCHON_GATEKEEPER_REGISTRIES=hyperswarm,ZEC:mainnet`.
- `zcash-wallet` currently returns `501` for `/wallet/bump-fee`, so this
  mediator waits for pending anchors rather than replacing them.
