# Operation Mining: Incentivized BTC Anchoring

## Overview

Operation mining is a mechanism that allows gatekeeper operators to earn sats by anchoring DID operations on Bitcoin. Users attach ecash fees to operations, and the mediator that successfully anchors a batch containing those operations collects the fees. A federated mint run by the gatekeeper network provides trustless escrow — fees are released only on proof of on-chain anchoring.

## Motivation

Currently, running a gatekeeper with a satoshi mediator is purely altruistic. The operator pays BTC transaction fees to anchor batches but receives nothing in return. This creates a centralization risk: if only one party is willing to bear the cost, the network depends on a single point of failure.

Operation mining aligns incentives so that anyone running a gatekeeper can earn revenue proportional to the anchoring work they perform, encouraging a decentralized network of independent operators.

## Architecture

### Components

```
                                    Gatekeeper Network
                                    (Federation Members)
                                   ┌─────────────────────┐
                                   │  GK-A (mediator)     │
User (Keymaster)                   │  GK-B (mediator)     │
┌──────────────┐    hyperswarm     │  GK-C (mediator)     │
│ Create op    │──────────────────>│  GK-D                │
│ Attach token │                   │  GK-E                │
└──────────────┘                   └─────────┬───────────┘
       │                                     │
       │ deposit sats                        │ anchor batch
       v                                     v
┌──────────────┐                   ┌─────────────────────┐
│ Federated    │<──────────────────│ Bitcoin              │
│ Mint         │  redeem on proof  │ (OP_RETURN)          │
└──────────────┘                   └─────────────────────┘
```

### Federated Mint

The mint is operated collectively by the gatekeeper network using threshold signatures (e.g., 3-of-5). No single operator holds the full signing key, so no single party can steal deposited funds or refuse to honor valid redemptions.

Federation membership is the set of gatekeepers running satoshi mediators — the same nodes that have Bitcoin full nodes and participate in anchoring.

### Token Format

Operations carry an optional fee token in the registration metadata:

```typescript
interface DocumentRegistration {
    version: number;
    type: 'agent' | 'asset';
    registry: string;
    fee?: OperationFee;
    // ...existing fields
}

interface OperationFee {
    amount: number;        // sats
    token: string;         // encoded ecash token
    mint: string;          // DID of the federation mint
}
```

The token is locked with a spending condition tied to the operation's CID: it can only be redeemed by presenting proof that the operation was anchored on BTC.

## Lifecycle

### 1. Deposit

The user deposits sats into the federated mint via Lightning (or on-chain). The mint issues ecash tokens to the user's wallet.

### 2. Attach Fee

When creating an operation targeting `BTC:mainnet`, the keymaster attaches an ecash token to the operation's `registration.fee` field. The token is locked with the condition: "redeemable on proof that this operation's CID is anchored on BTC:mainnet."

The fee amount is set by the user. Higher fees incentivize faster inclusion, analogous to Bitcoin transaction fees.

### 3. Distribute

The operation propagates via hyperswarm to all gatekeepers. Every gatekeeper with a satoshi mediator sees the operation and its attached fee in their queue.

### 4. Anchor

Mediators compete to anchor batches. Each mediator:
1. Collects pending operations from its queue (prioritizing higher fees)
2. Stores operations on IPFS, assembles a batch asset
3. Creates a BTC transaction with OP_RETURN containing the batch DID
4. Broadcasts the transaction to the Bitcoin network

Multiple mediators may attempt to anchor overlapping sets of operations. Bitcoin consensus determines which transactions get mined.

### 5. Verify and Redeem

After a batch is confirmed on-chain, the winning mediator submits a redemption request to the federation:

```typescript
interface RedemptionProof {
    token: string;         // the ecash token from the operation
    txid: string;          // Bitcoin transaction ID
    blockHeight: number;   // block containing the transaction
    batchDid: string;      // batch asset DID from OP_RETURN
    opCid: string;         // CID of the operation in the batch
}
```

