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
> `receiveDidComm` / `ackDidComm` / `mediateDidComm` on Keymaster (and the Python
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

Removal is a separate step from retrieval, so a client that wants to
store messages before deleting them can call `receiveDidComm` with
`ack: false` and issue the `remove` call later via `ackDidComm(ids)`.
Each unpacked result carries its mailbox `id` for that purpose. Anything
never acknowledged still expires on its own via the message TTL
(`ARCHON_DIDCOMM_MESSAGE_TTL_MS`, 7 days by default).

### 2.5 Status codes

- `200` — success.
- `400` — malformed body / not an encrypted envelope / missing
  `did`,`challenge`,`signature` / `ids` not an array.
- `401` — challenge unknown/expired/already used, or signature
  verification failed.
- `429` — a storage cap would be exceeded (see §5.3). On deposit the
  envelope was **not** stored: a JWE addressing several recipients is
  rolled back if a later mailbox is full, so a retry cannot duplicate
  delivery to the earlier ones. Also returned by `GET /challenge` when the
  live-challenge ceiling is reached.

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

In-process maps. `consumeChallenge()` deletes the challenge and returns
`true` only if it was present and unexpired. Suitable for a single relay
instance; state is lost on restart.

Expiry is swept on **write** — in `add()` and `issueChallenge()`,
amortised — rather than on read. Sweeping only on read meant a mailbox
nobody polled kept its envelopes indefinitely, and an unconsumed
challenge was never collected at all. Writes are the only thing that
grows either map, so an idle store needs no sweeping, and no timer is
used (a stray interval would leak a handle into CI).

### 5.2 Redis backend (`ARCHON_DIDCOMM_DB=redis`)

Native key expiry. Namespace `didcomm:`:

| Key | Type | TTL | Contents |
| --- | --- | --- | --- |
| `didcomm:inbox:<recipient>` | SET | message TTL | Message ids for the recipient. |
| `didcomm:msg:<recipient>:<id>` | STRING | message TTL (`EX`) | `StoredMessage` JSON. |
| `didcomm:challenge:<challenge>` | STRING | challenge TTL (`PX`) | `"1"`; consumed with `GETDEL` (single-use). |

`list()` reads the inbox set, `MGET`s the bodies, and lazily `SREM`s ids
whose bodies have already expired. `add()` does the same while measuring
the mailbox against its cap — necessary because `add()` refreshes the
inbox set's own TTL on every insert, so under sustained delivery the set
never expires and would otherwise accumulate ids whose bodies are long
gone. A new implementation MUST use this schema if it shares a Redis
instance with the reference service.

### 5.2.1 Rate limiting at the edge

Storage caps bound where a flood stops; they do not bound how fast it gets
there, and with a 10 MB body limit on the Drawbridge side a 256 MB cap is
reachable in a couple of dozen requests. Once storage is full the relay
answers `429` to legitimate senders too, for as long as an attacker keeps
it that way.

Drawbridge therefore rate-limits its public `/didcomm` passthrough, with
two buckets, because neither works alone:

Reads and deposits are budgeted separately, because they are not the same
load:

| Setting | Default | Budget |
| --- | --- | --- |
| `ARCHON_DRAWBRIDGE_DIDCOMM_READ_PER_SOURCE` | 300 | requests, per source |
| `ARCHON_DRAWBRIDGE_DIDCOMM_READ_GLOBAL` | 3000 | requests, whole surface |
| `ARCHON_DRAWBRIDGE_DIDCOMM_DEPOSIT_PER_SOURCE_BYTES` | 16 MB | bytes, per source |
| `ARCHON_DRAWBRIDGE_DIDCOMM_DEPOSIT_GLOBAL_BYTES` | 64 MB | bytes, whole surface |
| `ARCHON_DRAWBRIDGE_DIDCOMM_RATE_LIMIT_WINDOW` | 60s | window for all four |

**Deposits are budgeted in bytes, not requests.** A request ceiling loose
enough for normal traffic still permits a couple of dozen max-size
envelopes, and a couple of dozen is all it takes to fill the storage cap —
a request count is simply not the resource being consumed. Reads
(challenge/fetch/remove) stay on a request count: they are cheap and
chatty, one poll being four requests, so 300/minute clears an active
wallet comfortably.

**The per-source bucket applies only when the source identifies a client.**
`trust proxy` is not configured, so a request via the bundled Tor container
or any reverse proxy arrives from a private address that every such client
shares. Keying on it would throttle all of them together — and, worse,
would refuse them at the per-source ceiling long before the global one was
reached, so the global backstop could never do its job. Private, loopback,
link-local and CGNAT sources are therefore limited globally only. Configure
`trust proxy` if you terminate TLS at a proxy and want per-source limiting
to work.

The global budget is blunt by nature: during a flood it turns away
legitimate senders too. That is still better than the storage-full
alternative, where they are refused anyway and for longer.

Rate limiting raises the cost of a flood and slows it; it does not make
filling the store impossible. With a 10 MB body limit no request-count
ceiling could, which is why the storage caps in §5.3 exist as well.

If the limiter's own store is unreachable it **fails open**: it exists to
protect availability, and refusing every request would cause the outage it
is meant to prevent. Note what that leaves: the storage caps still bound
growth, but globally so **only on the memory backend**, or on redis given
a deployment-level `maxmemory` (§5.3). On a redis relay without one, an
attacker rotating recipient DIDs is bounded by the per-recipient cap
alone, which is to say not bounded at all.

This covers the public edge only. The relay remains directly reachable on
the internal network (port 4236).

### 5.3 Storage caps

Both write paths are unauthenticated by design: a sender must be able to
reach a stranger's mailbox, and `GET /challenge` is the first step of
proving DID control. TTLs alone therefore bound *retention*, not *growth*
— within the retention window an anonymous caller can still deposit
without limit, and the depositor chooses the recipient DID (routing is by
the JWE recipient kids). A per-recipient cap alone is no bound at all,
since a fresh DID sidesteps it.

| Setting | Default | Enforced on |
| --- | --- | --- |
| `ARCHON_DIDCOMM_MAX_RECIPIENT_BYTES` | 16 MB | memory + redis |
| `ARCHON_DIDCOMM_MAX_TOTAL_BYTES` | 256 MB | **memory only** |
| `ARCHON_DIDCOMM_MAX_CHALLENGES` | 10000 | **memory only** |

All numeric settings are validated at startup: a malformed, zero or
negative value fails the service rather than being parsed to `NaN`, which
would compare false against every cap and silently switch the bound off.

`ARCHON_DIDCOMM_MAX_CHALLENGES` is a ceiling on *live* challenges. The
challenge TTL bounds how long each entry survives, not how many an
anonymous caller can hold at once, so the ceiling is what actually bounds
that map. Reaching it answers `429` on `GET /challenge`.

Caps are byte-based, not message counts: with a multi-MB upload limit a
count says nothing about the resource that actually runs out. Exceeding a
cap rejects the deposit with `429` rather than evicting older messages,
so an attacker cannot push a recipient's real mail out of their mailbox.

On redis the per-recipient cap is **approximate**: the measurement and the
write are separate round trips, so concurrent deliveries — or several
relay instances sharing one redis — can both measure under the cap and
both commit. Overshoot is bounded by concurrency x message size. Treat the
cap as a safety bound rather than an accounting invariant; making it exact
needs a Lua script that prunes, measures and inserts in one step. The
memory backend is unaffected, having no await between measuring and
inserting.

**Redis has no total or challenge cap.** A running total would drift permanently,
because keys expiring via TTL never decrement it, and recomputing it
would mean scanning the keyspace on every write. Bounding total storage
on Redis is a deployment concern: give the relay a **dedicated Redis
instance or database** with `maxmemory` set. Do **not** set an eviction
policy on a Redis shared with the Gatekeeper, Drawbridge and the
mediators — it would evict their keys too.

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
