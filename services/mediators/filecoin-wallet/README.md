# Filecoin Wallet Service

The Filecoin wallet service derives a Filecoin/Synapse payment wallet from the
Keymaster mnemonic and exposes an admin-only synchronous pin API:

`POST /api/v1/wallet/pin`

Requests must include `X-Archon-Admin-Key`. The service exports the Archon IPFS
DAG for the requested CID as CAR data and uploads it through Filecoin/Synapse.
