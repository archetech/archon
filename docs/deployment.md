# Archon Deployment Guide

This guide walks you through deploying an Archon node, from a minimal DID-only setup to a full Lightning-enabled stack. Each section builds on the previous one — start with the core and add layers as needed.

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Core Node (DID Only)](#2-core-node-did-only)
3. [Adding Bitcoin Registries](#3-adding-bitcoin-registries)
4. [Adding Drawbridge (API Gateway + Tor)](#4-adding-drawbridge-api-gateway--tor)
5. [Bundled Lightning Stack (Optional)](#5-bundled-lightning-stack-optional)
6. [Production Hardening](#6-production-hardening)
7. [Port Reference](#7-port-reference)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Prerequisites

- **Docker** v20.10+ and **Docker Compose** v2
- **Git** to clone the repository
- A machine with at least 4 GB RAM (8 GB+ recommended with Lightning)

### Initial Setup

```bash
git clone https://github.com/archetech/archon.git
cd archon
cp sample.env .env
```

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

### Data Directories

All persistent data lives under `./data/`. Create the directory and ensure it's owned by your user:

```bash
mkdir -p data
```

---

## 2. Core Node (DID Only)

The base `docker-compose.yml` runs everything needed for DID creation, resolution, and credential management.

### Disable Optional Services

Comment out the `include:` lines at the top of `docker-compose.yml` for any services you don't need yet:

```yaml
# include:
#   - docker-compose.btc-mainnet.yml
#   - docker-compose.btc-signet.yml
#   - docker-compose.lightning.yml
#   - docker-compose.drawbridge.yml
```

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_ADMIN_API_KEY` | *(empty)* | **Required.** Protects admin API routes |
| `ARCHON_ENCRYPTED_PASSPHRASE` | *(empty)* | **Required.** Passphrase for encrypting the wallet. Keymaster won't start without it |
| `ARCHON_NODE_ID` | `mynodeID` | Alias for the node's agent DID (created on first run) |
| `ARCHON_NODE_NAME` | `mynodeName` | Human-readable node name for peer discovery |
| `ARCHON_GATEKEEPER_PORT` | `4224` | Gatekeeper API port |
| `ARCHON_KEYMASTER_PORT` | `4226` | Keymaster API port |
| `ARCHON_GATEKEEPER_DB` | `redis` | Storage backend (`redis` or `json`) |
| `ARCHON_GATEKEEPER_DID_PREFIX` | `did:cid` | DID method prefix |
| `ARCHON_GATEKEEPER_REGISTRIES` | `hyperswarm` | Comma-separated list of registries |
| `ARCHON_DEFAULT_REGISTRY` | `hyperswarm` | Default registry for new DIDs |
| `ARCHON_PROTOCOL` | `/ARCHON/v0.2-reboot` | Hyperswarm protocol identifier |

### Services

| Service | Description |
|---------|-------------|
| **mongodb** | Used by satoshi mediators for Bitcoin registry state |
| **redis** | Primary DID data store, cache, and pub/sub |
| **ipfs** | Content-addressable storage |
| **gatekeeper** | DID resolution and management API |
| **keymaster** | Wallet and credential management API |
| **hyperswarm-mediator** | P2P DID synchronization |
| **cli** | Command-line interface container |
| **explorer** | DID explorer web app |
| **react-wallet** | Web wallet UI |
| **prometheus** | Metrics collection |
| **grafana** | Metrics dashboards |

### Start and Verify

```bash
docker compose up -d
docker compose logs -f gatekeeper   # watch for startup

# Verify gatekeeper is running
curl http://localhost:4224/api/v1/gatekeeper/version
```

---

## 3. Adding Bitcoin Registries

Bitcoin registries anchor DIDs on-chain via the Satoshi mediator. There are separate compose files per network:

| File | Network | Bitcoin Node |
|------|---------|-------------|
| `docker-compose.btc-mainnet.yml` | BTC mainnet | **You provide** — requires an external Bitcoin Core node with RPC access |
| `docker-compose.btc-signet.yml` | BTC signet | Bundled — runs its own `bitcoin-core` container |
| `docker-compose.btc-testnet4.yml` | BTC testnet4 | Bundled — runs its own `bitcoin-core` container |

### Enable a Registry

Uncomment the relevant `include:` line in `docker-compose.yml`:

```yaml
include:
  - docker-compose.btc-mainnet.yml
  # - docker-compose.btc-signet.yml
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

## 4. Adding Drawbridge (API Gateway + Tor)

Drawbridge is the L402 API gateway that enables Lightning payments for API access and Lightning zaps between DIDs. It includes a Tor hidden service for privacy.

### Enable Drawbridge

Uncomment in `docker-compose.yml`:

```yaml
include:
  - docker-compose.drawbridge.yml
```

### Lightning Backend

`lightning-mediator` owns Archon's Lightning runtime integrations. Drawbridge talks to it over HTTP for L402 invoice creation, and the mediator owns the public Lightning APIs, LNBits integration, and CLN access.

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

Include the Lightning stack (see [Section 5](#5-bundled-lightning-stack-optional)). Runes and secrets are auto-generated by init containers and shared with `lightning-mediator` via Docker volumes — no manual configuration needed.

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_DRAWBRIDGE_PORT` | `4222` | Drawbridge API port |
| `ARCHON_DRAWBRIDGE_L402_ENABLED` | `false` | Enable L402 payment gates |
| `ARCHON_DRAWBRIDGE_DEFAULT_PRICE_SATS` | `10` | Default price per API call (sats) |
| `ARCHON_DRAWBRIDGE_INVOICE_EXPIRY` | `3600` | Invoice expiry in seconds |
| `ARCHON_LIGHTNING_MEDIATOR_URL` | `http://lightning-mediator:4235` | Drawbridge's upstream Lightning mediator |
| `ARCHON_LIGHTNING_MEDIATOR_CLN_REST_URL` | `https://cln:3001` | CLN REST endpoint used by the mediator |
| `ARCHON_LIGHTNING_MEDIATOR_CLN_RUNE` | empty | CLN rune used by the mediator |
| `ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL` | empty | LNBits base URL used by the mediator |
| `ARCHON_DRAWBRIDGE_RATE_LIMIT_MAX` | `100` | Max requests per window |
| `ARCHON_DRAWBRIDGE_RATE_LIMIT_WINDOW` | `60` | Rate limit window in seconds |
| `ARCHON_DRAWBRIDGE_PUBLIC_HOST` | *(auto)* | Public URL (auto-detected from Tor `.onion`) |
| `ARCHON_DRAWBRIDGE_MACAROON_SECRET` | *(auto)* | L402 macaroon signing secret (auto-generated) |

### Auto-Generated Secrets

The Drawbridge entrypoint script handles secrets automatically:

- **Macaroon secret**: Generated on first run, saved to `./data/drawbridge/macaroon-secret.txt`
- **CLN rune**: Loaded from `./data/cln-mainnet/drawbridge/rune.txt` (created by `drawbridge-init` container)
- **Public host**: Auto-detected from Tor `.onion` address if not set

### Verify

```bash
curl http://localhost:4222/health
```

---

## 5. Bundled Lightning Stack (Optional)

If you don't have an existing CLN node, the bundled Lightning stack provides a complete setup with CLN, RTL, and LNbits.

### Enable Lightning

Uncomment in `docker-compose.yml`:

```yaml
include:
  - docker-compose.lightning.yml
  - docker-compose.drawbridge.yml
```

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
| `ARCHON_CLN_ANNOUNCE_ADDR` | *(empty)* | Announce address (for `clearnet`/`hybrid` modes) |
| `ARCHON_CLN_GOVERNANCE_MODE` | `advisor` | cl-hive governance mode |
| `ARCHON_CLN_LOG_LEVEL` | `info` | CLN log level |
| `ARCHON_RTL_PASSWORD` | `changeme` | **Change this.** RTL web UI password |
| `ARCHON_RTL_PORT` | `3002` | RTL web UI port |
| `ARCHON_LNBITS_PORT` | `5000` | LNbits web UI port |

### Network Modes

| Mode | Description |
|------|-------------|
| `tor` | Node is only reachable via Tor. Address is not publicly announced. |
| `hybrid` | Reachable via both Tor and clearnet. Set `ARCHON_CLN_ANNOUNCE_ADDR` to your public IP/domain. |
| `clearnet` | Clearnet only. Set `ARCHON_CLN_ANNOUNCE_ADDR` to your public IP/domain. |

### Init Containers

Three one-shot init containers automatically create CLN runes:

| Container | Purpose | Rune Location |
|-----------|---------|---------------|
| `drawbridge-init` | Creates rune restricted to `invoice`/`listinvoices` methods | `./data/cln-mainnet/drawbridge/rune.txt` |
| `rtl-init` | Creates unrestricted rune for RTL | `./data/cln-mainnet/rtl/rune.txt` |
| `lnbits-init` | Creates three runes (readonly, invoice, pay) + copies TLS certs | `./data/cln-mainnet/lnbits/runes.env` |

These run once and exit. If a rune file already exists, they skip creation.

### Important: Back Up Lightning Data

The `./data/cln-mainnet/` directory contains your Lightning wallet, channels, and keys. **Back this up regularly.** Losing this data means losing funds.

### Verify

```bash
# RTL web interface
open http://localhost:3002

# LNbits web interface
open http://localhost:5000

# CLN node info (via CLI container)
docker compose exec cli keymaster lightning-info
```

---

## 6. Production Hardening

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
| `./data/tor-drawbridge/` | Tor hidden service keys | High — loss means new `.onion` address |
| `./data/mongodb/` | DID documents and credentials | High |
| `./data/redis/` | Cache (reconstructible) | Low |

### Monitoring

Prometheus scrapes metrics from all services. Grafana is pre-provisioned with dashboards:

- **Grafana**: http://localhost:3000 (default: `admin` / `admin`)
- **Prometheus**: http://localhost:9090

Change the default Grafana credentials:

```env
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=your-secure-password
```

---

## 7. Port Reference

| Port | Service | Default | Env Var | Binding |
|------|---------|---------|---------|---------|
| 4224 | Gatekeeper | 4224 | `ARCHON_GATEKEEPER_PORT` | configurable |
| 4226 | Keymaster | 4226 | `ARCHON_KEYMASTER_PORT` | configurable |
| 4228 | React Wallet | 4228 | `ARCHON_REACT_WALLET_PORT` | configurable |
| 4222 | Drawbridge | 4222 | `ARCHON_DRAWBRIDGE_PORT` | public |
| 4000 | Explorer | 4000 | -- | public |
| 9736 | CLN P2P | 9736 | `ARCHON_CLN_PORT` | public |
| 3001 | CLN REST | 3001 | -- | localhost |
| 3002 | RTL | 3002 | `ARCHON_RTL_PORT` | localhost |
| 5000 | LNbits | 5000 | `ARCHON_LNBITS_PORT` | localhost |
| 27017 | MongoDB | 27017 | -- | localhost |
| 6379 | Redis | 6379 | -- | localhost |
| 5001 | IPFS API | 5001 | -- | localhost |
| 4001 | IPFS Swarm | 4001 | -- | public |
| 9090 | Prometheus | 9090 | -- | localhost |
| 3000 | Grafana | 3000 | -- | localhost |
| 4232 | Hyperswarm Metrics | 4232 | -- | localhost |
| 4234 | BTC Mainnet Metrics | 4234 | -- | localhost |
| 4236 | BTC Signet Metrics | 4236 | -- | localhost |

---

## 8. Troubleshooting

### CLN Not Syncing

Check Bitcoin RPC connectivity:

```bash
docker compose logs cln-mainnet-node | grep -i error
```

Verify your `ARCHON_BTC_HOST`, `ARCHON_BTC_USER`, and `ARCHON_BTC_PASS` are correct and that the Bitcoin node is reachable from inside the Docker network.

### Empty Node Address

This is expected when running in `tor` network mode — the node is hidden and doesn't announce a public address. If you need a visible address, switch to `hybrid` or `clearnet` mode and set `ARCHON_CLN_ANNOUNCE_ADDR`.

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

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f gatekeeper

# Last 100 lines
docker compose logs --tail=100 cln-mainnet-node
```