Each federation member independently verifies:
1. The txid exists at the claimed block height
2. The OP_RETURN contains the batch DID
3. The batch asset's ops list includes the operation CID
4. The operation CID matches the token's spending condition

This verification reuses the same logic as `importBatchByCids` — gatekeepers already perform this validation when importing discovered batches.

If the threshold of federation members agree (e.g., 3-of-5), the token is redeemed and sats are released to the mediator.

### 6. Race Resolution

When a mediator loses the race (another mediator's transaction is mined first):
- The losing mediator's BTC transaction is rejected as it attempts to spend the same user fee inputs (if using on-chain UTXOs) or simply never confirms
- The losing mediator's own BTC UTXOs are never spent — they return to its wallet
- The ecash tokens can only be redeemed once, by the first mediator to present valid proof
- The cost of losing a race is negligible: only compute time and bandwidth

## Fee Economics

### User Perspective

- Users set their own fee amount per operation
- Zero-fee operations are still valid but may be deprioritized by mediators
- Fee market emerges naturally: during high demand, users offer higher fees for faster inclusion
- Fees are denominated in sats, paid via the federated mint

### Mediator Perspective

- Revenue = sum of operation fees in anchored batch - BTC transaction fee
- Mediators optimize by: batching many operations (amortizing the BTC tx fee), prioritizing high-fee operations, timing batches to minimize Bitcoin fee rates
- No capital at risk when losing a race — only opportunity cost
- Barrier to entry: Bitcoin full node + funded wallet + federation membership

### Fee Prioritization

Mediators can implement fee-based ordering when building batches:

```
Total batch revenue = Σ(operation fees) - BTC miner fee
```

A rational mediator selects the set of pending operations that maximizes total batch revenue, similar to how Bitcoin miners select transactions from the mempool.

## Security Considerations

### Mint Trust Model

The federation threshold (e.g., 3-of-5) means an attacker must compromise a majority of federation members to steal funds. Federation members are identified by DIDs and their participation is public.

### Verification Determinism

Redemption verification is fully deterministic — it depends only on publicly observable Bitcoin blockchain data. Honest federation members will always agree on whether a proof is valid, so threshold consensus is straightforward.

### Double Redemption

Ecash tokens are single-use. The mint tracks spent tokens and rejects duplicate redemption attempts. Even if multiple mediators submit proofs for the same operation (e.g., if the operation appears in multiple batches due to a reorg), only the first valid redemption succeeds.

### Griefing

A user could attach a token and then attempt to invalidate it before anchoring. Since the token is locked to the operation CID (not to a specific mediator), and the user cannot un-broadcast an operation from hyperswarm, this is not practical.

### Stale Operations

If an operation is never anchored (e.g., no mediator picks it up), the token remains unredeemed. The mint could support token expiry, allowing the user to reclaim funds after a timeout.

## Implementation Phases

### Phase 1: Single-Operator Mint

A single trusted gatekeeper operates a Cashu mint. Users deposit sats via Lightning, attach tokens to operations, and the mint operator verifies and redeems. This validates the fee mechanism and user experience without the complexity of federation.

- Add `fee` field to `DocumentRegistration`
- Integrate a Cashu mint (e.g., cashu-ts) into the gatekeeper
- Add deposit/withdrawal Lightning endpoints
- Add redemption verification using existing batch import logic
- Modify satoshi mediator to collect and redeem tokens after anchoring

### Phase 2: Federated Mint

Replace the single-operator mint with a threshold-signature federation across multiple gatekeepers. This removes the single point of trust.

- Implement key sharing / DKG (distributed key generation) across federation members
- Add federation consensus protocol for redemption approval
- Define federation membership and governance (join/leave)
- Integrate with Fedimint or implement custom threshold signing

### Phase 3: Fee Market

Enable fee-based prioritization and market dynamics.

- Mediators sort queue by fee density (sats per operation)
- Publish fee statistics (minimum fee for inclusion, average confirmation time)
- Wallet UI shows estimated fee for target confirmation time
- Support fee bumping (user resubmits operation with higher fee token)
