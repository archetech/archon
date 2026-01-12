# Archon Satoshi Inscribed mediator

The Satoshi Inscribed mediator is designed to operate with all blockchains derived from Bitcoin core that support Taproot, that support the standard RPC interface to the blockchain (Feathercoin, Litecoin, Tesseract, etc.)

The mediator has two responsibilities:
- **Import**: Scans all confirmed transactions for Archon Operations found in a Taproot reveal transaction's witness. If a DID is discovered, the mediator resolves it.
- **Export**: Creates batches and registers them on the blockchain. The mediator polls its corresponding Gatekeeper queue for new operations. If it finds new operations, it creates and sends a new transaction that encodes the operation batch in a Taproot reveal transaction's witness

## Environment variables

| variable                  | default               | description                                                       |
|---------------------------|-----------------------|-------------------------------------------------------------------|
| `ARCHON_NODE_ID       `       | (no default)          | Keymaster agent name                                              |
| `ARCHON_GATEKEEPER_URL`       | http://localhost:4224 | Archon gatekeeper service URL                                       |
| `ARCHON_KEYMASTER_URL`        | http://localhost:4226 | Archon keymaster service URL                                        |
| `ARCHON_ENCRYPTED_PASSPHRASE` | (no default)          | If specified, the wallet will be decrypted with this passphrase   |
| `ARCHON_SAT_CHAIN`            | BTC                   | Blockchain ticker symbol                                          |
| `ARCHON_SAT_NETWORK`          | mainnet               | `mainnet` or `testnet`                                            |
| `ARCHON_SAT_HOST`             | localhost             | Host where blockchain node is running                             |
| `ARCHON_SAT_PORT`             | 8332                  | Port where blockchain node is running                             |
| `ARCHON_SAT_WALLET`           | (no default)          | Blockchain node wallet to use                                     |
| `ARCHON_SAT_USER`             | (no default)          | Blockchain node RPC user                                          |
| `ARCHON_SAT_PASS`             | (no default)          | Blockchain node RPC password                                      |
| `ARCHON_SAT_IMPORT_INTERVAL`  | 0                     | Minutes between import cycles (0 to disable)                      |
| `ARCHON_SAT_EXPORT_INTERVAL`  | 0                     | Mintues between export cycles (0 to disable)                      |
| `ARCHON_SAT_FEE_BLOCK_TARGET` | 1                     | Confirmation target for the fee                                   |
| `ARCHON_SAT_FEE_FALLBACK_SAT_BYTE` | 10               | Fallback Sat/Byte if estimatesmartfee does not have enough data   |
| `ARCHON_SAT_FEE_MAX`          | 0.00002               | Maximum transaction fee                                           |
| `ARCHON_SAT_RBF_ENABLED`      | false                 | Whether Replace-By-Fee is enabled                                 |
| `ARCHON_SAT_START_BLOCK`      | 0                     | Blockchain scan starting block index                              |
| `ARCHON_SAT_REIMPORT`         | true                  | Whether to reimport all discovered batches on startup             |
| `ARCHON_SAT_DB`               | json                  | Database adapter, must be `redis`, `json`, `mongodb`, or `sqlite` |
