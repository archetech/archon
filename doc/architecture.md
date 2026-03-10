# Archon Service Architecture

## Overview

Archon is a modular platform for DID/credential management with Bitcoin anchoring, Lightning payments, and distributed networking. Services are deployed as Docker containers with layered compose files.

## Architecture Diagram

```
                                    External Clients
                                          |
                                    [Tor Hidden Service]
                                          |
                              +-----------+-----------+
                              |       Drawbridge      |
                              |     (L402 Gateway)    |
                              |        :4222          |
                              +--+------+------+------+
                                 |      |      |
                     +-----------+   +--+--+   +----------+
                     |               |     |               |
                     v               v     v               v
               +-----------+   +----------+----------+   +--------+
               | CLN REST  |   |   Gatekeeper        |   | Redis  |
               |   :3001   |   |   (DID Registry)    |   | :6379  |
               +-----+-----+   |      :4224          |   +--------+
                     |         +--+------+------+-----+
                     |            |      |      |
               +-----+-----+     |      |      |
               | CLN Node  |     v      v      v
               | (cl-hive) |  +------+ +-----+ +------+
               |   :9736   |  |Mongo | |Redis| | IPFS |
               +-----+-----+  |:27017| |:6379| |:5001 |
                     |         +------+ +-----+ +--+---+
                [Tor / P2P]                        |
                                                   v
                                          +--------+--------+
                                          |   Hyperswarm    |
                                          |   Mediator      |
                                          |    :4232        |
                                          +-----------------+

               +------------------------------------------------+
               |              Keymaster (:4226)                  |
               |         (DID/Credential Management)             |
               +------+-----------+----------+------------------+
                      |           |          |
                      v           v          v
                  +-------+  +-------+  +---------+
                  |Gatekpr|  |MongoDB|  |  Redis  |
                  | :4224 |  |:27017 |  |  :6379  |
                  +-------+  +-------+  +---------+

                      Bitcoin Anchoring Stack (per network)

              +---------+     +---------+     +---------+
              |  BTC    |     |  BTC    |     |  BTC    |
              | Mainnet |     | Signet  |     |Testnet4 |
              |Mediator |     |Mediator |     |Mediator |
              | :4234   |     | :4236   |     |         |
              +----+----+     +----+----+     +----+----+
                   |               |               |
                   v               v               v
              +----+----+     +----+----+     +----+----+
              |  BTC    |     |  BTC    |     |  BTC    |
              | Mainnet |     | Signet  |     |Testnet4 |
              | Wallet  |     | Wallet  |     | Wallet  |
              | :4242   |     | :4240   |     | :4244   |
              +--+---+--+     +--+---+--+     +--+---+--+
                 |   |           |   |           |   |
                 |   +-----+-----+   +-----+-----+  |
                 |         |               |         |
                 |         v               v         |
                 |   +-----------+   +-----------+   |
                 |   | Keymaster |   | Gatekeeper|   |
                 |   |  :4226    |   |   :4224   |   |
                 |   |(mnemonic) |   | (queue)   |   |
                 |   +-----------+   +-----------+   |
                 v                                   v
              [External]  +----+----+ +----+----+
              Bitcoin     |  Signet | |Testnet4 |
              Core :8332  |  Node   | |  Node   |
                          | :38332  | | :48332  |
                          +---------+ +---------+
                          (embedded)  (embedded)

               +------------------------------------------------+
               |            UI / Client Services                 |
               |                                                 |
               |  Explorer (:4000)    React-Wallet (:4228)       |
               |       |                    |                    |
               |       +-----> Gatekeeper <-+                    |
               |               Keymaster                         |
               |                                                 |
               |  RTL (:3002) -----> CLN REST (:3001)            |
               |  LNbits (:5000) --> CLN REST (:3001)            |
               |  CLI ----------------> Gatekeeper, Keymaster    |
               +------------------------------------------------+

               +------------------------------------------------+
               |            Observability                        |
               |                                                 |
               |  Prometheus (:9090) --scrapes--> all :*/metrics |
               |       |                                         |
               |       v                                         |
               |  Grafana (:3000)                                |
               +------------------------------------------------+
```

