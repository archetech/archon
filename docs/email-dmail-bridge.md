# Email ↔ Dmail Bridge Design

**Issue:** [#410 — Add email↔dmail bridge](https://github.com/archetech/archon/issues/410)

## Overview

Enable dmail users to send messages to email recipients and receive email replies as dmails, using the Herald service as a trusted courier.

## Core Concept: Herald as Trusted Courier

Users already trust their Herald instance with their name, identity credentials, and Lightning address resolution. The bridge extends this trust to message routing. The user CC's the Herald agent DID on any dmail that contains email recipients. Herald, now a vault member with decryption access, extracts the message and delivers it as email.

### Why Herald

- Already owns the domain and DNS (e.g., `archon.social`)
- Already has a service DID with a persistent keypair
- Already has a trust relationship with users (challenge-response auth, credential issuance)
- Already resolves user identities (`name@domain` → DID)
- No new service to deploy or trust

### Opt-in Per Message

Adding Herald to CC is a deliberate act. Only messages explicitly routed through Herald are decryptable by Herald. Pure dmail-to-dmail stays end-to-end encrypted.

## How It Works

### Outbound: Dmail → Email

1. User composes a dmail with one or more email addresses in `to` (e.g., `bob@gmail.com`)
2. User adds the Herald agent DID to `cc`
3. `createDmail()` adds both `to` and `cc` as vault members — Herald gets a decryption key
4. `sendDmail()` creates a notice; Herald discovers it via `refreshNotices()`
5. Herald decrypts the dmail, identifies email recipients, renders the body as plaintext
6. Herald sends the email from `username@archon.social` with a reply-to of `reply+<token>@archon.social`

### Inbound: Email Reply → Dmail

1. Email recipient replies to `reply+<token>@archon.social`
2. Herald's inbound mail handler receives the reply
3. Herald looks up the token to find the original dmail DID and sender DID
4. Herald creates a new dmail (as the Herald agent DID) addressed to the original sender, with `reference` set to the original dmail DID for threading
5. Herald sends the dmail via `sendDmail()`; original sender discovers it via `refreshNotices()`

### Inbound: Unsolicited Email → Dmail

1. External sender emails `alice@archon.social`
2. Herald resolves `alice` to a DID via its name registry
3. Herald creates a dmail addressed to Alice's DID
4. Alice discovers it via `refreshNotices()`

## What Exists Today

| Component | Status |
|-----------|--------|
| Herald service DID | ✅ Created on startup, persists in wallet |
| CC grants vault membership + decryption | ✅ `addVaultMember()` called for CC recipients |
| Notice discovery (`refreshNotices()`) | ✅ Works for any DID |
| `DmailMessage.reference` for threading | ✅ Exists |
| Herald name → DID resolution | ✅ Via `.well-known/names` |
| `encryptForSender` (sender retains access) | ✅ Exists |
| DNS / domain ownership | ✅ Herald already owns the domain |

## What Needs to Be Built

### 1. Dmail Poll Loop in Herald

Herald needs a background loop that periodically calls `refreshNotices()` to discover dmails where it's a CC'd vault member. On discovery:

- Decrypt the dmail
- Inspect `to` and `cc` for email addresses (vs. DIDs)
- Queue email delivery for email recipients

### 2. Mailgun Integration (Send + Receive)

**Decision:** Use [Mailgun](https://www.mailgun.com/) for both outbound sending and inbound receiving. The free tier provides 100 emails/day, 1 custom sending domain, and 1 inbound route — sufficient for development and early production. Upgrade to Basic ($15/mo, 10K emails/mo) when volume warrants.

**Why Mailgun over alternatives:**

- Inbound routing with wildcard pattern matching (`reply+*@domain`) — ideal for the reply-token scheme
- Both send and receive in one provider — single integration, single set of credentials
- Developer-focused REST API with official Node.js SDK (`mailgun.js`)
- Handles deliverability (shared IP pool, SPF/DKIM/DMARC), bounce classification, and spam filtering
- Free tier is generous enough to prove the feature before committing spend

**Outbound setup:**

- Configure `archon.social` (or operator's domain) as a custom sending domain in Mailgun
- Add DNS records: SPF TXT, DKIM TXT, DMARC TXT (Mailgun provides these)
- Send via Mailgun REST API (`POST /messages`) from Herald

**Inbound setup:**

- Add MX records pointing to Mailgun's inbound servers (`mxa.mailgun.org`, `mxb.mailgun.org`)
- Create one inbound route: `match_recipient("reply+*@archon.social")` → `forward("https://archon.social/api/inbound-email")`
- Herald exposes a webhook endpoint that receives parsed email as JSON (from, to, subject, body-plain, attachments, DKIM/SPF results)
- Validate Mailgun's webhook signature on every request

**Environment variables:**

```
MAILGUN_API_KEY=key-xxx
MAILGUN_DOMAIN=archon.social
MAILGUN_WEBHOOK_SIGNING_KEY=xxx
```

### 3. Reply Token Mapping

When sending outbound email, Herald generates a unique token per conversation and sets `Reply-To: reply+<token>@archon.social`. Herald maintains a lookup in its existing data store:

```
token → { originalDmailDid, senderDid, emailRecipient, createdAt }
```

Tokens should expire after a configurable TTL (default: 30 days). Expired tokens result in a bounce reply to the email sender.

### 4. Email Address Detection

The dmail `to`/`cc` fields currently contain DIDs. The bridge needs to distinguish email addresses from DIDs. Use the `mailto:` URI scheme to avoid ambiguity with Herald names (which also use `name@domain` format):

- `did:mdip:...` → deliver as dmail (existing behavior)
- `mailto:bob@gmail.com` → deliver as email (bridge behavior)

Herald strips the `mailto:` prefix when constructing the email `To:` header.

### 5. Sender Identity in Email

The `From:` address uses the sender's Herald name on the bridging Herald instance:

```
From: Alice <alice@archon.social>
```

**Requirement:** The sender must have a registered Herald name on the CC'd Herald instance to use the bridge. This is a reasonable constraint — users already register a name to use Herald, and it provides a meaningful sender identity. Without a name, Herald rejects the bridge request (the dmail is still delivered to DID recipients normally; only the email leg fails).

### 6. Spam / Abuse Prevention

**Outbound:**

- Rate limit outbound emails per sender DID: 20 emails/hour, 100/day (configurable)
- Herald logs all bridge sends (sender DID, recipient email, timestamp) for audit, without logging message content

**Inbound (phase 1):**

- Accept only token-gated replies (`reply+<token>@archon.social`). Emails to any other address are silently dropped
- Validate Mailgun's SPF/DKIM results on every inbound webhook before creating a dmail
- Strip HTML and limit body size (e.g., 64KB) to prevent oversized dmails

**Inbound (phase 2):**

- Accept unsolicited email to `name@archon.social` for registered Herald users
- Add a second Mailgun route: `match_recipient("*@archon.social")` as a catch-all
- Apply stricter filtering: require SPF pass, DKIM pass, and basic content heuristics

## Decisions Summary

| # | Question | Decision |
|---|----------|----------|
| 1 | Email provider | Mailgun (free tier → Basic as needed) |
| 2 | Send approach | Mailgun REST API |
| 3 | Receive approach | Mailgun inbound routing → Herald webhook |
| 4 | Reply token storage | Herald's existing data store, 30-day TTL |
| 5 | Email address format in dmail | `mailto:` URI scheme |
| 6 | Sender identity | Require Herald name; no name = no bridge |
| 7 | Unsolicited inbound | Phase 1: replies only (token-gated) |
| 8 | Multiple Herald instances | The CC'd instance acts as courier |

## Phasing

### Phase 1 — Outbound + Reply

- Herald poll loop for notice discovery
- Mailgun outbound send for `mailto:` recipients
- Reply token generation and storage
- Inbound reply webhook (`/api/inbound-email`)
- Email address detection (`mailto:` prefix) in `to`/`cc`
- Rate limiting and audit logging
- DNS setup: SPF, DKIM, DMARC, MX records

### Phase 2 — Unsolicited Inbound

- Accept email to `name@archon.social` from anyone
- Catch-all Mailgun route
- Stricter spam filtering (SPF/DKIM required)
- Bounce/unsubscribe handling

### Phase 3 — Rich Content

- HTML email rendering
- Dmail attachment → email attachment bridging
- Email attachment → dmail attachment bridging
