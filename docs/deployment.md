# Archon Deployment Guide

This guide walks you through deploying an Archon node, from a core DID-only setup to a full registry, Drawbridge, and Lightning-enabled stack. Each section builds on the previous one — start with the core and add layers as needed.

For the full stack (`docker-compose.yml` and its profiles), every `.env` change and every start, stop or update in this guide can also be made from a browser with [node-runner](#2-managing-the-node-with-node-runner), which shows what each change will do before it runs. The minimal stack in [§3](#3-core-node-did-only) is run from the shell.

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Managing the Node with node-runner](#2-managing-the-node-with-node-runner)
3. [Core Node (DID Only)](#3-core-node-did-only)
4. [Adding Bitcoin Registries](#4-adding-bitcoin-registries)
5. [Adding Zcash Registry](#5-adding-zcash-registry)
6. [Adding Ethereum Registry](#6-adding-ethereum-registry)
7. [Adding Solana Registry](#7-adding-solana-registry)
8. [Adding Generic IPFS Pinning](#8-adding-generic-ipfs-pinning)
9. [Adding Drawbridge (API Gateway + Tor)](#9-adding-drawbridge-api-gateway--tor)
10. [Bundled Lightning Stack (Optional)](#10-bundled-lightning-stack-optional)
11. [Production Hardening](#11-production-hardening)
12. [Port Reference](#12-port-reference)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Prerequisites

- **Docker** v20.10+ and **Docker Compose** **v2.20+**
  (the compose files use `depends_on: … required: false`, added in 2.20; older
  Compose fails to parse the merged file, which breaks every profile, not just
  the one you enabled — check with `docker compose version`)
- **Git** to clone the repository
- A machine with at least 4 GB RAM (8 GB+ recommended with Lightning)

### Initial Setup

```bash
git clone https://github.com/archetech/archon.git
cd archon
cp sample.env .env
```

To try a node out before configuring the full stack, use the minimal compose
file instead — see [§3](#3-core-node-did-only).

Set your user/group IDs so containers run with the correct permissions:

```bash
# Add these to your .env
ARCHON_UID=$(id -u)
ARCHON_GID=$(id -g)
```

Generate an admin API key:

```bash
# Add to .env as ARCHON_ADMIN_API_KEY
openssl rand -hex 32
```

Internal service-to-service admin requests use the `X-Archon-Admin-Key` header. Reserve `Authorization` for user/session/OAuth-style flows.

### Data Directories

All persistent data lives under `./data/`. Create the directory and ensure it's owned by your user:

```bash
mkdir -p data
```

---

## 2. Managing the Node with node-runner

node-runner is a web app for operating the node: container state and health,
merged service logs, editing `.env`, starting, stopping and restarting
services, and updating to a new release or to `main`. It runs as its own
Compose project, so stopping the node does not stop it. It manages the full
stack defined by `docker-compose.yml`; it does not use
`docker/compose/minimal.yml`, so run the minimal stack from the shell.

It needs the checkout. If you have not created `.env` as in
[Initial Setup](#initial-setup), node-runner's Configuration page creates it
from `sample.env`, with your user and group, a generated admin key and a wallet
passphrase you choose, and no profiles enabled. From the node directory:

```bash
./setup-node
```

It builds and starts node-runner (`./node-runner up -d --build`), then prints
the address to open and, until an admin password is set, the one-time setup
code. The first visit asks for that code and then for an admin password. Run
it again to update node-runner or to see the address and code again; the code
is also in `data/node-runner/setup-code` and in node-runner's log
(`./node-runner logs`).

node-runner listens on http://127.0.0.1:4280. On a remote host, tunnel the
port first (over SSH, `./setup-node` prints this command):

```bash
ssh -L 4280:127.0.0.1:4280 <host>
```

The rest of this guide still applies: its sections explain what each profile
and setting does. Instead of editing `.env` and running `docker compose up -d`,
make the same changes on node-runner's Configuration page, where the review
shows which services each change rebuilds, recreates, starts or stops before
it runs.

node-runner holds the Docker socket, which is root-equivalent on the host, so
it listens on loopback by default. Reach it through an SSH tunnel, a VPN, or
your own reverse proxy with TLS, and do not expose it through Drawbridge or
Tor. `ARCHON_NODE_RUNNER_HOST_BIND` and `ARCHON_NODE_RUNNER_PORT` in `.env`
change the address.

The [node-runner guide](https://github.com/archetech/archon/blob/main/services/node-runner/README.md)
covers sign-in, configuration changes, starting and stopping, and updates.

---

## 3. Core Node (DID Only)

### Trying It Out: the Minimal Stack

To see a node work before committing to the full configuration, use the minimal
compose file and its own env sample:

```bash
git clone https://github.com/archetech/archon.git
cd archon
cp minimal-sample.env .env
docker compose --env-file .env -f docker/compose/minimal.yml up
```

That starts six services — IPFS, Redis, Gatekeeper, Keymaster, the hyperswarm
mediator, and the CLI container — and nothing else. `minimal-sample.env`
carries only the variables that stack reads, with placeholders where a value is
mandatory, so the node runs as copied. Replace both `CHANGE_ME` placeholders before the node
holds anything you care about. `ARCHON_ADMIN_API_KEY` gates the API — generate
one with `openssl rand -hex 32`. `ARCHON_PASSPHRASE` encrypts the
wallet mnemonic, and editing it later re-encrypts nothing: it leaves the
existing wallet undecryptable, so rotate it with the CLI's `change-passphrase`
first (see below) and then update the variable.

### Driving the Node

The CLI container is how you work with a node that has no UI. It idles, and the
`./archon` script in the repository root execs into it. That script calls
`docker compose` with no `-f`, so point it at this stack once per shell:

```bash
export COMPOSE_FILE=docker/compose/minimal.yml

# Create an identity, published to the hyperswarm registry
./archon create-id alice

# List what the wallet holds, and resolve the DID back
./archon list-ids
./archon resolve-id alice
```

`./archon -h` lists the rest, and `./admin` and `./ipfs` reach the admin and
IPFS CLIs the same way. The CLI reads `ARCHON_ADMIN_API_KEY` from the
environment the compose file gives it, so it authenticates without further
setup.

The same operations are available over HTTP if you would rather not use the
container. Gatekeeper answers on port 4224 and Keymaster on 4226:

```bash
# Gatekeeper is up
curl -s localhost:4224/api/v1/version

# Resolution is public — no admin key
curl -s localhost:4224/1.0/identifiers/<did>
```

Keymaster's API requires `X-Archon-Admin-Key` on every route, so reach it with
the value you set in `.env`.

### How This Differs From the Full Stack

This is a different stack from the profile-gated one below, in two ways worth
knowing:

- **It includes the hyperswarm mediator**, so DIDs are actually published to
  peers. The base compose with no profiles has no registry mediator at all,
  which means DIDs stay local.
- **It does not include the optional fragments.** With `minimal-sample.env`,
  `minimal.yml` resolves with no warnings at all, where the base compose emits
  141 `variable is not set` warnings for values those fragments reference.

Everything below describes the full `docker-compose.yml`, which is where to go
once you want registries, a gateway, or the UIs. `minimal.yml` will not gain
those, so moving on means copying `sample.env` and running plain
`docker compose up` — the data directories and volumes carry over.

### The Full Compose File

The base `docker-compose.yml` always includes the optional compose fragments, but their services are gated by Docker Compose profiles. Leave `COMPOSE_PROFILES` empty to run only the core DID services: Redis, IPFS, Gatekeeper, and Keymaster. (MongoDB is itself behind the `mongodb` profile — Redis is the default database.)

### Enable Optional Services

Set `COMPOSE_PROFILES` in `.env` to the comma-separated optional services you want:

```env
# Core DID node only
COMPOSE_PROFILES=

# Example full-ish node
COMPOSE_PROFILES=hyperswarm,cli,explorer,gatekeeper-client,keymaster-client,react-wallet,observability,btc-signet
```

Available profiles: `hyperswarm`, `cli`, `explorer`, `gatekeeper-client`, `keymaster-client`, `react-wallet`, `observability`, `btc-mainnet`, `btc-signet`, `btc-testnet4`, `lightning`, `drawbridge`, `herald`, `tor`, `didcomm`, `zcash-mainnet`, `eth-mainnet`, `eth-sepolia`, `sol-mainnet`, `sol-devnet`, `pinning`, and `filecoin`.

`drawbridge`, `lightning`, `herald`, and `tor` are independent — each starts only what it is named after, and they compose freely. See [§9](#9-adding-drawbridge-api-gateway--tor).

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_ADMIN_API_KEY` | *(empty)* | **Required.** Protects admin API routes, and on Keymaster the whole v1 API. Gatekeeper and Keymaster both refuse to start without it; mediators and the CLI use the same value to authenticate against it |
| `ARCHON_PASSPHRASE` | *(empty)* | **Required.** Passphrase for encrypting the wallet, and the value the CLIs and MCP server read. Keymaster won't start without it |
| `ARCHON_ENCRYPTED_PASSPHRASE` | *(empty)* | Older name for `ARCHON_PASSPHRASE`, still read so existing deployments keep working |
| `ARCHON_NODE_ID` | `mynodeID` | Alias for the node's agent DID (created on first run) |
| `ARCHON_NODE_NAME` | `mynodeName` | Human-readable node name for peer discovery |
| `COMPOSE_PROFILES` | sample default | Optional Docker Compose service profiles |
| `ARCHON_GATEKEEPER_PORT` | `4224` | Gatekeeper API port |
| `ARCHON_KEYMASTER_PORT` | `4226` | Keymaster API port |
| `ARCHON_KEYMASTER_HOST_BIND` | `127.0.0.1` | Keymaster host bind address |
| `ARCHON_GATEKEEPER_CLIENT_PORT` | `4225` | Gatekeeper client UI port |
| `ARCHON_REACT_WALLET_PORT` | `4228` | React wallet UI port |
| `ARCHON_GATEKEEPER_DB` | `redis` | Storage backend (`redis` or `json`) |
| `ARCHON_GATEKEEPER_DID_PREFIX` | `did:cid` | DID method prefix |
| `ARCHON_GATEKEEPER_REGISTRIES` | `hyperswarm` | Comma-separated list of registries |
| `ARCHON_DEFAULT_REGISTRY` | `hyperswarm` | Default registry for new DIDs |
| `ARCHON_PROTOCOL` | set in code | Hyperswarm topic seed. Changes only when the wire format does, so pinning it means missing exactly the bumps that matter. |
| `ARCHON_GATEKEEPER_CONFIRM_FALLBACK_URL` | *(empty)* | Optional Gatekeeper peer for `confirm=true` resolution when local data is not confirmed |

### Services

| Service | Description |
|---------|-------------|
| **mongodb** | Used by satoshi mediators for Bitcoin registry state |
| **redis** | Primary DID data store, cache, and pub/sub |
| **ipfs** | Content-addressable storage |
| **gatekeeper** | DID resolution and management API |
| **keymaster** | Wallet and credential management API |
| **hyperswarm-mediator** | P2P DID synchronization |
| **zcash-mainnet-mediator** | Optional transparent Zcash DID anchoring |
| **zcash-mainnet-wallet** | Optional transparent Zcash wallet for anchoring transactions |
| **cli** | Command-line interface container |
| **explorer** | DID explorer web app |
| **gatekeeper-client** | Browser UI for the Gatekeeper API |
| **keymaster-client** | Browser UI for the Keymaster service |
| **react-wallet** | Web wallet UI |
| **prometheus** | Metrics collection |
| **grafana** | Metrics dashboards |
| **pinning-mediator** | Optional generic IPFS pinning service backup |

### Start and Verify

```bash
COMPOSE_PROFILES= docker compose up -d
docker compose logs -f gatekeeper   # watch for startup

# Verify gatekeeper is running
curl http://localhost:4224/api/v1/version
```

Optional UIs when their profiles are enabled:

- Gatekeeper client: `http://localhost:4225`
- Keymaster client: `http://localhost:4226`
- React wallet: `http://localhost:4228`
- Explorer: `http://localhost:4000`

---

## 4. Adding Bitcoin Registries

Bitcoin registries anchor DIDs on-chain via the Satoshi mediator. Each bundled network also includes a dedicated watch-only wallet service under `services/mediators/satoshi-wallet`. There are separate compose files per network:

| File | Network | Bitcoin Node |
|------|---------|-------------|
| `docker/compose/btc-mainnet.yml` | BTC mainnet | **You provide** — requires an external Bitcoin Core node with RPC access |
| `docker/compose/btc-signet.yml` | BTC signet | Bundled — runs its own `bitcoin-core` container |
| `docker/compose/btc-testnet4.yml` | BTC testnet4 | Bundled — runs its own `bitcoin-core` container |

### Enable a Registry

Add the relevant profile to `COMPOSE_PROFILES`:

```env
COMPOSE_PROFILES=hyperswarm,btc-mainnet

# or
COMPOSE_PROFILES=hyperswarm,btc-signet
```

### Key Environment Variables (Mainnet)

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_BTC_HOST` | `localhost` | Bitcoin RPC host |
| `ARCHON_BTC_PORT` | `8332` | Bitcoin RPC port |
| `ARCHON_BTC_USER` | `bitcoin` | Bitcoin RPC username |
| `ARCHON_BTC_PASS` | `bitcoin` | Bitcoin RPC password |
| `ARCHON_BTC_WALLET` | `archon` | Bitcoin wallet name |
| `ARCHON_BTC_START_BLOCK` | `934000` | Block height to start scanning |
| `ARCHON_BTC_FEE_MAX` | `0.00010000` | Maximum fee per transaction (BTC) |

Signet and testnet4 have their own prefixed variables (`ARCHON_SIGNET_*`, `ARCHON_BTC_T4_*`) — see `sample.env` for the full list.

### Update Gatekeeper Registries

Add Bitcoin registries to the gatekeeper's registry list:

```env
ARCHON_GATEKEEPER_REGISTRIES=hyperswarm,BTC:mainnet
```

### Verify

```bash
# Mainnet mediator metrics
curl http://localhost:4234/metrics

# Signet mediator metrics (if enabled)
curl http://localhost:4236/metrics
```

---

## 5. Adding Zcash Registry

Zcash support is optional. If enabled, the Zcash registry anchors DID batches in transparent Zcash transactions via the Zcash mediator. The bundled compose layer includes both `zcash-mainnet-mediator` and a companion `zcash-mainnet-wallet` service. It expects an external Zebra node with RPC access; Zebra provides chain, address-index, and broadcast RPCs while the wallet derives transparent keys from Keymaster and signs locally.

Only transparent Zcash flows are supported in this stack. Shielded and unified-address wallet flows are intentionally out of scope for the current mediator.

### Enable Zcash

Add the Zcash profile to `COMPOSE_PROFILES`:

```env
COMPOSE_PROFILES=hyperswarm,zcash-mainnet
```

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_ZEC_HOST` | none | Zebra RPC host |
| `ARCHON_ZEC_PORT` | `8232` | Zebra RPC port |
| `ARCHON_ZEC_USER` | *(empty)* | Zebra RPC username, if configured |
| `ARCHON_ZEC_PASS` | *(empty)* | Zebra RPC password, if configured |
| `ARCHON_WALLET_ZEC_FALLBACK_FEE_ZAT_KB` | `10000` | Wallet fallback fee in zatoshis per KB |
| `ARCHON_ZEC_CHAIN` | `ZEC:mainnet` | Gatekeeper registry name |
| `ARCHON_ZEC_NETWORK` | `mainnet` | Zcash network name |
| `ARCHON_ZEC_START_BLOCK` | `3339235` | Block height to start scanning |
| `ARCHON_ZEC_IMPORT_INTERVAL` | `1` | Minutes between import scans; `0` disables importing |
| `ARCHON_ZEC_EXPORT_INTERVAL` | `1` | Minutes between export attempts; `0` makes the mediator read-only |
| `ARCHON_ZEC_FEE_BLOCK_TARGET` | `1` | Fee target used for local/oracle fee selection |
| `ARCHON_ZEC_FEE_FALLBACK_ZAT_BYTE` | `10` | Mediator fallback fee in zatoshis per virtual byte |
| `ARCHON_ZEC_FEE_MAX` | `0.00010000` | Maximum fee budget in ZEC |
| `ARCHON_ZEC_FEE_ORACLE_URL` | *(empty)* | Optional external fee oracle |
| `ARCHON_ZEC_RBF_ENABLED` | `false` | Config parity flag; fee bumping is not supported yet |
| `ARCHON_ZEC_REIMPORT` | `true` | Reprocess discovered batches on startup |
| `ARCHON_ZEC_DB` | `json` | Mediator state backend: `json`, `sqlite`, `mongodb`, or `redis` |

### Verify

```bash
# Zcash mediator metrics
curl http://localhost:4238/metrics

# Zcash wallet metrics
curl http://localhost:4251/metrics
```

Grafana includes chain mediator dashboards, including **Zcash Mediator (ZEC:mainnet)**, when the observability stack is enabled.

### Confirmed Resolution Without Local Zcash

If you do not enable the `zcash-mainnet` profile, you can still delegate confirmed Zcash resolution to another Gatekeeper node that does track `ZEC:mainnet`:

```env
ARCHON_GATEKEEPER_CONFIRM_FALLBACK_URL=https://gatekeeper.example.com
```

This fallback is only used for `confirm=true` requests when the local node can resolve a DID but cannot confirm it locally. It does not import Zcash events, run a wallet, or make this node able to anchor new Zcash operations.

---

## 6. Adding Ethereum Registry

Ethereum support is optional. If enabled, the Ethereum registry anchors DID batches by submitting transactions to a canonical `ArchonRegistry` smart contract and importing its `ArchonBatch` events. The bundled compose layers include mainnet (`eth-mainnet-mediator` plus `eth-mainnet-wallet`) and Sepolia (`eth-sepolia-mediator` plus `eth-sepolia-wallet`) variants. The wallet derives an EVM account from the Keymaster mnemonic and signs transactions; the mediator scans logs and imports batches.

Mainnet uses the canonical `ETH:mainnet` contract. Sepolia is intended for testing. Future production L2 deployments should use a canonical contract on the chosen chain, with L2s such as Base, Optimism, or Arbitrum preferred when low anchoring cost matters.

Ethereum mediators record Gatekeeper block checkpoints for the configured start block, every 10th finalized block, and every block that contains an `ArchonBatch` event. This keeps timestamp bounds tight without storing every empty Ethereum block in Gatekeeper.

Ethereum import RPC endpoints must support the `finalized` block tag. Discovery,
checkpoint sync, and retries stop at that height with no confirmation-depth
fallback; `ARCHON_ETH_CONFIRMATIONS` has been removed. On upgrade, existing receipts are
preserved while imports wait for finality to reach the legacy cursor. Recovery
is needed only if its block hash has changed.
See [Ethereum finality and upgrade behavior](services/mediators/ethereum/README.md#finalized-imports-and-upgrade).


### Enable Ethereum Mainnet

Add the Ethereum mainnet profile to `COMPOSE_PROFILES`:

```env
COMPOSE_PROFILES=hyperswarm,eth-mainnet
```

Add the registry to Gatekeeper:

```env
ARCHON_GATEKEEPER_REGISTRIES=hyperswarm,ETH:mainnet
```

### Enable Ethereum Sepolia

For test deployments, use the Sepolia profile instead:

```env
COMPOSE_PROFILES=hyperswarm,eth-sepolia
```

Add the registry to Gatekeeper:

```env
ARCHON_GATEKEEPER_REGISTRIES=hyperswarm,ETH:sepolia
```

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_ETH_RPC_URL` | none | Ethereum JSON-RPC endpoint |
| `ARCHON_ETH_CONTRACT` | none | Canonical `ArchonRegistry` contract address |
| `ARCHON_ETH_CHAIN` | `ETH:mainnet` | Gatekeeper registry name |
| `ARCHON_ETH_NETWORK` | `mainnet` | Ethereum network name |
| `ARCHON_ETH_CHAIN_ID` | `1` | EVM chain ID |
| `ARCHON_ETH_START_BLOCK` | `0` | Block height to start scanning |
| `ARCHON_ETH_LOG_CHUNK_SIZE` | `2000` | Blocks per `eth_getLogs` request |
| `ARCHON_ETH_IMPORT_INTERVAL` | `1` | Minutes between import scans; `0` disables importing |
| `ARCHON_ETH_EXPORT_INTERVAL` | `1` | Minutes between export attempts; `0` makes the mediator read-only |
| `ARCHON_ETH_REIMPORT` | `true` | Reprocess discovered batches on startup |
| `ARCHON_ETH_DB` | `json` | Mediator state backend: `json`, `sqlite`, `mongodb`, or `redis` |
| `ARCHON_WALLET_ETH_DERIVATION_PATH` | `m/44'/60'/0'/0/0` | EVM account derivation path |

### Verify

```bash
# Ethereum mainnet mediator metrics
curl http://localhost:4246/metrics

# Ethereum mainnet wallet metrics
curl http://localhost:4255/metrics

# Ethereum Sepolia mediator metrics
curl http://localhost:4239/metrics

# Ethereum Sepolia wallet metrics
curl http://localhost:4253/metrics
```

The reference Solidity contract lives at `services/mediators/ethereum/contracts/ArchonRegistry.sol`.

---

## 7. Adding Solana Registry

Solana support is optional. If enabled, the Solana registry anchors DID batches by submitting Solana Memo transactions with an Archon-specific payload and importing matching memos back into Gatekeeper. The bundled compose layers include mainnet (`sol-mainnet-mediator` plus `sol-mainnet-wallet`) and devnet (`sol-devnet-mediator` plus `sol-devnet-wallet`) variants. The wallet derives a Solana account from the Keymaster mnemonic and signs transactions; the mediator scans an Archon registry address included in Memo transactions and imports batches.

Mainnet uses the canonical `SOL:mainnet-beta` memo registry. Devnet is intended for testing. Future custom Solana programs should use a distinct canonical registry decision.

### Enable Solana Mainnet

Add the Solana mainnet profile to `COMPOSE_PROFILES`:

```env
COMPOSE_PROFILES=hyperswarm,sol-mainnet
```

Add the registry to Gatekeeper:

```env
ARCHON_GATEKEEPER_REGISTRIES=hyperswarm,SOL:mainnet-beta
```

### Enable Solana Devnet

For test deployments, use the Devnet profile instead:

```env
COMPOSE_PROFILES=hyperswarm,sol-devnet
```

Add the registry to Gatekeeper:

```env
ARCHON_GATEKEEPER_REGISTRIES=hyperswarm,SOL:devnet
```

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_SOL_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC endpoint |
| `ARCHON_SOL_CHAIN` | `SOL:mainnet-beta` | Gatekeeper registry name |
| `ARCHON_SOL_NETWORK` | `mainnet-beta` | Solana network name |
| `ARCHON_SOL_COMMITMENT` | `confirmed` | Commitment level for reads and writes |
| `ARCHON_SOL_MEMO_PROGRAM_ID` | Memo program | Memo program ID used for Archon anchors |
| `ARCHON_SOL_REGISTRY_ADDRESS` | derived | Address included in Archon memo transactions and scanned for discovery |
| `ARCHON_SOL_START_BLOCK` | `0` | Produced block height to start checkpointing and importing/registering |
| `ARCHON_SOL_SIGNATURE_PAGE_LIMIT` | `100` | Signatures per scan page |
| `ARCHON_SOL_SIGNATURE_PAGE_MAX` | `20` | Maximum scan pages per import loop |
| `ARCHON_SOL_PENDING_TX_TIMEOUT_SLOTS` | `150` | Slots to wait before re-anchoring stale pending transactions |
| `ARCHON_SOL_IMPORT_INTERVAL` | `1` | Minutes between import scans; `0` disables importing |
| `ARCHON_SOL_EXPORT_INTERVAL` | `1` | Minutes between export attempts; `0` makes the mediator read-only |
| `ARCHON_SOL_REIMPORT` | `true` | Reprocess discovered batches on startup |
| `ARCHON_SOL_DB` | `json` | Mediator state backend: `json`, `sqlite`, `mongodb`, or `redis` |
| `ARCHON_WALLET_SOL_DERIVATION_PATH` | `m/44'/501'/0'/0'` | Solana account derivation path |

### Verify

```bash
# Solana mainnet mediator metrics
curl http://localhost:4248/metrics

# Solana mainnet wallet metrics
curl http://localhost:4257/metrics

# Solana Devnet mediator metrics
curl http://localhost:4249/metrics

# Solana Devnet wallet metrics
curl http://localhost:4263/metrics
```

---

## 8. Adding Generic IPFS Pinning

Archon can back up selected operation CIDs to an external IPFS pinning service through the generic `pin` queue. This is cheaper than per-operation Filecoin storage for small DID operations and keeps the provider separate from canonical DID registries.

### Enable Generic Pinning

Add the pinning profile to `COMPOSE_PROFILES`:

```env
COMPOSE_PROFILES=hyperswarm,pinning
```

Then choose which registries Gatekeeper should copy into the pin queue:

```env
ARCHON_GATEKEEPER_REGISTRIES_PIN=BTC:mainnet,ZEC:mainnet
```

Local and ephemeral operations are not pinned unless explicitly queued by Gatekeeper policy.

### Configure Provider

The mediator uses the standard IPFS Pinning Service API. Filebase and Pinata both expose compatible endpoints:

```env
# Filebase
ARCHON_PIN_PROVIDER=filebase
ARCHON_PIN_API_URL=https://api.filebase.io/v1/ipfs
ARCHON_PIN_API_TOKEN=your-filebase-token

# Pinata
ARCHON_PIN_PROVIDER=pinata
ARCHON_PIN_API_URL=https://api.pinata.cloud/psa
ARCHON_PIN_API_TOKEN=your-pinata-jwt
```

If your IPFS node has known reachable multiaddrs, pass them so the provider can fetch CIDs directly:

```env
ARCHON_PIN_ORIGINS=/ip4/203.0.113.10/tcp/4001/p2p/12D3KooW...
```

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_GATEKEEPER_REGISTRIES_PIN` | *(empty)* | Registries copied into the generic `pin` queue |
| `ARCHON_PIN_PROVIDER` | `filebase` | Provider label used in logs, state, and metrics |
| `ARCHON_PIN_API_URL` | Filebase PSA endpoint | IPFS Pinning Service API base URL |
| `ARCHON_PIN_API_TOKEN` | *(empty)* | Bearer token for the pinning provider |
| `ARCHON_PIN_ORIGINS` | *(empty)* | Optional comma-separated multiaddrs for origin IPFS nodes where the provider can fetch CIDs |
| `ARCHON_PIN_IMPORT_INTERVAL` | `1` | Minutes between pin queue import attempts |

### Verify

```bash
curl http://localhost:4273/metrics
```

The mediator leaves operations queued while a provider reports `queued` or `pinning`, and clears them only after the provider reports `pinned`.

---

## 9. Adding Drawbridge (API Gateway + Tor)

Drawbridge is the L402 API gateway that enables Lightning payments for API access and Lightning zaps between DIDs. It also acts as the node's front-door proxy, fronting the Gatekeeper, the DIDComm relay, Herald name resolution, and the Lightning mediator.

### Enable Drawbridge

Drawbridge and the services it fronts are separate profiles, each named after what it starts:

| Profile | Brings in | Enables |
|---------|-----------|---------|
| `drawbridge` | `drawbridge`, `drawbridge-client` | The front-door proxy itself |
| `lightning` | `lightning-mediator` + the Lightning rail (CLN, LNbits, RTL, init containers) | L402 paywall, zaps, `/invoice/:did` |
| `herald` | `herald`, `herald-client` | `/names/*`, `/.well-known/*` |
| `explorer` | `explorer` | `/explorer` — the node's own DID explorer, which Herald links to |
| `tor` | `tor` | Onion hidden service |

The full stack — the same service set the single `drawbridge` profile used to give:

```env
COMPOSE_PROFILES=hyperswarm,drawbridge,lightning,herald,tor
```

A lean, DIDComm-only gateway, with no Lightning or Tor weight:

```env
COMPOSE_PROFILES=hyperswarm,didcomm,drawbridge
ARCHON_DIDCOMM_TOR_PROXY=
```

**Drawbridge offers what the profiles run.** It reads `COMPOSE_PROFILES` from `.env`: with `lightning`, `herald`, `explorer`, `didcomm` or `cashu` listed, it proxies to that service's container and `GET /api/v1/capabilities` reports it; without the profile, the capability is `false` and the route returns HTTP 501. The upstream URLs (`ARCHON_LIGHTNING_MEDIATOR_URL`, `ARCHON_HERALD_URL`, `ARCHON_EXPLORER_URL`, `ARCHON_DIDCOMM_URL`, `ARCHON_CASHU_MINT_URL`) are needed only to point Drawbridge at a service somewhere else; a URL that is set is offered whether or not its profile runs. Profiles passed with `docker compose --profile` rather than `COMPOSE_PROFILES` are not visible to Drawbridge, so set the URL for those.

Herald links to `<public host>/explorer` by default, so running Herald without the `explorer` profile gives every visitor a broken link from the identity pages. Either run the profile or set `ARCHON_HERALD_EXPLORER_URL` to a reachable explorer — or empty, to hide the links.

`ARCHON_DIDCOMM_TOR_PROXY` is **not** a Drawbridge capability variable and behaves differently. It is read by the DIDComm relay, and the `didcomm` capability stays enabled either way. Blanking it affects only `.onion` delivery, which then returns HTTP 502 naming the unset variable instead of failing to dial a Tor container that is not running.

The `drawbridge-*` profiles are designed to be additive on top of `drawbridge`. Selecting one on its own is valid and will start its containers, but they will have nothing to front — tor's hidden service targets `drawbridge:4222`, and `herald-client` is built against Drawbridge's `/names/api`. Pair them with `drawbridge` unless you have a specific reason not to.

### Lightning Backend

`lightning-mediator` owns Archon's Lightning runtime integrations. Drawbridge talks to it over HTTP for L402 invoice creation and pending-invoice lifecycle, and the mediator owns the public Lightning APIs, LNBits integration, and CLN access.

Drawbridge remains the policy layer: it still owns macaroons, pricing, rate limits, and the final payment records that show which paid requests were granted. Internal admin requests between these services use `X-Archon-Admin-Key`.

You have two options for the mediator backend:

#### Option A: External CLN (Bring Your Own)

If you already run a Core Lightning node, point `lightning-mediator` at it:

```env
ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL=https://your-cln-host:3001
ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE=your-cln-rune-here
```

The rune needs permissions for `invoice` and `listinvoices` methods. Create one with:

```bash
lightning-cli createrune restrictions='[["method^invoice","method^listinvoices"]]'
```

You can optionally point to an external LNbits instance:

```env
ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL=http://your-lnbits:5000
```

#### Option B: Bundled CLN

Enable **`lightning`**, which starts the bundled Lightning dependency stack (CLN, LNbits, RTL) *and* `lightning-mediator`. Runes and secrets are auto-generated by init containers and shared with `lightning-mediator` via Docker volumes — no manual configuration needed.

Note that `drawbridge` alone no longer brings in Lightning. To paywall the API with L402 you need both `drawbridge` and `lightning`; without the `lightning` profile, invoice creation has no mediator to talk to.

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_DRAWBRIDGE_PORT` | `4222` | Drawbridge API port |
| `ARCHON_DRAWBRIDGE_L402_ENABLED` | `false` | Enable L402 payment gates |
| `ARCHON_DRAWBRIDGE_SUBSCRIPTIONS_ENABLED` | `false` | **Insecure dev stub (#121)** — when `true`, any request with an `X-Subscription-DID` header bypasses L402 payment verification with no credential check. Leave `false` in production |
| `ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS` | `10` | Default price per API call (sats) |
| `ARCHON_DRAWBRIDGE_INVOICE_EXPIRY` | `3600` | Invoice expiry in seconds |
| `ARCHON_LIGHTNING_MEDIATOR_URL` | empty | Drawbridge's upstream Lightning mediator. Empty means `http://lightning-mediator:4235` with the `lightning` profile and off without it; set it only for a mediator elsewhere |
| `ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL` | `https://cln:3001` | CLN REST endpoint used by the mediator |
| `ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE` | empty | CLN rune used by the mediator; auto-loaded from `./data/cln-mainnet/drawbridge/rune.txt` in the bundled stack |
| `ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL` | `http://lnbits:5000` | LNbits base URL used by the mediator |
| `ARCHON_DRAWBRIDGE_PUBLIC_HOST` | *(auto)* | Public Drawbridge URL used for published invoice endpoints |
| `ARCHON_TOR_SOCKS_PORT` | `127.0.0.1:9050` | Optional host-side Tor SOCKS bind; use `HOST_IP:HOST_PORT` such as `127.0.0.1:9051` when overriding |
| `ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX` | `100` | Max requests per window |
| `ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW` | `60` | Rate limit window in seconds |
| `ARCHON_DRAWBRIDGE_MACAROON_SECRET` | *(auto)* | L402 macaroon signing secret (auto-generated) |

### Auto-Generated Secrets

The Drawbridge entrypoint script handles secrets automatically:

- **Macaroon secret**: Generated on first run, saved to `./data/drawbridge/macaroon-secret.txt`
- **CLN rune**: Loaded from `./data/cln-mainnet/drawbridge/rune.txt` (created by `drawbridge-init` container)
- **Public host**: Auto-detected from Tor `.onion` address if not set

### Verify

```bash
curl http://localhost:4222/api/v1/ready
```

Optional UIs when Drawbridge is enabled:

- Herald client: `http://localhost:4231`
- Drawbridge client: `http://localhost:4223`

---

## 10. Bundled Lightning Stack (Optional)

If you don't have an existing CLN node, the bundled Lightning stack provides a complete setup with CLN, RTL, and LNbits.

The node runs `ghcr.io/archetech/cln`: Core Lightning's official image (`docker/Dockerfile.cln` names the version) with only CLN's built-in plugins. Nothing adjusts channel fees or rebalances automatically: new channels get a 0 msat base fee and 100 ppm, and fee policy beyond that is the operator's.

### Enable Lightning

Add the Lightning profile to `COMPOSE_PROFILES`, together with `tor` for the default `tor` network mode:

```env
COMPOSE_PROFILES=lightning,tor
```

A `clearnet` node needs only `lightning`. In `tor` and `hybrid` modes CLN uses the node's shared `tor` service for its outbound proxy and its onion service, and refuses to start, naming the profile, if `tor` is not running.

### Bitcoin RPC

The CLN node needs access to a Bitcoin Core RPC. If you're also running the BTC mainnet registry, these are the same credentials:

```env
ARCHON_BTC_HOST=your-bitcoin-host
ARCHON_BTC_PORT=8332
ARCHON_BTC_USER=bitcoin
ARCHON_BTC_PASS=bitcoin
```

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_CLN_ALIAS` | `archon` | Lightning node alias (visible to peers) |
| `ARCHON_CLN_RGB` | `e33502` | Node color (hex) |
| `ARCHON_CLN_PORT` | `9736` | Lightning P2P port |
| `ARCHON_CLN_NETWORK_MODE` | `tor` | Network mode: `tor`, `hybrid`, or `clearnet` |
| `ARCHON_CLN_ANNOUNCE_ADDR` | *(empty)* | Public address to announce (for `clearnet`/`hybrid` modes) |
| `ARCHON_CLN_P2P_BIND` | `127.0.0.1` | Interface the P2P port publishes on. Set `0.0.0.0` in `clearnet` and `hybrid` modes; `tor` mode refuses anything but loopback |
| `ARCHON_CLN_MIN_CAPACITY_SAT` | `50000` | Smallest channel the node accepts |
| `ARCHON_CLN_LOG_LEVEL` | `info` | CLN log level |
| `ARCHON_CLN_BITCOIN_RPC_TIMEOUT` | *(empty)* | Seconds `lightningd` waits on a Bitcoin RPC request before stopping; empty keeps its default of 60. With a pruned `bitcoind`, old blocks come from peers and can take longer, so raise this (300, say) if the node crashes with `getblock ... timed out` |
| `ARCHON_RTL_PASSWORD` | `changeme` | **Change this.** RTL web UI password |
| `ARCHON_RTL_PORT` | `3002` | RTL web UI port |
| `ARCHON_LNBITS_PORT` | `5000` | LNbits web UI port |
| `ARCHON_LNBITS_CLNREST_WAIT_TIMEOUT` | `600` | Seconds LNbits waits for CLN REST to accept its readonly rune during startup |

### Network Modes

| Mode | Description |
|------|-------------|
| `tor` | Reachable only through its onion, which it announces. All outbound connections go through Tor. Needs the `tor` profile; leave `ARCHON_CLN_P2P_BIND` unset. |
| `hybrid` | Reachable through its onion and on clearnet. Needs the `tor` profile and `ARCHON_CLN_P2P_BIND=0.0.0.0`; set `ARCHON_CLN_ANNOUNCE_ADDR` to your public IP/domain. |
| `clearnet` | Clearnet only. Set `ARCHON_CLN_P2P_BIND=0.0.0.0` and `ARCHON_CLN_ANNOUNCE_ADDR` to your public IP/domain. |

The node's onion key lives in `./data/cln-mainnet/tor/cln-service`, served by the `tor` service. Back it up with the rest of `./data/cln-mainnet/`.

**Switching an existing node to `clearnet`:** `docker compose up` does not stop a container whose profile has been removed, so an old `tor` container would keep serving the onion to a CLN that now listens on the container network. If `tor` stays enabled for Drawbridge, `docker compose up -d` recreates it without the CLN service. If you remove the `tor` profile, run `docker compose rm -sf tor` first. The key stays on disk; delete `./data/cln-mainnet/tor/cln-service` to retire the address for good.

### Init Containers

Three one-shot init containers automatically create CLN runes:

| Container | Purpose | Rune Location |
|-----------|---------|---------------|
| `drawbridge-init` | Creates rune restricted to `invoice`/`listinvoices` methods | `./data/cln-mainnet/drawbridge/rune.txt` |
| `rtl-init` | Creates unrestricted rune for RTL | `./data/cln-mainnet/rtl/rune.txt` |
| `lnbits-init` | Creates three runes (readonly, invoice, pay) + copies TLS certs | `./data/cln-mainnet/lnbits/runes.env` |

These run once and exit. If a rune file already exists, they skip creation; a failed rune request stops the container rather than leaving a partial file. The bundled LNbits service now runs from the published image `ghcr.io/archetech/lnbits:1.5.3-archetech.1`.

**First start of LNbits.** With its admin UI on, as the bundled stack has it, a new LNbits sends every request to its first-install page until an administrator has been created. Until then `add-lightning` fails, so open LNbits (`ARCHON_LNBITS_PORT`) and complete that step once.

### Important: Back Up Lightning Data

The `./data/cln-mainnet/` directory contains your Lightning wallet, channels, and keys. **Back this up regularly.** Losing this data means losing funds.

### Upgrading from the cl-hive image

Earlier releases ran CLN v25.12 in `ghcr.io/lightning-goats/cl-hive-node`, which is no longer maintained. That image also ran cl-hive, cl-revenue-ops (automatic fees and rebalancing), Boltz and vitality; none of them run now. The upgrade keeps the node's identity, channels, wallet location and onion address, and every CLN setting cl-hive applied. Per-channel fees already set stay as they are; nothing adjusts them any more.

1. Stop the stack and copy `./data/cln-mainnet/`, including `tor/`.
2. In `tor` or `hybrid` mode, add `tor` to `COMPOSE_PROFILES`. In `clearnet` or `hybrid` mode, set `ARCHON_CLN_P2P_BIND=0.0.0.0`; in `tor` mode leave it unset. Remove `ARCHON_CLN_VERSION`, `ARCHON_CLN_GOVERNANCE_MODE` and `ARCHON_CLN_ARCHON_VERSION` from `.env`; nothing reads them.
3. Start with `./start-node` from a checkout, which builds both the CLN and Tor images (a bare `docker compose up` would build only the missing CLN image and keep an older Tor image that cannot serve CLN's onion), or pull and start from a release. CLN migrates its database to the new schema on first start. The previous config is kept as `./data/cln-mainnet/bitcoin/config.cl-hive.bak`.
4. Check that `lightning-cli --lightning-dir=/data/lightning/bitcoin --network=bitcoin getinfo` (in `cln-mainnet-node`) shows the same `id` and, in `tor` or `hybrid` mode, the same onion under `address`; that `listpeerchannels` shows the same channels in `CHANNELD_NORMAL`; and that Drawbridge can issue an invoice.

Splicing is now on: CLN enables it by default since v26.04, where cl-hive left it off.

**Rollback** is restoring the copy with the old image, and is safe only if no channel state has changed since the upgrade. An older database broadcast after a channel update is a revoked state, and the peer can claim the whole channel. Once a payment or forward has gone through on the new node, there is no going back.

### Verify

```bash
# RTL web interface
open http://localhost:3002

# LNbits web interface
open http://localhost:5000

# Lightning mediator health
curl http://localhost:4235/ready
```

### Cashu Mint (Optional, Experimental)

The `cashu` profile runs a Cashu ecash mint ([cdk-mintd](https://github.com/cashubtc/cdk) 0.18.3). Ecash issued by a mint is a claim on the mint's Lightning balance: **running a mint with real sats means holding other people's funds**. Cashu implementations are still under security audit; keep the limits low.

The mint publishes no port. Drawbridge serves its API at `/cashu`, so its public URL is `<ARCHON_DRAWBRIDGE_PUBLIC_HOST>/cashu`, outside L402 and behind its own rate limits. `GET /api/v1/cashu-mint` returns that URL to wallets on the node, and only for an `https` public host: wallets refuse `http` mints, and outside wallets could not redeem against an onion.

```env
COMPOSE_PROFILES=...,drawbridge,cashu
```

With the profile, Drawbridge offers the mint (the `cashu` capability); without it, `/cashu` answers 501. Set `ARCHON_CASHU_MINT_URL` only to offer a mint that runs elsewhere.

**Backends.** `ARCHON_CASHU_MINT_BACKEND` defaults to `fakewallet`, which marks every quote paid without moving sats: use it to try the mint out. `cln` pays and receives through the bundled CLN node and needs the `lightning` profile and `ARCHON_CLN_RPC_SHARE=true`. That makes the CLN container open a second RPC socket in `./data/cln-mainnet/rpc-share/` for `ARCHON_GID`, which the mint mounts. **The RPC socket gives full control of the node**: a bug in or compromise of the mint could spend the node's whole Lightning balance, not only what the mint has issued. The other bundled services use CLN REST with restricted runes instead.

**Settings** are read once, when the mint first starts and initializes its database:

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_CASHU_MINT_BACKEND` | `fakewallet` | `fakewallet` or `cln` |
| `ARCHON_CASHU_MINT_NAME` / `_DESCRIPTION` | `Archon mint` / empty | Shown to wallets (NUT-06) |
| `ARCHON_CASHU_MINT_MIN_MINT` / `_MAX_MINT` | `1` / `10000` | Sats per mint quote |
| `ARCHON_CASHU_MINT_MIN_MELT` / `_MAX_MELT` | `1` / `10000` | Sats per melt quote |
| `ARCHON_CASHU_MINT_INPUT_FEE_PPK` | `0` | Fee per input, in thousandths of a sat (NUT-02) |
| `ARCHON_CASHU_MINT_LN_FEE_PERCENT` / `_LN_RESERVE_FEE_MIN` | `0.02` / `2` | Lightning fee reserve on melts |
| `ARCHON_DRAWBRIDGE_CASHU_PER_SOURCE` / `_GLOBAL` / `_RATE_LIMIT_WINDOW` | `120` / `1200` / `60` | Drawbridge's limits on `/cashu`; requests with the admin key are not limited |

**Stuck melts on the `cln` backend.** cdk-mintd 0.18.3 releases a melt's proofs only when the node's `xpay` returns an error it treats as final (203, 205, 206 or 207). A payment that was attempted and then failed, for example because the payee went offline, can return the generic 209 instead. The mint then keeps the melt `PENDING` and its proofs reserved, even though `listpays` on the node says `failed`, and neither a mint restart nor the payee returning clears it. We found no supported way to release them, so that ecash is unavailable to its holder ([cdk#2836](https://github.com/cashubtc/cdk/issues/2836)). Keep melt limits low, and do not offer this mint for value you cannot afford to have locked.

After that, the configuration lives in the mint's database and changing these variables has no effect. To change a running mint, edit `./data/cashu-mint/mint.toml` (written on the first start) and apply it while the mint is stopped:

```bash
docker compose stop cashu-mint
docker compose run --rm --entrypoint cdk-mintd cashu-mint --work-dir /data config apply --file /data/mint.toml
docker compose start cashu-mint
```

**Never switch a `fakewallet` mint to `cln`.** Its ecash was issued without payment, and would become redeemable for the node's real sats. Start a new mint instead: stop it, move `./data/cashu-mint/` aside (keeping its `.gitkeep`), set the backend and start again.

**Back up `./data/cashu-mint/`.** `seed` derives the mint's keys and `cdk-mintd.sqlite` records which ecash has been spent; restoring a mint needs both. Losing them leaves the mint unable to honour ecash it issued.

Not provided yet: cdk's management RPC, and with it live keyset rotation (`rotate-next-keyset`), which needs TLS material and the separate `cdk-mint-cli`. The mint's WebSocket subscriptions (NUT-17) are not proxied, so Drawbridge removes NUT-17 from the mint info it serves and wallets poll instead.

---

## 11. Production Hardening

### Reverse Proxy

Bind services to localhost and put them behind a reverse proxy (nginx, Caddy, etc.) for HTTPS termination:

```env
ARCHON_BIND_ADDRESS=127.0.0.1
```

### Firewall

Only expose ports that need external access:

| Port | Needs Public Access? |
|------|---------------------|
| CLN P2P (9736) | Yes — for Lightning peer connections |
| IPFS Swarm (4001) | Yes — for IPFS peer connections |
| Drawbridge (4222) | Yes — if accepting external API requests |
| Gatekeeper (4224) | Depends — public for DID resolution, localhost if behind proxy |
| All others | No — bind to localhost |

### Backups

Back up the entire `./data/` directory regularly. Critical data:

| Path | Contents | Priority |
|------|----------|----------|
| `./data/cln-mainnet/` | Lightning wallet, channels, keys | **Critical** — loss means lost funds |
| `./data/cashu-mint/` | Cashu mint seed and database (`cashu` profile) | **Critical** — loss means the mint cannot honour its ecash |
| `./data/tor-drawbridge/` | Tor hidden service keys | High — loss means new `.onion` address |
| `./data/mongodb/` | Registry and wallet-side service state used by bundled Bitcoin mediators | High |
| `./data/ZEC:mainnet-mediator.json` or `./data/ZEC:mainnet-mediator.db` | Zcash mediator scan/export state when using local JSON or SQLite storage | High |
| `./data/redis/` | Cache (reconstructible) | Low |

### Monitoring

Prometheus scrapes metrics from all services. Grafana is pre-provisioned with dashboards:

- **Grafana**: http://localhost:3000 (default: `admin` / `admin`)
- **Prometheus**: http://localhost:9090
- Chain mediator dashboards: BTC mainnet, BTC signet, Zcash mainnet, Ethereum mainnet, Ethereum Sepolia, Solana mainnet, and Solana Devnet.

Change the default Grafana credentials:

```env
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=your-secure-password
```

### Alerts

Grafana is also pre-provisioned with one alert rule, **Mediator wallet cannot fund anchoring**. Each chain mediator (Bitcoin, Zcash, Ethereum, Solana) exports `<chain>_wallet_insufficient_funds`, set to 1 while its wallet is below the level that node requires to anchor (`ARCHON_*_FEE_MAX`, `ARCHON_ETH_MIN_GAS_BALANCE_WEI`, `ARCHON_SOL_MIN_BALANCE_LAMPORTS`). The rule fires after 5 minutes in that state, with one alert for each affected mediator. Email goes out when it fires, every 4 hours while it continues, and once when it clears. A mediator that the node does not run reports nothing and does not alert. A wallet service the mediator cannot reach is reported separately as `<chain>_wallet_unreachable` and is not treated as low funds. The mediator dashboards show both.

By default the alert is visible only under **Alerting > Alert rules** in Grafana, and nothing is sent. To receive it by email, add these to `.env` and recreate Grafana with `docker compose up -d grafana`:

| Setting | Required | Value |
|---------|----------|-------|
| `ARCHON_ALERT_EMAIL_TO` | Yes; turns email on | Recipient, or several separated by `;` |
| `ARCHON_ALERT_SMTP_HOST` | Yes | Mail server as `host:port` |
| `ARCHON_ALERT_SMTP_FROM` | Yes | Address the email is sent from |
| `ARCHON_ALERT_SMTP_USER` | If the server requires login | Login name |
| `ARCHON_ALERT_SMTP_PASSWORD` | If the server requires login | Login password; single-quote it if it contains `$` |

```env
ARCHON_ALERT_EMAIL_TO=operator@example.com
ARCHON_ALERT_SMTP_HOST=smtp.example.com:587
ARCHON_ALERT_SMTP_USER=alerts@example.com
ARCHON_ALERT_SMTP_PASSWORD=your-smtp-password
ARCHON_ALERT_SMTP_FROM=alerts@example.com
```

Grafana sends a login only over an encrypted connection, so a server that requires one must offer STARTTLS or TLS. Keep the password in `.env`, which git ignores, like the other secrets. Removing `ARCHON_ALERT_EMAIL_TO` and recreating Grafana stops the email and removes the contact point.

The repo provisions Grafana's notification policy, so Grafana shows it as read-only and replaces any policy tree created in its UI.

---

## 12. Port Reference

| Port | Service | Default | Env Var | Binding |
|------|---------|---------|---------|---------|
| 4224 | Gatekeeper | 4224 | `ARCHON_GATEKEEPER_PORT` | configurable |
| 4225 | Gatekeeper Client | 4225 | `ARCHON_GATEKEEPER_CLIENT_PORT` | configurable |
| 4226 | Keymaster | 127.0.0.1:4226 | `ARCHON_KEYMASTER_HOST_BIND` / `ARCHON_KEYMASTER_PORT` | localhost |
| 4227 | Keymaster Client | 4227 | `ARCHON_KEYMASTER_CLIENT_PORT` | configurable |
| 4223 | Drawbridge Client | 4223 | `ARCHON_DRAWBRIDGE_CLIENT_PORT` | configurable |
| 4228 | React Wallet | 4228 | `ARCHON_REACT_WALLET_PORT` | configurable |
| 4222 | Drawbridge | 4222 | `ARCHON_DRAWBRIDGE_PORT` | public |
| 4230 | Herald | 4230 | `ARCHON_HERALD_PORT` | configurable |
| 4231 | Herald Client | 4231 | `ARCHON_HERALD_CLIENT_PORT` | configurable |
| 4235 | Lightning Mediator | 4235 | `ARCHON_LIGHTNING_MEDIATOR_PORT` | configurable |
| 4000 | Explorer | 4000 | -- | public |
| 9736 | CLN P2P | 127.0.0.1:9736 | `ARCHON_CLN_P2P_BIND` / `ARCHON_CLN_PORT` | localhost in `tor` mode; set `ARCHON_CLN_P2P_BIND=0.0.0.0` for `clearnet`/`hybrid` |
| 3001 | CLN REST | 3001 | -- | localhost |
| 3002 | RTL | 127.0.0.1:3002 | `ARCHON_RTL_BIND` / `ARCHON_RTL_PORT` | localhost (admin UI; set `ARCHON_RTL_BIND=0.0.0.0` to expose) |
| 5000 | LNbits | 127.0.0.1:5000 | `ARCHON_LNBITS_BIND` / `ARCHON_LNBITS_PORT` | localhost (custodial wallet admin UI; set `ARCHON_LNBITS_BIND=0.0.0.0` to expose) |
| 9050 | Tor SOCKS | 127.0.0.1:9050 | `ARCHON_TOR_SOCKS_PORT` | localhost; overrides should use `HOST_IP:HOST_PORT` |
| 38332 | BTC Signet Node RPC | 38332 | -- | localhost |
| 4232 | Hyperswarm Metrics | 4232 | -- | localhost |
| 4234 | BTC Mainnet Mediator Metrics | 4234 | -- | localhost |
| 4236 | BTC Signet Mediator Metrics | 4236 | -- | localhost |
| 4238 | Zcash Mainnet Mediator Metrics | 4238 | -- | localhost |
| 4239 | Ethereum Sepolia Mediator Metrics | 4239 | -- | localhost |
| 4246 | Ethereum Mainnet Mediator Metrics | 4246 | -- | localhost |
| 4248 | Solana Mainnet Mediator Metrics | 4248 | -- | localhost |
| 4249 | Solana Devnet Mediator Metrics | 4249 | -- | localhost |
| 4240 | BTC Signet Wallet API | 4240 | -- | localhost |
| 4241 | BTC Signet Wallet Metrics | 4241 | -- | localhost |
| 4242 | BTC Mainnet Wallet API | 4242 | -- | localhost |
| 4243 | BTC Mainnet Wallet Metrics | 4243 | -- | localhost |
| 4244 | BTC Testnet4 Wallet API | 4244 | -- | localhost |
| 4245 | BTC Testnet4 Wallet Metrics | 4245 | -- | localhost |
| 4250 | Zcash Mainnet Wallet API | 4250 | -- | localhost |
| 4251 | Zcash Mainnet Wallet Metrics | 4251 | -- | localhost |
| 4252 | Ethereum Sepolia Wallet API | 4252 | -- | localhost |
| 4253 | Ethereum Sepolia Wallet Metrics | 4253 | -- | localhost |
| 4254 | Ethereum Mainnet Wallet API | 4254 | -- | localhost |
| 4255 | Ethereum Mainnet Wallet Metrics | 4255 | -- | localhost |
| 4256 | Solana Mainnet Wallet API | 4256 | -- | localhost |
| 4257 | Solana Mainnet Wallet Metrics | 4257 | -- | localhost |
| 4262 | Solana Devnet Wallet API | 4262 | -- | localhost |
| 4263 | Solana Devnet Wallet Metrics | 4263 | -- | localhost |
| 4270 | Filecoin Wallet API | 4270 | -- | localhost |
| 4271 | Filecoin Mediator Metrics | 4271 | -- | localhost |
| 4272 | Filecoin Wallet Metrics | 4272 | -- | localhost |
| 4273 | Pinning Mediator Metrics | 4273 | -- | localhost |
| 27017 | MongoDB | 27017 | -- | localhost |
| 6379 | Redis | 6379 | -- | localhost |
| 5001 | IPFS API | 5001 | -- | localhost |
| 4001 | IPFS Swarm | 4001 | -- | public |
| 9090 | Prometheus | 9090 | -- | localhost |
| 3000 | Grafana | 127.0.0.1:3000 | `ARCHON_GRAFANA_BIND` / `ARCHON_GRAFANA_PORT` | localhost (admin UI; set `ARCHON_GRAFANA_BIND=0.0.0.0` to expose) |
| 4280 | node-runner | 127.0.0.1:4280 | `ARCHON_NODE_RUNNER_HOST_BIND` / `ARCHON_NODE_RUNNER_PORT` | localhost |

---

## 13. Troubleshooting

For multi-step recovery after losing state — resyncing a reset gatekeeper
database, a dead hidden service — see [Recovery Procedures](recovery.md).

### CLN Not Syncing

Check Bitcoin RPC connectivity:

```bash
docker compose logs cln-mainnet-node | grep -i error
```

Verify your `ARCHON_BTC_HOST`, `ARCHON_BTC_USER`, and `ARCHON_BTC_PASS` are correct and that the Bitcoin node is reachable from inside the Docker network.

### Empty Node Address

In `tor` mode the node announces only its onion; in `clearnet` mode it announces nothing unless `ARCHON_CLN_ANNOUNCE_ADDR` is set. If `getinfo` shows no onion in `tor` or `hybrid` mode, check that the `tor` service is running and serving `cln` (`docker compose logs tor`).

### CLN Refuses to Start

The entrypoint stops with a message rather than start a node in a state that could lose funds or leak its address:

- **`hsm_secret exists but … lightningd.sqlite3 does not`**: the wallet is missing from where the node keeps it. Restore it from backup; starting anyway would create a node with the right identity and none of its channels.
- **`tor did not resolve`**: `tor` or `hybrid` mode without the `tor` profile.
- **`the P2P port is published on …`**: `tor` mode with `ARCHON_CLN_P2P_BIND` set beyond loopback.

### Init Containers Failing

Rune init containers wait up to 10 minutes for CLN to be ready. Check their logs:

```bash
docker compose logs drawbridge-init
docker compose logs rtl-init
docker compose logs lnbits-init
```

If CLN is taking too long to start (e.g., first-time Tor setup), the init containers will time out. Restart them after CLN is running:

```bash
docker compose restart drawbridge-init
```

### Zcash Mediator Not Scanning

Check Zebra RPC connectivity and credentials:

```bash
docker compose logs zcash-mainnet-mediator
docker compose logs zcash-mainnet-wallet
curl http://localhost:4238/metrics
```

Verify `ARCHON_ZEC_HOST`, `ARCHON_ZEC_PORT`, `ARCHON_ZEC_USER`, and `ARCHON_ZEC_PASS` are correct and reachable from inside the Docker network. Also confirm `ARCHON_GATEKEEPER_REGISTRIES` includes `ZEC:mainnet`; otherwise Gatekeeper will not accept queued Zcash operations.

### Tor Onion Not Resolving

Check that the Tor container created the hostname file:

```bash
cat ./data/tor-drawbridge/hostname
```

If empty or missing, restart the Tor container:

```bash
docker compose restart tor
```

### Port Conflicts

If a service fails to start with "address already in use", check what's bound to that port:

```bash
ss -tlnp | grep :4224
```

Either stop the conflicting process or change the port via the corresponding environment variable.

### Viewing Logs

node-runner's Logs page merges service logs in time order and searches them. From a shell:

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f gatekeeper

# Last 100 lines
docker compose logs --tail=100 cln-mainnet-node
```