## Service Roles

| Service | Port | Role |
|---------|------|------|
| **Gatekeeper** | 4224 | DID registry, resolution, search |
| **Keymaster** | 4226 | DID/credential management, mnemonic custody |
| **Drawbridge** | 4222 | L402 API gateway, Lightning zaps, Tor proxy |
| **Hyperswarm Mediator** | 4232 | DHT-based DID distribution |
| **BTC Wallet** | 4240-4244 | Watch-only HD wallet, tx signing |
| **BTC Mediator** | 4234-4236 | OP_RETURN anchoring, RBF fee management |
| **CLN Node** | 9736/3001 | Core Lightning node (Tor mode) |
| **RTL** | 3002 | Lightning node web UI |
| **LNbits** | 5000 | Lightning accounting |
| **Explorer** | 4000 | DID search/browse UI |
| **React-Wallet** | 4228 | Web wallet UI |
| **CLI** | - | Command-line interface |

## Data Stores

| Store | Port | Used By |
|-------|------|---------|
| **MongoDB** | 27017 | Gatekeeper, Keymaster, Mediators |
| **Redis** | 6379 | Gatekeeper, Keymaster, Drawbridge, Mediators |
| **IPFS** | 5001 | Gatekeeper, Hyperswarm Mediator |

## Docker Compose Layers

```
docker-compose.yml                  Base: core services + infra + observability
  ├── docker-compose.btc-mainnet.yml    BTC mainnet wallet + mediator
  ├── docker-compose.btc-signet.yml     BTC signet node + wallet + mediator
  ├── docker-compose.btc-testnet4.yml   BTC testnet4 node + wallet + mediator
  ├── docker-compose.lightning.yml      CLN + RTL + LNbits + init containers
  └── docker-compose.drawbridge.yml     Drawbridge + Tor hidden service
```

## Key Data Flows

### DID Creation & Anchoring
```
Client --> Keymaster --> Gatekeeper --> MongoDB/Redis
                                   --> Hyperswarm (DHT export)
                                   --> BTC Mediator --> Wallet --> Bitcoin (OP_RETURN)
```

### Lightning Zap
```
Client --> Drawbridge --> CLN REST --> BOLT11 invoice
       <-- BOLT11       Client pays invoice
       --> Drawbridge --> Gatekeeper (record in DID doc)
```

### Bitcoin Transaction (Anchor/Send)
```
Mediator --> Wallet: POST /wallet/anchor
  Wallet --> Keymaster: GET /wallet/mnemonic
  Wallet --> Bitcoin Core: walletCreateFundedPsbt
  Wallet: sign PSBT with derived keys
  Wallet --> Bitcoin Core: sendRawTransaction
  Wallet --> Mediator: { txid }
```

### RBF Fee Bumping
```
Mediator: tx unconfirmed after N blocks?
  Mediator --> Bitcoin Core: estimatesmartfee
  Mediator: current fee rate < estimate? skip if adequate
  Mediator --> Wallet: POST /wallet/bump-fee
    Wallet --> Bitcoin Core: psbtbumpfee, sign, broadcast
```

## Network Binding

| Binding | Services |
|---------|----------|
| **0.0.0.0** (configurable) | Gatekeeper, Keymaster, Drawbridge, Explorer, React-Wallet |
| **127.0.0.1** (localhost) | MongoDB, Redis, IPFS, Prometheus, Grafana, RTL, LNbits, CLN REST, BTC nodes |
| **Tor hidden service** | Drawbridge |
| **Tor P2P** | CLN Node |

## Persistent Data

All service data is stored under `./data/`:

```
data/
  ├── mongodb/          MongoDB database files
  ├── redis/            Redis persistence
  ├── ipfs/             IPFS datastore
  ├── cln-mainnet/      CLN channel DB, configs, runes
  │   └── tor/          Tor hidden service keys
  ├── tor-drawbridge/   Drawbridge Tor hidden service
  ├── lnbits/           LNbits database
  ├── prometheus/        Metrics (15d retention)
  ├── grafana/          Dashboard configs
  └── share/            Shared CLI/IPFS volume
```
