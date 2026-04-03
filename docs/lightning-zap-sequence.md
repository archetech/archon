# Lightning Zap

A lightning zap sends sats from the user's Lightning wallet to a recipient identified by either a **DID** (Decentralized Identifier), an **alias**, or a **LUD-16 Lightning Address** (e.g. `user@domain.com`).

## Overview

The flow has three distinct phases:

1. **Resolve the recipient** — identify who to pay and how to reach their Lightning node.
2. **Fetch an invoice** — ask the recipient's server to generate a BOLT11 payment request for the requested amount.
3. **Pay the invoice** — submit the BOLT11 through Archon's Lightning mediator, which uses the sender's configured Lightning backend to route the payment over the Lightning Network.

## Phase 1 — Resolve the recipient

The user invokes `lightning-zap <recipient> <amount> [memo]` from the CLI. The Keymaster class inspects the recipient string:

- If it contains `@` and does not start with `did:`, it is treated as a **LUD-16 Lightning Address** and used directly.
- Otherwise it is treated as a DID or human-readable alias and resolved to a full DID via Gatekeeper.

Keymaster also loads the sender's wallet to retrieve the sender's Lightning configuration, including the wallet credentials needed by the Lightning mediator to create invoices, pay invoices, and query payment status.

## Phase 2 — Fetch an invoice

Keymaster delegates to Drawbridge, which proxies Lightning work to the Lightning mediator. The mediator handles both recipient types:

**LUD-16 Lightning Address**

The Lightning mediator parses the `user@domain` string and performs two HTTP requests against the recipient's LNURL server (SSRF-protected — HTTPS required, private IPs blocked):

1. `GET https://domain/.well-known/lnurlp/user` — retrieves the LNURL pay metadata, including the callback URL and the min/max sendable amounts.
2. `GET {callback}?amount={msats}&comment={memo}` — requests a BOLT11 invoice for the specific amount (converted to millisats). The recipient's LNURL server asks their Lightning node to generate the invoice and returns it in the response.

**DID-based Zap**

The Lightning mediator resolves the recipient DID via Gatekeeper to obtain their DID Document, then locates the `#lightning` service endpoint. It validates the endpoint URL (`.onion` addresses must use `http://` and are proxied via Tor; clearnet addresses must use `https://`). It then calls `GET {serviceEndpoint}?amount={sats}&memo={memo}`, and the recipient's Lightning service generates and returns a BOLT11 invoice.

## Phase 3 — Pay the invoice

The Lightning mediator submits the BOLT11 invoice to the sender's configured Lightning backend, which routes the payment across the Lightning Network to the recipient's node. In the bundled stack that backend is LNbits (`POST /api/v1/payments`), but the mediator owns that integration boundary. Once the recipient's node settles the payment and returns the preimage, the backend confirms success to the mediator. The mediator returns the `paymentHash` up the call stack through Drawbridge to the CLI, which prints it as JSON.

## Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant CLI
    participant Keymaster
    participant DrawbridgeClient as Drawbridge Client<br/>(KeymasterClient)
    participant DrawbridgeAPI as Drawbridge API<br/>(POST /lightning/zap)
    participant LightningMediator as Lightning Mediator<br/>(/api/v1/lightning/zap)
    participant Gatekeeper
    participant RecipientServer as Recipient<br/>LNURL / DID Service
    participant RecipientNode as Recipient<br/>Lightning Node
    participant SenderBackend as Sender<br/>Lightning Backend
    participant LN as Lightning Network

    User->>CLI: lightning-zap <recipient> <amount> [memo]
    CLI->>Keymaster: zapLightning(recipient, amount, memo)

    alt recipient is LUD-16 (user@domain)
        Note over Keymaster: isLud16 = true, use as-is
    else recipient is DID or alias
        Keymaster->>Gatekeeper: lookupDID(id)
        Gatekeeper-->>Keymaster: did
    end

    Keymaster->>Keymaster: getLightningConfig()<br/>load wallet → fetch Lightning wallet config

    Keymaster->>DrawbridgeClient: drawbridge.zapLightning(config, recipient, amount, memo)
    DrawbridgeClient->>DrawbridgeAPI: POST /lightning/zap<br/>{did, amount, memo}
    DrawbridgeAPI->>LightningMediator: POST /api/v1/lightning/zap

    alt LUD-16 Lightning Address (user@domain)
        LightningMediator->>LightningMediator: Parse user@domain<br/>Validate domain (SSRF check)
        LightningMediator->>RecipientServer: GET https://domain/.well-known/lnurlp/user
        RecipientServer-->>LightningMediator: {callback, minSendable, maxSendable, ...}
        LightningMediator->>LightningMediator: Validate callback URL (HTTPS, SSRF check)<br/>Convert sats → msats, check limits
        LightningMediator->>RecipientServer: GET {callback}?amount={msats}&comment={memo}
        RecipientServer->>RecipientNode: Create invoice for {msats}
        RecipientNode-->>RecipientServer: BOLT11 invoice
        RecipientServer-->>LightningMediator: {pr: <BOLT11 invoice>}

    else DID-based Zap
        LightningMediator->>Gatekeeper: resolveDID(did)
        Gatekeeper-->>LightningMediator: DID Document
        LightningMediator->>LightningMediator: Find #lightning service endpoint<br/>Validate URL (onion→http, clearnet→https, SSRF check)
        LightningMediator->>RecipientServer: GET {serviceEndpoint}?amount={sats}&memo={memo}<br/>(via Tor proxy if .onion)
        RecipientServer->>RecipientNode: Create invoice for {sats}
        RecipientNode-->>RecipientServer: BOLT11 invoice
        RecipientServer-->>LightningMediator: {paymentRequest: <BOLT11 invoice>}
    end

    LightningMediator->>SenderBackend: payInvoice(bolt11)
    SenderBackend->>LN: Route payment to recipient node
    LN->>RecipientNode: Deliver payment
    RecipientNode-->>LN: Payment settled (preimage)
    LN-->>SenderBackend: Payment confirmed
    SenderBackend-->>LightningMediator: {payment_hash}

    LightningMediator-->>DrawbridgeAPI: {paymentHash}
    DrawbridgeAPI-->>DrawbridgeClient: {paymentHash}
    DrawbridgeClient-->>Keymaster: LightningPayment
    Keymaster-->>CLI: LightningPayment
    CLI->>User: JSON output {paymentHash}
```
