# DIDComm Messaging Support — Design Document

## Problem

Archon agents can already encrypt, sign, and exchange data with each other (Dmail,
Notices, encrypted assets, verifiable credentials), but every one of these is an
Archon-specific format. There is no standards-based, interoperable way for an Archon
agent to message — or be messaged by — an agent built on a different stack.

[DIDComm Messaging v2](https://identity.foundation/didcomm-messaging/spec/v2.1/) (DIF)
is the de-facto standard for transport-agnostic, end-to-end-encrypted, DID-addressed
messaging. Supporting it would let Archon identities participate in the wider SSI
ecosystem (Credo-TS/Aries, Veramo, mobile wallets) and would give us a principled
protocol layer to carry credential issuance and presentation.

This document records the research behind DIDComm, how it lines up with Archon's
existing `did:cid` machinery, the key design decisions, and a phased plan to add support.

## Background: what DIDComm is

The mental model: resolve a DID → read its `keyAgreement` key and `DIDCommMessaging`
service endpoint → pack an encrypted (and optionally signed) envelope → deliver it,
directly or through mediators.

DIDComm defines three nested **envelope** formats:

| Envelope | Format | Purpose |
|---|---|---|
| **Plaintext** | JWM (JSON) | The message itself: `id`, `type`, `from`, `to`, `thid`/`pthid` (threading), `created_time`, `expires_time`, `body`, `attachments` |
| **Signed** | JWS | Non-repudiable sender authentication (used selectively) |
| **Encrypted** | JWE | The normal wire format — **anoncrypt** (ECDH-ES, anonymous sender) or **authcrypt** (ECDH-1PU, authenticated sender) |

On top of the envelopes sit **application protocols**, each identified by the message
`type` URI: Trust Ping, Discover Features, Basic Message, Out-of-Band invitations,
Coordinate-Mediation (routing), and the credential protocols (Issue-Credential /
Present-Proof).

### Cryptographic requirements

| Operation | Algorithms | Curves |
|---|---|---|
| Key agreement (encryption) | `ECDH-ES+A256KW` (anoncrypt), `ECDH-1PU+A256KW` (authcrypt) | **MUST**: X25519, P-256, P-384 · *optional*: P-521 |
| Content encryption | `A256CBC-HS512` (required), `A256GCM`, `XC20P` | — |
| Signing | `EdDSA`, `ES256`, `ES256K` | Ed25519, P-256, **secp256k1** |

## The secp256k1 constraint (drives the whole design)

Archon is **secp256k1 end-to-end**: verification methods, `EcdsaSecp256k1Signature2019`
proofs, and the existing JWE in [packages/cipher](../packages/cipher/) all use secp256k1.

DIDComm treats the two operations differently:

- ✅ **Signing** — `ES256K` (secp256k1) **is** an approved JWS algorithm. Archon's
  existing keys can sign DIDComm messages and be verified by compliant agents as-is.
- ⚠️ **Encryption** — secp256k1 is **not** an approved key-agreement curve. Encrypted
  DIDComm requires an **X25519, P-256, or P-384** key. Each Archon agent that wants to
  receive encrypted DIDComm must publish a new **key-agreement key** in its DID document.

Adding standard-curve key agreement is therefore the single largest piece of work, and
it is the prerequisite for everything past the signing-only case.

## Current Archon capabilities (reuse surface)

The codebase is well-positioned — much of the machinery exists already:

| DIDComm need | Already in Archon | Location |
|---|---|---|
| JWE (ECDH-ES + A256GCM) | `buildJweCompact` / pack-unpack | [packages/cipher/src/jwe.ts](../packages/cipher/src/jwe.ts) |
| Concat KDF (RFC 7518) | implemented | [packages/cipher/src/concat-kdf.ts](../packages/cipher/src/concat-kdf.ts) |
| Encrypt/decrypt to a DID | `encryptMessage` / `decryptMessage` | [packages/keymaster/src/keymaster.ts](../packages/keymaster/src/keymaster.ts) |
| Sign + verify | `addProof` / `verifyProof` | [packages/keymaster/src/keymaster.ts](../packages/keymaster/src/keymaster.ts) |
| Service endpoints in DID docs | `service[]`; `publishAddress`/`publishLightning` write them | [packages/gatekeeper/src/types.ts](../packages/gatekeeper/src/types.ts), [keymaster.ts](../packages/keymaster/src/keymaster.ts) |
| A messaging + notification layer | **Dmail** + **Notices** | [packages/keymaster/src/keymaster.ts](../packages/keymaster/src/keymaster.ts), [types.ts](../packages/keymaster/src/types.ts) |
| HTTP transport + client | Express APIs + axios `KeymasterClient` | [services/keymaster/server/src/keymaster-api.ts](../services/keymaster/server/src/keymaster-api.ts), [keymaster-client.ts](../packages/keymaster/src/keymaster-client.ts) |
| Connection/proof handshake | `createChallenge`/`createResponse`/`verifyResponse` | [packages/keymaster/src/keymaster.ts](../packages/keymaster/src/keymaster.ts) |
| Verifiable Credentials | W3C VC issue/verify | [packages/keymaster/src/keymaster.ts](../packages/keymaster/src/keymaster.ts) |

### Gaps

1. ~~**Standard-curve key agreement** (X25519) keys + DID-doc `keyAgreement` entries.~~
   *Done in Phase 1.*
2. **ECDH-1PU (authcrypt)** and **key-wrapping** (`...+A256KW`) — today's JWE uses direct
   ECDH-ES, not the wrapped/multi-recipient form DIDComm requires. *To build in `cipher`
   (Phase 2a).*
3. **The DIDComm envelope pack/unpack** (JWM plaintext, signed JWS, the specific
   encrypted-JWE shape with `kid`-addressed recipients). *To build in `cipher` (Phase 2a).*
4. **A `DIDCommMessaging` service endpoint** type + an inbound message receiver.
5. **A DID resolver that emits standard-shaped DID documents** so non-Archon agents can
   resolve `did:cid` (cross-ecosystem interop).
6. **Application protocols** + optional **mediator/routing**.

## Design decisions

**A. Build the crypto, or use a library? → Build it, pure-JS, by extending
[packages/cipher](../packages/cipher/).** DIDComm's primary target here is **in-browser
self-custody wallets** (react-wallet, browser-extension), which hold keys locally and so
must pack/unpack *client-side*. The audited SICPA library
([`didcomm`](https://www.npmjs.com/package/didcomm)) is Rust→WASM — and while WASM runs
in browsers, *nothing in DIDComm requires it*: every primitive is standard and already
available pure-JS via `@noble`. Buying the library only saves us writing the envelope
code, in exchange for per-bundler WASM wiring (Vite **and** Webpack), async init, a few
hundred KB of bundle, and an MV3 `wasm-unsafe-eval` CSP allowance — all concentrated in
the browser path we care most about. Extending `cipher` instead runs identically in Node
and the browser (exactly as `cipher` does today, with zero WASM). The cost is owning
three well-specified primitives — **ECDH-1PU**, **AES Key Wrap (A256KW)**, and
**A256CBC-HS512** — plus the JWE/JWS/JWM framing, on top of the ECDH-ES + Concat-KDF + JWE
scaffolding `cipher` already has. Correctness risk is contained by **interop-testing
against `didcomm-node`** (kept as a dev/test oracle, never a runtime dependency): our
`pack` must `unpack` under the library and vice-versa.

*(Revised from the original "use the SICPA library" decision once in-browser
self-custody was confirmed as the primary use case. The Phase 0 spike still stands — it
proved the library works and gives us the interop oracle — but the runtime is pure-JS.)*

**B. Which key-agreement curve? → X25519.** Mandatory-to-support, smallest/fastest, best
supported across implementations. Derive it deterministically from the existing wallet
seed (a new key index) so it needs no separate backup.

**C. Does DIDComm replace Dmail? → No, additive.** Dmail/Notices is a working internal
product; DIDComm is the *interop* layer. Re-expressing Dmail as a DIDComm protocol is a
possible future, out of scope for v1.

**D. Where does the inbound endpoint live?** A new lightweight `didcomm` service (mirrors
the `services/*` pattern) keeps concerns separate; alternatively extend **Drawbridge**
(already the public-facing gateway, with Tor). Recommend a dedicated service, revisiting
if Tor-based delivery is wanted early.

## Architecture

```
 send                                                receive
 ────                                                ───────
 keymaster.packDidComm(to, body, {authcrypt, sign})  inbound HTTP receiver
   │  resolveDID(to) ─▶ recipient keyAgreement pub JWK   application/didcomm-encrypted+json
   │  derive own X25519 (+ secp256k1 signing) keys          │
   ▼                                                         ▼
 cipher envelope crypto  (pure-JS, browser + node)      keymaster.unpackDidComm(jwe)
   • JWM plaintext → optional JWS (ES256K) → JWE            • own X25519 priv (from wallet)
   • anoncrypt ECDH-ES / authcrypt ECDH-1PU, + A256KW       • resolveDID(sender) to verify
   ▼                                                          authcrypt / JWS
 deliver ──HTTP POST──▶ recipient endpoint  ───────────▶   ▼ cipher unpacks → plaintext + meta
   application/didcomm-encrypted+json                     dispatch by message `type`
                                                          (trust-ping, basic-message, …)
```

Responsibilities split along the existing `cipher` ↔ `keymaster` line (the same split as
`encryptMessage` today):

- **`cipher`** (pure-JS, runs in browser + node) owns the **envelope crypto** on raw JWKs:
  build/parse the JWM plaintext, the JWS sign/verify layer, and the JWE (anoncrypt
  ECDH-ES / authcrypt ECDH-1PU, A256KW key-wrap, A256CBC-HS512 content encryption). No DID
  or wallet knowledge.
- **`keymaster`** orchestrates: resolve the recipient DID → its X25519 `keyAgreement`
  public JWK; derive the agent's own X25519 (and secp256k1 signing) keys from the wallet;
  call `cipher` to pack; on unpack, resolve the *sender's* DID to verify authcrypt/JWS.
  Private keys never leave the process holding the wallet — in a self-custody browser
  wallet, that's the browser.
- **`didcomm-node`** is used only in tests as an **interop oracle** to prove our envelopes
  are spec-compliant; it is not shipped.

## Phased implementation plan

**Phase 0 — Spike & decisions. ✅ done.** Validated `didcomm-node` against Archon-shaped
DIDs carrying X25519 keys (anoncrypt/authcrypt/`ES256K`-sign all round-trip); confirmed
X25519 works and secp256k1 signs as-is. Locked decisions A–D (A later revised to *build*).
The spike (`spike/didcomm-phase0`) is retained as the **interop oracle** for the build.

**Phase 1 — Standard-curve keys. ✅ done.** Deterministic X25519 derivation on a dedicated
HD branch (`m/44'/0'/{account}'/1/0`); `publishDidComm`/`unpublishDidComm` write/remove a
`keyAgreement` verification method (+ optional `DIDCommMessaging` service) via `updateDID`.
`cipher.generateX25519Jwk` + OKP JWK types; `DidCidDocument` gains `keyAgreement`. Wired
through interface/client/API. *Exit met:* resolved DID docs carry a valid X25519
`keyAgreement` key.

**Phase 2 — Envelope crypto (build) + pack/unpack API. ✅ done.** Two sub-steps:

- **2a — `cipher` envelope crypto (pure-JS).** Add the three missing primitives —
  **ECDH-1PU**, **AES Key Wrap (A256KW)**, **A256CBC-HS512** — plus JWE general/
  multi-recipient serialization, the JWS layer, and the JWM plaintext, as pure functions
  over raw JWKs (building on the existing ECDH-ES + Concat-KDF + JWE code). Unit-test each
  primitive **and interop-test against `didcomm-node`** (our `pack` → lib `unpack`, and the
  reverse) for spec-compliance.
- **2b — `keymaster` orchestration.** `packDidComm()` / `unpackDidComm()` that resolve the
  recipient (and, on unpack, sender) DID, derive the agent's keys, and call `cipher`. Add
  to the [`KeymasterInterface`](../packages/keymaster/src/types.ts),
  [client](../packages/keymaster/src/keymaster-client.ts), and REST routes. Because the
  crypto is pure-JS in `cipher`, this works unchanged in the browser-shared Keymaster core.

*Exit met:* `cipher.packDidCommMessage`/`unpackEncrypted`/`signJws` + keymaster
`packDidComm`/`unpackDidComm` (interface/client/API). anoncrypt + authcrypt + signed
round-trips between two real `did:cid` identities, unit-tested **and** interop-validated
against `didcomm-node` both directions. `DIDCommMessaging` service type + publish/unpublish
also landed in Phase 1.

**Requirement — cross-method interop.** Archon must exchange DIDComm with agents using
*other* DID methods (`did:key`, `did:web`, `did:peer`, …), not just `did:cid`. This rules
out any Archon-internal delivery shortcut (a foreign agent can't read our gatekeeper) and
mandates standard HTTP transport + multi-method DID resolution. The Phase 2 envelopes are
already spec-standard, so only resolution and transport are method-specific.

**Phase 3 — Cross-method + transport.** Split into:

- **3a — Multi-method resolution + foreign-key normalization. ✅ done.** `cipher`:
  `didKeyToX25519` (resolves `did:key` — `z6LS…` X25519 and `z6Mk…` Ed25519 with the
  spec-correct Ed25519→X25519 derivation, verified against the W3C vector) and
  `normalizeX25519PublicKey` (accepts `publicKeyJwk` **or** `publicKeyMultibase`).
  `keymaster.resolveDidForDidComm` resolves `did:key` locally and routes everything else
  through the gatekeeper (which has a universal-resolver fallback for `did:web` etc.);
  `pack`/`unpack` use it for recipient and sender keys. *Validated:* Archon `did:cid` ↔
  `did:key` both directions (keymaster e2e), and our pack to a `did:key` is unpacked by the
  reference `didcomm-node`. *Caveats:* foreign **signing** interop needs `EdDSA` verify
  (we only verify `ES256K` today); some ecosystems use **P-256** key agreement (cipher is
  X25519-only) — both additive later. For *others* to resolve `did:cid`, Archon needs a
  Universal Resolver driver (separate work).
- **3b — Transport (mailbox). ✅ done.** New `services/didcomm/server` store-and-forward
  relay: `POST /api/v1/messages` stores an envelope by recipient DID (parsed from the JWE
  recipient kids); `GET /api/v1/challenge` + `POST /api/v1/messages/fetch` lets a recipient
  prove DID control with a single-use **signed challenge** (ES256K over the nonce, verified
  via gatekeeper resolution) and retrieve its queue; `messages/remove` acks. keymaster
  `sendDidComm` (pack → resolve the recipient's `DIDCommMessaging` endpoint → POST) and
  `receiveDidComm` (challenge → sign → fetch → unpack → ack), wired through
  interface/client/API. In-memory store with TTL by default, or a **redis** backend (native
  key expiry) via `ARCHON_DIDCOMM_DB`, both behind the async `MailboxStore` interface (mongo
  can be added the same way). *Validated:* core logic unit tests (incl. the redis store
  against a live redis) + an e2e where two Archon identities exchange authcrypt/signed
  messages through the live relay over HTTP, with a forged fetch rejected. Dockerized
  (`docker/Dockerfile.didcomm` + the opt-in `didcomm` compose profile).
- **3c — Forward/routing** for recipients behind a mediator (`serviceEndpoint` = mediator
  DID + `routingKeys`) — required for many external agents.

*Exit:* a self-custody recipient receives and unpacks a message delivered to its published
endpoint, including from a non-Archon agent.

**Phase 4 — Core protocols.** Trust Ping, Discover Features, Basic Message, Out-of-Band
invitation (maps cleanly onto the existing `createChallenge`/`createResponse`). *Exit:*
interop test against a reference agent (Credo-TS or didcomm.org tooling).

**Phase 5 — Credential protocols.** Map Issue-Credential 3.0 / Present-Proof onto
Archon's existing VC issue/verify. *Exit:* issue + present a VC over DIDComm.

**Phase 6 — Routing/mediation (optional).** Forward messages + Coordinate-Mediation so
offline/NAT'd agents work; natural fit with Drawbridge/Tor.

**Phase 7 — Parity & polish.** Python SDK parity ([python/](../python/)), CLI commands,
docs.

## Risks & open questions

- **Cross-ecosystem resolution.** External agents must resolve `did:cid`. Archon-to-Archon
  is fine; broad interop needs a Universal Resolver driver for the method — scope early if
  external interop is a goal rather than internal-only.
- **Curve migration UX.** Existing identities predate key-agreement keys; need a clean
  "enable DIDComm on this ID" upgrade path (a DID-doc update, not a re-issuance).
- **We own the envelope crypto** (ECDH-1PU, A256KW, A256CBC-HS512) rather than reusing an
  audited library. Mitigated by interop-testing every mode against `didcomm-node` in both
  directions, and by reusing `cipher`'s existing ECDH-ES/Concat-KDF/JWE code. Subtle spots:
  Concat-KDF inputs for 1PU, the protected-header AAD binding, and exact base64url framing.
- **Authcrypt vs. signed semantics.** Choose per-protocol defaults deliberately; DIDComm
  favours authcrypt over signed-then-encrypted for repudiability.

## Status & next step

Phases 0, 1, and 2 are complete: the spike + interop oracle, X25519 `keyAgreement` keys in
DID documents, the pure-JS envelope crypto in `cipher`, and keymaster
`packDidComm`/`unpackDidComm` — anoncrypt/authcrypt/signed all round-trip between real
`did:cid` identities and interoperate with `didcomm-node`.

Phase **3a** is also done: cross-method DID resolution (`did:key` locally + universal-resolver
fallback for the rest) and foreign-key normalization, validated by exchanging messages
between Archon `did:cid` and `did:key` agents (including against the reference library).

Phase **3b** is also done: a dedicated `services/didcomm/server` mailbox relay with
signed-challenge fetch auth, plus keymaster `sendDidComm`/`receiveDidComm`, validated by a
live two-identity HTTP exchange.

The `didcomm` service is Dockerized and wired into compose (opt-in `didcomm` profile), with
in-memory and redis store backends.

**Next:** **3c** (Forward/routing to mediators) and the remaining protocol phases (4 core
protocols, 5 credential protocols, 7 parity). Plus the noted cross-method follow-ons (EdDSA
verify, P-256 key agreement, a Universal Resolver driver for `did:cid`) and an optional
mongo store backend.

## References

- [DIDComm Messaging v2.1](https://identity.foundation/didcomm-messaging/spec/v2.1/) ·
  [v2.0](https://identity.foundation/didcomm-messaging/spec/v2.0/)
- [Encryption spec](https://github.com/decentralized-identity/didcomm-messaging/blob/main/docs/spec-files/encryption.md)
  (algorithm/curve requirements) · [RFC 7518 JWA](https://www.rfc-editor.org/rfc/rfc7518)
  (Concat-KDF, A256KW, A256CBC-HS512) · [ECDH-1PU draft](https://datatracker.ietf.org/doc/html/draft-madden-jose-ecdh-1pu-04)
- [DIDComm book](https://didcomm.org/book/v2/whatsnew/) ·
  [Coordinate Mediation 2.0](https://didcomm.org/coordinate-mediation/2.0/)
- [`didcomm-node` npm (SICPA Rust/WASM)](https://www.npmjs.com/package/didcomm-node) — kept
  as the dev/test interop oracle, not shipped.
