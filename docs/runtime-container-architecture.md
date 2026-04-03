# Runtime Docker Container Architecture

This document describes the runtime container topology for the bundled Archon Docker Compose stack.

It focuses on long-running containers and their network relationships rather than build-time Dockerfiles.

## Full Runtime Topology

```mermaid
flowchart TD
    subgraph Clients[Client UIs]
        GKC[gatekeeper-client :4225]
        KMC[keymaster-client :4227]
        RW[react-wallet :4228]
        DBC[drawbridge-client :4223]
        HC[herald-client :4231]
        EX[explorer :4000]
    end

    subgraph Core[Core Identity Services]
        GK[gatekeeper :4224]
        KM[keymaster :4226]
        HY[hyperswarm-mediator :4232]
    end

    subgraph Storage[Stateful Infrastructure]
        MDB[(mongodb)]
        RDS[(redis)]
        IPFS[(ipfs)]
    end

    subgraph Payments[Bitcoin and Lightning]
        DB[drawbridge :4222]
        LM[lightning-mediator :4235]
        LN[lnbits :5000]
        BMW[btc-mainnet-wallet :4242]
        BMM[btc-mainnet-mediator :4234]
        BSW[btc-signet-wallet :4240]
        BSM[btc-signet-mediator :4236]
        BTN[btc-signet-node]
        BT4W[btc-testnet4-wallet :4244]
        BT4M[btc-testnet4-mediator]
        BT4N[btc-testnet4-node]
    end

    subgraph Naming[Herald and Onion Access]
        H[herald :4230]
        TOR[tor]
    end

    GKC --> GK
    KMC --> KM
    RW --> GK
    DBC --> DB
    HC --> DB
    EX --> GK

    KM --> GK
    HY --> GK
    HY --> KM

    GK --> MDB
    GK --> RDS
    GK --> IPFS
    KM --> MDB
    KM --> RDS
    HY --> IPFS

    DB --> GK
    DB --> LM
    DB --> H
    DB --> RDS
    H --> GK
    H --> KM
    H --> RDS
    H --> IPFS

    LM --> GK
    LM --> RDS
    LM --> LN
    TOR --> DB
    TOR --> LM

    BMM --> BMW
    BMM --> GK
    BMM --> KM
    BSW --> KM
    BSM --> BSW
    BSM --> BTN
    BSM --> GK
    BSM --> KM
    BT4W --> KM
    BT4M --> BT4W
    BT4M --> BT4N
    BT4M --> GK
    BT4M --> KM
```

## Core Identity Path

```mermaid
flowchart LR
    UI[gatekeeper-client / keymaster-client / react-wallet / explorer]
    GK[gatekeeper]
    KM[keymaster]
    HY[hyperswarm-mediator]
    MDB[(mongodb)]
    RDS[(redis)]
    IPFS[(ipfs)]

    UI --> GK
    UI --> KM
    KM --> GK
    HY --> GK
    HY --> KM
    GK --> MDB
    GK --> RDS
    GK --> IPFS
    KM --> MDB
    KM --> RDS
    HY --> IPFS
```

## Drawbridge, Herald, and Lightning

```mermaid
flowchart LR
    Public[Public clients]
    DBC[drawbridge-client]
    HC[herald-client]
    DB[drawbridge]
    H[herald]
    LM[lightning-mediator]
    LN[lnbits]
    TOR[tor hidden service]
    GK[gatekeeper]
    KM[keymaster]
    RDS[(redis)]
    IPFS[(ipfs)]

    Public --> DB
    DBC --> DB
    HC --> DB
    TOR --> DB
    DB --> H
    DB --> LM
    DB --> GK
    DB --> RDS
    H --> GK
    H --> KM
    H --> RDS
    H --> IPFS
    LM --> GK
    LM --> RDS
    LM --> LN
    TOR --> LM
```

## Bitcoin Runtime Containers

```mermaid
flowchart LR
    KM[keymaster]
    GK[gatekeeper]

    subgraph Mainnet[Mainnet]
        BMW[btc-mainnet-wallet]
        BMM[btc-mainnet-mediator]
    end

    subgraph Signet[Signet]
        BTN[btc-signet-node]
        BSW[btc-signet-wallet]
        BSM[btc-signet-mediator]
    end

    subgraph Testnet4[Testnet4]
        BT4N[btc-testnet4-node]
        BT4W[btc-testnet4-wallet]
        BT4M[btc-testnet4-mediator]
    end

    BMM --> BMW
    BMM --> GK
    BMM --> KM

    BSW --> KM
    BSM --> BTN
    BSM --> BSW
    BSM --> GK
    BSM --> KM

    BT4W --> KM
    BT4M --> BT4N
    BT4M --> BT4W
    BT4M --> GK
    BT4M --> KM
```

## Notes

- `drawbridge` is the public API gateway for Herald naming routes, L402 flows, and Lightning proxying.
- `lightning-mediator` owns LNbits access and Lightning wallet operations.
- `keymaster` and `gatekeeper` remain the core identity/runtime services for DID and wallet operations.
- Bitcoin support is split into per-network wallet containers plus matching mediators.
- `tor` publishes the Drawbridge onion service and gives the Lightning stack a SOCKS proxy path for onion-based Lightning endpoints.
