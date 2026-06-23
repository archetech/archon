# Archon DIDComm Relay — Service Specification

Language-agnostic contract for the **DIDComm relay** — an optional
store-and-forward mailbox for [DIDComm Messaging v2](https://identity.foundation/didcomm-messaging/spec/v2.1/)
encrypted envelopes. Senders POST an encrypted envelope; a self-custody
recipient proves control of its DID (a signed challenge) and fetches the
queued envelopes to unpack locally. The relay never holds private keys
and cannot read the envelopes it stores.

The canonical implementation is
[services/didcomm/server/](../../../services/didcomm/server/).

> **Related.** The envelope crypto, key publication, and the
> sender/recipient/mediator client behaviour are specified in the
> [DIDComm design doc](../../didcomm-design.md). This document covers only
> the relay's HTTP surface, mailbox routing, auth, and storage. The
> matching client methods are `publishDidComm` / `sendDidComm` /
> `receiveDidComm` / `mediateDidComm` on Keymaster (and the Python
> port + SDK).

---

## 1. Service responsibilities

The relay sits on the network edge (typically behind the
[Drawbridge](../drawbridge/README.md) `/didcomm` reverse proxy) and has
three jobs:

1. **Accept inbound envelopes.** Anyone MAY `POST` a DIDComm encrypted
   (JWE) envelope. The relay parses the recipient DID(s) from the JWE
   recipient key ids and stores one copy in each recipient's mailbox. It
   does not (and cannot) decrypt.
2. **Gate retrieval to the DID controller.** A recipient fetches/removes
   its own queued envelopes only after answering a single-use,
   server-issued challenge with a signature from its DID's signing key.
3. **Expire undelivered mail.** Stored envelopes are pruned after a TTL
   (default 7 days). Challenges expire after 5 minutes.

It carries no key material and has no admin surface. The only trust it
places in the network is the Gatekeeper it resolves DIDs against.

The relay is **transport only** — it has no knowledge of the DIDComm
Forward/routing or coordinate-mediation protocols. A *mediator* is just
an ordinary recipient (a Keymaster running `mediateDidComm`) that fetches
Forward envelopes addressed to itself, unpacks them, and re-`POST`s the
inner envelope back to `/messages` for the final recipient.

---

## 2. HTTP API contract

Binds to `${ARCHON_BIND_ADDRESS}:${ARCHON_DIDCOMM_PORT}` (default
`0.0.0.0:4236`). All `/api/v1` request/response bodies are JSON except
the inbound envelope, which is `application/didcomm-encrypted+json`
(plain text). CORS is permissive (`cors()` defaults).

### 2.1 Health (no auth, not under `/api/v1`)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "ready": true }`. Used by the container healthcheck. |

### 2.2 Inbound delivery (no auth)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/messages` | Store an encrypted envelope for its recipient(s). |

Request body, accepted in three forms (in priority order):

1. `Content-Type: application/didcomm-encrypted+json` — the raw packed
   JWE string (the normal path; this is what `sendDidComm` sends).
2. JSON `{ "message": "<packed JWE string>" }`.
3. A raw JSON object — re-serialized and treated as the packed value.

The relay reads the recipient DIDs from the JWE `recipients[].header.kid`
values (`kid` is `<did>#<fragment>`; the DID is the part before `#`),
de-duplicates them, and stores one copy per recipient DID with a fresh
`id`.

Response `200`: `{ "ids": ["<uuid>", ...] }` — one id per recipient
mailbox the envelope was filed into. `400 { "error": "..." }` if the
body is not a DIDComm encrypted envelope (no recipient kids).

> Inbound delivery is intentionally open: the envelope is already
> encrypted to the recipient, and the recipient authenticates only to
> *read* its mailbox. A deployment that wants to limit who can deliver
> should do so at the proxy layer (e.g. Drawbridge).

### 2.3 Challenge (no auth)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/challenge` | `{ "challenge": "<base64url, 32 random bytes>" }`. |

Each challenge is **single-use** and expires after **5 minutes**. The
server records it; `fetch`/`remove` consume it (atomically removing it to
prevent replay).

### 2.4 Fetch / remove (DID-control auth)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/messages/fetch` | List the caller's queued envelopes. |
| `POST` | `/api/v1/messages/remove` | Acknowledge (delete) handled envelopes. |

Both take an auth triple in the JSON body (see [§3](#3-authentication)):

```jsonc
{ "did": "did:cid:…", "challenge": "<from /challenge>", "signature": "<hex>" }
```

`fetch` returns `{ "messages": [ { "id", "message", "received" }, … ] }`
where `message` is the stored packed envelope and `received` is an ISO
8601 timestamp.

`remove` additionally takes `{ "ids": ["<id>", …] }` and returns
`{ "removed": <count> }`. `400` if `ids` is not an array.

Typical recipient loop (`receiveDidComm`): `GET /challenge` → sign →
`POST /messages/fetch` → unpack each locally → `GET /challenge` again →
`POST /messages/remove` with the ids that unpacked. (A second challenge
is fetched for the remove call because each challenge is single-use.)

### 2.5 Status codes

- `200` — success.
- `400` — malformed body / not an encrypted envelope / missing
  `did`,`challenge`,`signature` / `ids` not an array.
- `401` — challenge unknown/expired/already used, or signature
  verification failed.

The error envelope is `application/json` `{ "error": "<message>" }`.
There is no `/metrics` endpoint and no admin API.

### 2.6 Body limits

`express.text` (for `application/didcomm-encrypted+json` and `text/*`)
and `express.json` are both capped at `ARCHON_DIDCOMM_UPLOAD_LIMIT`
(default `5mb`).

---

## 3. Authentication

Reading a mailbox requires proving control of the recipient DID:

1. Client calls `GET /api/v1/challenge` and receives a random challenge.
2. Client signs it: `signature = sign(hashMessage(challenge),
   didSigningKey)` — Archon's standard ES256K (secp256k1) signature over
   the SHA-256 message hash, the same primitive used everywhere else in
   the wallet.
3. Client `POST`s `{ did, challenge, signature }` to `fetch`/`remove`.
4. The relay **consumes** the challenge (single-use; missing/expired →
   `401`), resolves `did` via the Gatekeeper, and verifies the signature
   against the DID document's **first verification method**
   (`verificationMethod[0]`, which MUST be an `EC`/secp256k1
   `publicKeyJwk`). Failure → `401`.

The relay authenticates only the *reader*; it does not authenticate
senders (the envelope is already encrypted to the recipient).

---

## 4. Mailbox routing

The relay's only routing input is the JWE recipient key ids — it has no
keys and never decrypts. `recipientDidsFromEnvelope(packed)`:

1. Inspects the envelope; it MUST be `type: "encrypted"` with a
   non-empty `recipients` array (else `400`).
2. Maps each `recipients[].header.kid` to its DID (`kid.split('#')[0]`).
3. Returns the de-duplicated DID set.

A copy is stored per recipient DID, so a multi-recipient envelope is
fetchable by each addressee independently.

---

## 5. Storage contract

The store is an async interface so it can be backed by memory (default)
or Redis; a Mongo backend can be added the same way.

```ts
interface MailboxStore {
  add(recipient, envelope, id): Promise<StoredMessage>;
  list(recipient): Promise<StoredMessage[]>;       // prunes expired
  remove(recipient, ids): Promise<number>;          // returns count removed
  issueChallenge(challenge): Promise<void>;
  consumeChallenge(challenge): Promise<boolean>;    // single-use, replay-safe
}

interface StoredMessage { id; recipient; envelope; received; }  // received = ISO 8601
```

TTLs: messages **7 days** (`ARCHON_DIDCOMM_MESSAGE_TTL_MS`), challenges
**5 minutes** (fixed).

### 5.1 Memory backend (default)

In-process maps. `list()` lazily prunes envelopes older than the message
TTL; `consumeChallenge()` deletes the challenge and returns `true` only
if it was present and unexpired. Suitable for a single relay instance;
state is lost on restart.

### 5.2 Redis backend (`ARCHON_DIDCOMM_DB=redis`)

Native key expiry. Namespace `didcomm:`:

| Key | Type | TTL | Contents |
| --- | --- | --- | --- |
| `didcomm:inbox:<recipient>` | SET | message TTL | Message ids for the recipient. |
| `didcomm:msg:<recipient>:<id>` | STRING | message TTL (`EX`) | `StoredMessage` JSON. |
| `didcomm:challenge:<challenge>` | STRING | challenge TTL (`PX`) | `"1"`; consumed with `GETDEL` (single-use). |

`list()` reads the inbox set, `MGET`s the bodies, and lazily `SREM`s ids
whose bodies have already expired. A new implementation MUST use this
schema if it shares a Redis instance with the reference service.

---

## 6. Lifecycle and configuration

### 6.1 Startup

1. Connect to the Gatekeeper (`GatekeeperClient.create`,
   retry-until-ready) — used to resolve recipient DIDs for signature
   verification.
2. Construct the cipher and the store (`memory` or `redis`).
3. Build the Express app and listen on
   `${ARCHON_BIND_ADDRESS}:${ARCHON_DIDCOMM_PORT}`.

On a fatal startup error the process logs and exits `1`.

### 6.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_DIDCOMM_PORT` | `4236` | HTTP listen port. |
| `ARCHON_BIND_ADDRESS` | `0.0.0.0` | Listen address. |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper used to resolve recipient DIDs. |
| `ARCHON_DIDCOMM_DB` | `memory` | Mailbox store backend: `memory` or `redis`. |
| `ARCHON_REDIS_URL` | `redis://localhost:6379` | Redis URL when `ARCHON_DIDCOMM_DB=redis`. |
| `ARCHON_DIDCOMM_UPLOAD_LIMIT` | `5mb` | Max inbound body size. |
| `ARCHON_DIDCOMM_MESSAGE_TTL_MS` | `604800000` (7 days) | Undelivered-envelope retention. |

In Docker, the host-side bind is `${ARCHON_DIDCOMM_HOST_BIND:-127.0.0.1}`
(see [sample.env](../../../sample.env) and
[docker/compose/didcomm.yml](../../../docker/compose/didcomm.yml)).

### 6.3 Shutdown

SIGTERM/SIGINT closes the HTTP listener; the Redis backend disconnects on
`disconnect()`.

---

## 7. Deployment

- **Opt-in.** Enable with the `didcomm` compose profile
  (`COMPOSE_PROFILES=didcomm`).
- **Public exposure.** [Drawbridge](../drawbridge/README.md) reverse-
  proxies the relay at `/didcomm` (`ARCHON_DIDCOMM_URL`, default
  `http://didcomm:4236`), so a node can expose a single public endpoint.
  A DID advertises its mailbox by publishing a `DIDCommMessaging` service
  endpoint (via `publishDidComm`) pointing at that public URL; `sendDidComm`
  posts to `<endpoint>/api/v1/messages`. `publishDidComm` with no explicit
  endpoint auto-discovers the endpoint from the gateway
  (`GET /api/v1/didcomm-endpoint`), the same way `publishLightning` learns its
  public host: it uses `<ARCHON_DRAWBRIDGE_PUBLIC_HOST>/didcomm`, falling back to
  `http://<onion>:<port>/didcomm` resolved from the Tor hidden-service hostname
  fronting Drawbridge when no public host is set. Pass an endpoint explicitly to
  override (standalone relay, a different proxy, etc.).
- **Tor / NAT.** Because the recipient *pulls* its mail (it never needs an
  inbound connection), the relay works for offline/NAT'd agents and pairs
  naturally with a Tor hidden service.

---

## 8. Reference implementation and tests

- Source: [services/didcomm/server/](../../../services/didcomm/server/)
  - HTTP API: [src/didcomm-api.ts](../../../services/didcomm/server/src/didcomm-api.ts)
  - Store: [src/store.ts](../../../services/didcomm/server/src/store.ts)
  - Mailbox core (routing + challenge verify): [src/mailbox.ts](../../../services/didcomm/server/src/mailbox.ts)
- Image: `ghcr.io/archetech/didcomm`
- Compose: [docker/compose/didcomm.yml](../../../docker/compose/didcomm.yml)
- Tests: [tests/didcomm/](../../../tests/didcomm/) — store/auth unit tests
  (`mailbox.test.ts`) and a full two-identity-over-HTTP e2e
  (`e2e.test.ts`) covering delivery, signed-challenge fetch, the
  Alice→mediator→Bob Forward path, coordinate-mediation enrollment, and
  forged-fetch rejection.

A conformant implementation MUST:

- Serve the routes in [§2](#2-http-api-contract), including the `/health`
  shape the healthcheck depends on and the three accepted inbound body
  forms.
- Route inbound envelopes by the JWE recipient kids
  ([§4](#4-mailbox-routing)) without decrypting.
- Enforce single-use challenges and verify the recipient signature
  against `verificationMethod[0]` ([§3](#3-authentication)).
- Honor the message/challenge TTLs, and the Redis key schema in
  [§5.2](#52-redis-backend-archon_didcomm_dbredis) if sharing a Redis
  instance with the reference service.
