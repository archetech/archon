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

### 2. SMTP Send

Herald sends outbound email. Options:

| Approach | Pros | Cons |
|----------|------|------|
| **Self-hosted SMTP** (nodemailer + direct send) | No third-party dependency, full control | Deliverability challenges (reputation, IP warming, spam filters) |
| **Transactional email API** (Postmark, Mailgun, SES) | High deliverability, bounce handling built-in | Third-party dependency, cost, API keys |
| **Local MTA relay** (Postfix as smarthost) | Familiar ops pattern | More infrastructure to maintain |

**Open question:** Which approach? Self-hosted may be fine for low volume initially, with a migration path to a transactional provider.

### 3. Inbound Email Handler

Herald needs to receive email replies. Options:

| Approach | Pros | Cons |
|----------|------|------|
| **MX + SMTP server** (`smtp-server` npm) | Self-contained, no third-party | Must handle TLS, spam, connection management |
| **Inbound webhook** (Mailgun/Postmark inbound routing) | Managed, reliable, spam filtering included | Third-party dependency, webhook security |
| **IMAP poll** (fetch from a mailbox) | Simple, works with any mail provider | Latency (polling interval), credential management |

**Open question:** Same trade-off as outbound. A lightweight `smtp-server` keeps it self-contained.

### 4. Reply Token Mapping

When sending outbound email, Herald generates a unique token per conversation and sets `Reply-To: reply+<token>@archon.social`. Herald maintains a lookup:

```
token → { originalDmailDid, senderDid, emailRecipient, createdAt }
```

**Open question:** Storage backend? Herald already uses a JSON/DB store for its name registry. Same store, or separate?

### 5. Email Address Detection

The dmail `to`/`cc` fields currently contain DIDs. The bridge needs to distinguish:

- `did:mdip:...` → deliver as dmail (existing behavior)
- `user@domain.com` → deliver as email (bridge behavior)

**Open question:** Should email addresses be allowed directly in the `to`/`cc` arrays, or wrapped in a URI scheme like `mailto:bob@gmail.com`? Using `mailto:` is more explicit and avoids ambiguity with Herald names (which are also `name@domain`).

### 6. Sender Identity in Email

The `From:` address for outbound email should use the sender's Herald name:

```
From: Alice <alice@archon.social>
```

**Open question:** What if the sender doesn't have a Herald name on the sending Herald instance? Fall back to a generic address like `dmail-user@archon.social`? Or require a Herald name to use the bridge?

### 7. Spam / Abuse Prevention

- **Outbound rate limiting:** Cap emails per user per time window to prevent Herald from becoming a spam relay
- **Inbound filtering:** Basic spam checks on incoming email before creating dmails (SPF/DKIM validation, content heuristics, or delegated to a provider)
- **Unsolicited inbound:** Should Herald accept email from anyone, or only replies to existing conversations?

**Open question:** For phase 1, limit inbound to replies only (token-gated)? Or allow unsolicited inbound to any registered Herald user?

## Open Questions Summary

| # | Question | Options | Leaning |
|---|----------|---------|---------|
| 1 | SMTP send approach | Self-hosted / Transactional API / MTA relay | ? |
| 2 | Inbound email approach | SMTP server / Webhook / IMAP | ? |
| 3 | Reply token storage | Same Herald store / Separate DB | ? |
| 4 | Email address format in dmail | Raw `user@domain` / `mailto:` URI | ? |
| 5 | Sender identity without Herald name | Generic from-address / Require Herald name | ? |
| 6 | Unsolicited inbound email | Phase 1 replies only / Allow all | ? |
| 7 | Multiple Herald instances | Which one bridges? The CC'd one | CC'd one |

## Phasing

### Phase 1 — Outbound Only + Reply

- Herald poll loop for notice discovery
- SMTP send for email recipients
- Reply token generation
- Inbound reply handling (token-gated)
- Email address detection in `to`/`cc`

### Phase 2 — Unsolicited Inbound

- Accept email to `name@archon.social` from anyone
- Spam filtering
- Bounce/unsubscribe handling

### Phase 3 — Rich Content

- HTML email rendering
- Dmail attachment → email attachment bridging
- Email attachment → dmail attachment bridging
