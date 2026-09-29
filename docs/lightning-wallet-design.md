# Lightning Wallet Integration — Design Document

## Problem

Archon agents need Lightning Network payment capabilities (zaps, L402 paywalls, peer-to-peer payments). Each agent identity (DID) needs its own Lightning wallet so funds are isolated.

## Architecture

LNbits is the Lightning backend, hosted internally. Agents never interact with LNbits directly. Keymaster sends Lightning operations to Drawbridge, the public-facing API gateway, which forwards them to the [Lightning mediator](services/mediators/lightning/README.md). The mediator is the only service that talks to LNbits.

```
Agent (Keymaster) ──POST──▶ Drawbridge ──POST──▶ Lightning mediator ──▶ LNbits
       │                        │                        │              (internal)
   encrypted                 env var                  env var
    wallet               (mediator URL)            (LNbits URL)
  (per-DID
  credentials)
```

**Keymaster** manages agent identities and wallets. It knows about Drawbridge (its gateway) but has no knowledge of the mediator or LNbits.

**Drawbridge** is the public gateway. It knows only the Lightning mediator's URL (`ARCHON_LIGHTNING_MEDIATOR_URL`) and forwards `/api/v1/lightning/*` and the public `/invoice/:did` endpoint there, adding its admin key (`X-Archon-Admin-Key`) to each request. It holds no Lightning state.

**Lightning mediator** knows the LNbits URL (`ARCHON_LIGHTNING_MEDIATOR_LNBITS_URL`) and turns each operation into LNbits API calls. Its admin routes accept only callers with the admin key, so in practice they are reached through Drawbridge. It stores no per-wallet credentials; its only Lightning-wallet state is the directory of published DIDs (see below).

**LNbits** is never exposed publicly. Each DID gets its own LNbits account (via `POST /api/v1/account`), providing full isolation at the account level.

The node's own Lightning wallet is separate: the mediator creates L402 paywall invoices on Core Lightning (CLN), not LNbits. See the [Drawbridge](services/drawbridge/README.md) and [Lightning mediator](services/mediators/lightning/README.md) specs for L402.

## Credential Flow

**Wallet creation:**
1. Agent calls `addLightning()` on Keymaster
2. Keymaster POSTs to Drawbridge `/api/v1/lightning/wallet`
3. Drawbridge forwards the request to the Lightning mediator
4. The mediator calls LNbits `POST /api/v1/account` to create a new account with an initial wallet
5. LNbits returns `walletId`, `adminKey` (spend), `invoiceKey` (read-only), which flow back through the mediator and Drawbridge
6. Keymaster stores them in the agent's encrypted wallet under `idInfo.lightning`, keyed by the Drawbridge URL

**Subsequent operations:**
1. Agent calls a Lightning method (e.g. `createLightningInvoice`)
2. Keymaster reads the stored credentials for its current Drawbridge from the wallet
3. Keymaster POSTs to Drawbridge with the relevant key (`adminKey` for spending, `invoiceKey` for read-only)
4. Drawbridge forwards the request to the mediator
5. The mediator calls LNbits with that key in the `X-Api-Key` header
6. Result flows back to the agent

This means neither Drawbridge nor the mediator needs per-agent credentials — they travel with each request.

## Security Model

- **LNbits URL**: Only in the Lightning mediator's env. Drawbridge knows only the mediator URL; Keymaster and agents know neither.
- **Admin key**: The mediator's `/api/v1/lightning/*` routes require `X-Archon-Admin-Key`. Drawbridge adds it when forwarding, so clients never hold it. Drawbridge's own `/api/v1/lightning/*` routes are not behind its L402 paywall; the per-DID keys are what authorize wallet operations.
- **Per-DID keys** (`adminKey`, `invoiceKey`): Stored only in the agent's encrypted wallet. Never in the public DID document. Sent to Drawbridge in the request body, per request.
- **`adminKey`** authorizes spending. Used for pay, zap, and listing payments.
- **`invoiceKey`** is read-only. Used for balance checks, invoice creation, and payment status queries.
- **No shared account key**: Each DID gets its own LNbits account via `POST /api/v1/account` (no auth required). The mediator holds no LNbits account-level secrets — only the LNbits server URL.
- **Published keys**: Publishing a DID's Lightning endpoint stores its `invoiceKey` in the mediator's Redis so anyone can request an invoice for that DID. That key can only create invoices and read the wallet; it cannot spend.

## Operations

All Lightning wallet endpoints use POST to keep keys out of URLs and query strings. Each is `/api/v1/lightning/<path>` on Drawbridge, forwarded unchanged to the mediator.

| Operation | Path | Key Used | Description |
|---|---|---|---|
| Create wallet | `wallet` | *(none — unauthenticated LNbits call)* | Creates a new LNbits account+wallet for a DID |
| Get balance | `balance` | `invoiceKey` | Returns balance in satoshis |
| Create invoice | `invoice` | `invoiceKey` | Creates a BOLT11 payment request |
| Pay invoice | `pay` | `adminKey` | Pays an external BOLT11 invoice |
| Check payment | `payment` | `invoiceKey` | Checks whether an invoice has been paid |
| List payments | `payments` | `adminKey` | Returns the wallet's payment history |
| Zap | `zap` | `adminKey` | Pays a DID or LUD-16 address; the mediator resolves the recipient and fetches the invoice |
| Publish | `publish` | `invoiceKey` | Registers the DID's `invoiceKey` so others can pay it |

Wallet creation is idempotent — calling it again for a DID that already has credentials for the current Drawbridge returns the existing config without creating another LNbits wallet.

## Receiving Payments

`publishLightning()` registers the DID's `invoiceKey` with the mediator (via Drawbridge `POST /api/v1/lightning/publish`) and adds a `#lightning` service of type `Lightning` to the DID document, pointing at `<public host>/invoice/<DID suffix>`. The public host is the node's configured public address or Tor onion, as reported by the mediator, falling back to the Drawbridge URL Keymaster uses.

Anyone can then `GET /invoice/<DID suffix>?amount=<sats>` on Drawbridge. That route requires no authentication; Drawbridge forwards it to the mediator, which looks up the published `invoiceKey` and asks LNbits for an invoice. Zaps to a DID use this endpoint. `unpublishLightning()` removes both the registration and the service entry.

## Graceful Degradation

Two error modes, clearly distinguished:

1. **Lightning unavailable**: Keymaster is connected to a plain Gatekeeper (no Drawbridge), or the node doesn't offer Lightning (Drawbridge's `/api/v1/capabilities` reports `lightning: false` when no mediator URL is configured, and its Lightning routes return 501). The mediator returns 503 when it has no LNbits URL. The agent gets a clean error and can continue using all non-Lightning features.

2. **Lightning not configured**: The agent hasn't created a wallet on this Drawbridge yet (no `addLightning()` call). Error tells them to set up Lightning first.

This ensures agents that don't need Lightning are completely unaffected, and agents connected to infrastructure without Lightning get actionable errors rather than cryptic failures.

## Multi-Identity Support

All operations accept an optional identity parameter. An agent managing multiple DIDs can create separate wallets for each and operate on any of them. Funds are fully isolated between DIDs. Credentials are stored per Drawbridge URL, so a DID can hold wallets on more than one node. Removing Lightning credentials from a DID only deletes the local keys for the current Drawbridge — the LNbits wallet continues to exist (this is intentional; credentials could be backed up or recovered).
