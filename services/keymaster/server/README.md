# Archon Keymaster REST API server

The Keymaster service exposes the Keymaster client library as a REST API.
This is necessary if the client is written is a programming language other than Javascript or Typescript, such as python.
This service is also useful when clients share a wallet, such as the `archon` CLI and Archon mediators running on a server node.

## Environment variables

| variable              | default                | description                   |
| --------------------- | ---------------------- | ----------------------------- |
| `ARCHON_GATEKEEPER_URL`   | http://localhost:4224  | Archon gatekeeper service URL   |
| `ARCHON_KEYMASTER_PORT`   | 4226 | Service port                                    |
| `ARCHON_KEYMASTER_DB`     | json | Wallet database adapter, must be `redis`, `json`, `mongodb`, or `sqlite` |
| `ARCHON_ENCRYPTED_PASSPHRASE` |  (no default) | If specified, the wallet will be encrypted and decrypted with this passphrase  |
| `ARCHON_WALLET_CACHE`     |  false | Use wallet cache to increase performance (but understand security implications)  |
| `ARCHON_DEFAULT_REGISTRY` |  hyperswarm | Default registry to use when creating DIDs               |
