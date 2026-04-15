# Email ↔ Dmail Bridge Design

**Issue:** [#410 — Add email↔dmail bridge](https://github.com/archetech/archon/issues/410)

## Overview

Enable dmail users to send messages to email recipients and receive email replies as dmails, using the Herald service as a trusted courier.

## Core Concept: Herald as Trusted Courier

Users already trust their Herald instance with their name, identity credentials, and Lightning address resolution. The bridge extends this trust to message routing. Herald discovers dmails addressed to it, extracts the message, and delivers it as email.

### Why Herald

- Already owns the domain and DNS (e.g., `4tress.org`)
- Already has a service DID with a persistent keypair
- Already has a trust relationship with users (challenge-response auth, credential issuance)
- Already resolves user identities (`name@domain` → DID)
- No new service to deploy or trust

## How It Works

### Outbound: Compose Email from Dmail

1. User composes a dmail addressed to the Herald agent (in `to` or `cc`) with subject `[email to bob@gmail.com] Hello Bob`
2. Herald discovers it via `refreshNotices()` in the poll loop
3. Herald parses the email address and real subject from the `[email to ...]` prefix
4. Herald sends the email from `username@domain` with a reply-to of `reply+<token>@parse.domain`
5. The reply token is stored so future replies can be threaded back

### Outbound: Reply Forwarding (Dmail → Email)

1. An inbound email created a dmail with a stored email mapping (keyed by dmail DID)
2. User replies to that dmail (setting `reference` to the original dmail DID)
3. Herald's poll loop discovers the reply, matches the `reference` against stored mappings
4. Herald forwards the reply as email to the original email sender

### Inbound: Email Reply → Dmail (Token-Gated)

1. Email recipient replies to `reply+<token>@parse.domain`
2. Herald's webhook receives the reply via SendGrid Inbound Parse
3. Herald looks up the token to find the original dmail DID and sender DID
4. Herald creates a new dmail addressed to the original sender, with `reference` set for threading
5. Subject is prefixed with `[email from sender@example.com]` for identification

### Inbound: Unsolicited Email → Dmail

1. External sender emails `alice@domain`
2. Herald resolves `alice` to a DID via its user database
3. Herald creates a dmail addressed to Alice's DID with subject `[email from sender@example.com] Original subject`
4. An email mapping is stored so Alice's reply can be forwarded back

## Architecture

### Email Service Abstraction

The email sending layer is abstracted behind `EmailServiceInterface`:

```typescript
interface EmailServiceInterface {
    sendMail(params: SendMailParams): Promise<void>;
    isConfigured(): boolean;
}
```

`SendGridEmailService` is the current implementation. Additional providers (Mailgun, SES, etc.) can be added by implementing this interface.

### Storage

Reply tokens and email mappings are stored in Herald's existing database (JSON, SQLite, or Redis), not in separate files:

- **Reply tokens:** `token → { originalDmailDid, senderDid, senderName, emailRecipient, createdAt }`
- **Email mappings:** `dmailDid → { emailAddress, recipientDid, createdAt }`

Tokens expire after 30 days (configurable).

### SendGrid Integration

**Outbound:** SendGrid Mail Send API via `@sendgrid/mail`.

**Inbound:** SendGrid Inbound Parse webhook at `/api/inbound-email`.

**DNS setup:**
- Domain authentication: SPF, DKIM, DMARC records on the sending domain
- Inbound Parse: MX record on the parse subdomain (e.g., `parse.4tress.org`) pointing to `mx.sendgrid.net`
- Unsolicited inbound: MX record on the root domain pointing to `mx.sendgrid.net`

### Webhook Security

The inbound email endpoint supports basic auth via `ARCHON_HERALD_WEBHOOK_SECRET`. To enable it:

1. Generate a random secret (e.g., `openssl rand -hex 32`)
2. Set `ARCHON_HERALD_WEBHOOK_SECRET=<your-secret>` in Herald's environment
3. In the SendGrid Inbound Parse settings, set the destination URL to:

```
https://user:<your-secret>@herald.example.com/names/api/inbound-email
```

Replace `<your-secret>` with the same value in both places. The `user` part can be any string (it is ignored). SendGrid will include the credentials as a `Basic` auth header on every POST, and Herald will verify them.

Requests without valid credentials are rejected with 401. If `ARCHON_HERALD_WEBHOOK_SECRET` is not set, auth is not enforced (development only).

### Subject Conventions

Email addresses are encoded in dmail subjects to bridge between the two systems:

- **Inbound** (email → dmail): `[email from sender@example.com] Original subject`
- **Outbound compose** (dmail → email): `[email to recipient@example.com] Subject line`

### Sender Identity

The `From:` address uses the sender's Herald name:

```
From: alice via 4tress <alice@4tress.org>
```

The sender's Herald name is resolved from their DID via the Herald user database. If no name is found, the fallback is `dmail-user` with the default `dmail@domain` address.

## Environment Variables

```
ARCHON_HERALD_SENDGRID_API_KEY=SG.xxx          # SendGrid API key (omit to disable bridge)
ARCHON_HERALD_SENDGRID_FROM_EMAIL=dmail@domain  # default from address
ARCHON_HERALD_SENDGRID_PARSE_DOMAIN=parse.domain # inbound parse subdomain
ARCHON_HERALD_WEBHOOK_SECRET=<your-secret>      # basic auth secret for inbound webhook (same value goes in the SendGrid Parse URL)
ARCHON_HERALD_DOMAIN=domain                     # Herald's domain (used for from addresses)
```

## Spam Prevention

- Inbound spam score check: emails with score > 5 are silently rejected
- Token-gated replies: only emails to `reply+<token>@parse.domain` with valid tokens create threaded dmails
- Unsolicited inbound: only emails to registered Herald names are accepted; unknown names are ignored
- Webhook auth: prevents forged webhook calls

## Phasing

### Phase 1 — Complete ✅

- Outbound email send (dmail → email) via poll loop
- Inbound reply webhook (`/api/inbound-email`) with token-gated threading
- Unsolicited inbound email to `name@domain`
- Compose new email from dmail via `[email to ...]` subject convention
- Reply token and email mapping storage in Herald's DB (JSON/SQLite/Redis)
- Email service abstraction (`EmailServiceInterface`)
- Webhook basic auth

### Phase 2 — Future

- HTML email rendering
- Dmail attachment → email attachment bridging
- Email attachment → dmail attachment bridging
- Rate limiting per sender DID
- Bounce/unsubscribe handling
