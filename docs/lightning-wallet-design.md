# Lightning Wallet Integration — Design Document

## Problem

Archon agents need Lightning Network payment capabilities (zaps, L402 paywalls, peer-to-peer payments). Each agent identity (DID) needs its own Lightning wallet so funds are isolated.

## Architecture

LNbits is the Lightning backend, hosted internally. Agents never interact with LNbits directly — all Lightning operations go through Drawbridge, the public-facing API gateway.

```
Agent (Keymaster) ──POST──▶ Drawbridge ──POST──▶ LNbits
       │                        │                (internal)
   encrypted                 env var
    wallet               (server URL)
  (per-DID
  credentials)
```

**Keymaster** manages agent identities and wallets. It knows about Drawbridge (its gateway) but has no knowledge of LNbits.

**Drawbridge** is the public gateway. It knows the LNbits server URL (env var) and proxies all Lightning operations. It is stateless per-wallet — it doesn't store any per-DID state.

**LNbits** is never exposed publicly. Each DID gets its own LNbits account (via `POST /api/v1/account`), providing full isolation at the account level.

## Credential Flow

**Wallet creation:**
1. Agent calls `addLightning()` on Keymaster
2. Keymaster POSTs to Drawbridge `/lightning/wallet`
3. Drawbridge calls LNbits `POST /api/v1/account` to create a new account with an initial wallet
4. LNbits returns `walletId`, `adminKey` (spend), `invoiceKey` (read-only)
5. Drawbridge passes these back to Keymaster
6. Keymaster stores them in the agent's encrypted wallet under `idInfo.lightning`

**Subsequent operations:**
1. Agent calls a Lightning method (e.g. `createLightningInvoice`)
2. Keymaster reads stored credentials from wallet
3. Keymaster POSTs to Drawbridge with the relevant key (`adminKey` for spending, `invoiceKey` for read-only)
4. Drawbridge forwards to LNbits with that key in the `X-Api-Key` header
5. Result flows back to the agent

This means Drawbridge needs no per-agent state — credentials travel with each request.

## Security Model

- **LNbits URL**: Only in Drawbridge env var. Keymaster and agents never learn the LNbits server address.
- **Per-DID keys** (`adminKey`, `invoiceKey`): Stored only in the agent's encrypted wallet. Never in the public DID document. Sent to Drawbridge per-request over HTTPS.
- **`adminKey`** authorizes spending. Only sent for `pay` operations.
- **`invoiceKey`** is read-only. Used for balance checks, invoice creation, and payment status queries.
- **No shared account key**: Each DID gets its own LNbits account via `POST /api/v1/account` (no auth required). Drawbridge holds no account-level secrets — only the LNbits server URL.

## Operations

All Drawbridge Lightning endpoints use POST to keep keys out of URLs and query strings.

| Operation | Key Used | Description |
|---|---|---|
| Create wallet | *(none — unauthenticated LNbits call)* | Creates a new LNbits account+wallet for a DID |
| Get balance | `invoiceKey` | Returns balance in satoshis |
| Create invoice | `invoiceKey` | Creates a BOLT11 payment request |
| Pay invoice | `adminKey` | Pays an external BOLT11 invoice |
| Check payment | `invoiceKey` | Checks whether an invoice has been paid |

Wallet creation is idempotent — calling it again for a DID that already has credentials returns the existing config without hitting LNbits.

## Graceful Degradation

Two error modes, clearly distinguished:

1. **Lightning unavailable**: Keymaster is connected to a plain Gatekeeper (no Drawbridge), or Drawbridge has no LNbits configured. The agent gets a clean error and can continue using all non-Lightning features.

2. **Lightning not configured**: The agent hasn't created a wallet yet (no `addLightning()` call). Error tells them to set up Lightning first.

This ensures agents that don't need Lightning are completely unaffected, and agents connected to infrastructure without Lightning get actionable errors rather than cryptic failures.

## Multi-Identity Support

All operations accept an optional identity parameter. An agent managing multiple DIDs can create separate wallets for each and operate on any of them. Funds are fully isolated between DIDs. Removing Lightning credentials from a DID only deletes the local keys — the LNbits wallet continues to exist (this is intentional; credentials could be backed up or recovered).
