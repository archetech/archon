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

1. **Standard-curve key agreement** (X25519/P-256) keys + DID-doc `keyAgreement` entries.
2. **ECDH-1PU (authcrypt)** and **key-wrapping** (`...+A256KW`) — today's JWE uses direct
   ECDH-ES, not the wrapped/multi-recipient form DIDComm requires.
3. **The DIDComm envelope pack/unpack** (JWM plaintext, signed JWS, the specific
   encrypted-JWE shape with `kid`-addressed recipients).
4. **A `DIDCommMessaging` service endpoint** type + an inbound message receiver.
5. **A DID resolver that emits standard-shaped DID documents** so non-Archon agents can
   resolve `did:cid` (cross-ecosystem interop).
6. **Application protocols** + optional **mediator/routing**.

## Design decisions

**A. Build the crypto, or use a library? → Use the audited
[`didcomm`](https://www.npmjs.com/package/didcomm) library** (SICPA, Rust→WASM) for
envelope pack/unpack, with thin Archon adapters (a `DIDResolver` backed by the gatekeeper,
a `SecretsResolver` backed by the wallet). ECDH-1PU + key-wrapping + multi-recipient JWE
is security-critical and easy to get subtly wrong; we'd otherwise be hand-extending
[packages/cipher](../packages/cipher/). *Fallback* if the WASM dependency is unacceptable
in a target runtime: extend the cipher package — feasible (the JWE/KDF scaffolding exists)
but a real crypto-review burden.

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
 send                                            receive
 ────                                            ───────
 plaintext JWM
   │  resolveDID(recipient) ──▶ keyAgreement key + endpoint
   ▼
 pack (didcomm lib)                              inbound HTTP receiver
   • anoncrypt / authcrypt / sign                  application/didcomm-encrypted+json
   • DIDResolver  ← gatekeeper resolveDID            │
   • SecretsResolver ← wallet keys                   ▼
   │                                              unpack (didcomm lib)
   ▼                                                • DIDResolver / SecretsResolver
 deliver  ──HTTP POST──▶ recipient endpoint  ─────▶  │
   application/didcomm-encrypted+json                ▼
                                                  dispatch by message `type`
                                                  (trust-ping, basic-message,
                                                   issue-credential, …)
```

Two adapters bridge the `didcomm` library to Archon:

- **`DIDResolver`** — wraps the gatekeeper's `resolveDID` and normalizes a
  [`DidCidDocument`](../packages/gatekeeper/src/types.ts) into a standard DID document
  (exposing the X25519 `keyAgreement` verification method and the `DIDCommMessaging`
  service).
- **`SecretsResolver`** — exposes the agent's private keys (as JWK) from the wallet so
  the library can decrypt/sign; private keys never leave the keymaster process.

## Phased implementation plan

**Phase 0 — Spike & decisions.** Validate the `didcomm` WASM library against an Archon
DID carrying an X25519 key in a throwaway script; confirm the resolver/secrets adapter
shape. Lock decisions A–D. *Exit:* a pack→unpack round-trip between two Archon DIDs.

**Phase 1 — Standard-curve keys.** Add deterministic X25519 derivation to the wallet;
add `addDidCommKey()`/`publishDidComm()` that write a `keyAgreement` verification method +
entry into the agent's DID document via `updateDID` (model on `publishAddress`). Files:
[keymaster.ts](../packages/keymaster/src/keymaster.ts),
[gatekeeper/types.ts](../packages/gatekeeper/src/types.ts). *Exit:* resolved DID docs
carry a valid X25519 `keyAgreement` key.

**Phase 2 — Adapters + envelope API.** Implement `DIDResolver` and `SecretsResolver`;
add `packDidComm()` / `unpackDidComm()` to keymaster, the
[`KeymasterInterface`](../packages/keymaster/src/types.ts), the
[client](../packages/keymaster/src/keymaster-client.ts), and REST routes. *Exit:*
anoncrypt + authcrypt + signed round-trips, unit-tested.

**Phase 3 — Transport & service endpoint.** Add the `DIDCommMessaging` service type and
`publish`/`unpublish`; stand up the inbound HTTP receiver
(`application/didcomm-encrypted+json`) → unpack → dispatch; outbound delivery via the
resolved endpoint. *Exit:* two Archon nodes exchange a live message over HTTP.

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
- **WASM dependency** across all target runtimes (browser react-wallet, Node services) —
  validate in Phase 0.
- **Authcrypt vs. signed semantics.** Choose per-protocol defaults deliberately; DIDComm
  favours authcrypt over signed-then-encrypted for repudiability.

## Suggested first step

Combine Phase 0 + Phase 1 as one spike: a deterministic X25519 key in the wallet, written
into a DID document, and a `didcomm`-library round-trip proving the resolver/secrets
adapters work. That de-risks the curve strategy and the build-vs-buy decision before any
protocol/transport build-out.

## References

- [DIDComm Messaging v2.1](https://identity.foundation/didcomm-messaging/spec/v2.1/) ·
  [v2.0](https://identity.foundation/didcomm-messaging/spec/v2.0/)
- [Encryption spec](https://github.com/decentralized-identity/didcomm-messaging/blob/main/docs/spec-files/encryption.md)
- [DIDComm book](https://didcomm.org/book/v2/whatsnew/) ·
  [Coordinate Mediation 2.0](https://didcomm.org/coordinate-mediation/2.0/)
- [`didcomm` npm (SICPA Rust/WASM)](https://www.npmjs.com/package/didcomm) ·
  [Credo-TS `@credo-ts/didcomm`](https://www.npmjs.com/package/@credo-ts/didcomm)
