# Archon Keymaster — Service Specification

This document is the language-agnostic contract that any Keymaster
implementation must satisfy. It is what the canonical TypeScript service at
[services/keymaster/server/](../../../services/keymaster/server/) — backed by
the [packages/keymaster/](../../../packages/keymaster/) SDK and the
[packages/cipher/](../../../packages/cipher/) primitives — already
implements, and what a third implementation in Go, Python, Java, etc. would
need to honor to be a drop-in replacement.

Implementation tracking for the current Python effort lives in
[drop-in-parity-checklist.md](drop-in-parity-checklist.md).

The TypeScript implementation is the **source of truth**. Any divergence
between this document and the TypeScript code is a bug in this document; file
an issue. A new implementation is conformant when it can be swapped into
`docker-compose.yml` and the rest of the Archon stack — the CLI, the React
wallet, Drawbridge, mediators, the Herald name service — keeps working.

> **Conventions.** All wire formats are JSON over HTTP. Field names are
> camelCase. Timestamps are RFC 3339 / ISO 8601 in UTC unless otherwise
> noted. DIDs follow the `did:cid:<cid>` form and are resolved through the
> Gatekeeper service. Cryptographic primitives use **secp256k1** for ECDSA
> and ECDH-ES, **SHA-256** for hashing, **AES-256-GCM** for symmetric
> encryption. "MUST", "SHOULD", "MAY" follow RFC 2119.

> **Related specs.** This document references the
> [Gatekeeper service spec](../gatekeeper/README.md) for DID resolution,
> registries, IPFS interaction, and the `Operation` / `DidCidDocument`
> types. Read the Gatekeeper spec first.

---

## Table of contents

1. [Service responsibilities](#1-service-responsibilities)
2. [HTTP API contract](#2-http-api-contract)
3. [Wallet model](#3-wallet-model)
4. [Cryptographic primitives](#4-cryptographic-primitives)
5. [Identity (ID) lifecycle](#5-identity-id-lifecycle)
6. [Aliases and addresses](#6-aliases-and-addresses)
7. [Asset lifecycle](#7-asset-lifecycle)
8. [Encryption envelope](#8-encryption-envelope)
9. [Credentials and challenges](#9-credentials-and-challenges)
10. [Groups, schemas, polls, vaults](#10-groups-schemas-polls-vaults)
11. [Files, images, dmail, notices](#11-files-images-dmail-notices)
12. [Nostr and Lightning passthrough](#12-nostr-and-lightning-passthrough)
13. [Storage backends](#13-storage-backends)
14. [Prometheus metrics contract](#14-prometheus-metrics-contract)
15. [Container and runtime contract](#15-container-and-runtime-contract)
16. [Error responses and logging](#16-error-responses-and-logging)
17. [Test fixtures and reference implementation](#17-test-fixtures-and-reference-implementation)

---

## 1. Service responsibilities

The Keymaster is the **wallet service** — the only Archon component that
holds private key material. It is responsible for:

- managing a single passphrase-encrypted **wallet** containing a BIP39
  mnemonic and a hierarchy of derived identities ("IDs")
- creating, resolving, updating, deleting **DIDs** by signing operations
  with the appropriate private key and submitting them to the Gatekeeper
- creating **assets** owned by an ID (encrypted messages, credentials,
  groups, schemas, polls, vaults, files, dmail, notices, etc.)
- issuing and verifying **W3C-compliant Verifiable Credentials**
- providing an **alias** namespace so callers can refer to DIDs by short
  human names
- providing an **address book** of LUD-16-style external addresses
- relaying **Nostr** signatures and **Lightning** zap/invoice/balance
  operations through the Drawbridge service
- exposing **encrypt / decrypt / sign / verify** primitives over HTTP for
  clients that don't want to reimplement secp256k1 / JWE

It is **not** responsible for:

- DID storage or block anchoring (Gatekeeper)
- Lightning node operation, LNbits, BOLT11 generation (Drawbridge / CLN)
- network synchronization between nodes (mediators)

A Keymaster server holds a single wallet file. The wallet file in turn
contains many IDs. Multi-tenancy is achieved by running multiple Keymaster
processes (one wallet per process), not by sharing one process.

---

## 2. HTTP API contract

The service binds to `${ARCHON_BIND_ADDRESS}:${ARCHON_KEYMASTER_PORT}`
(default `0.0.0.0:4226`). All API routes live under `/api/v1`. Two
non-versioned routes exist: `/metrics` (Prometheus) and an `/api/*`
catch-all for unhandled paths.

### 2.1 Response envelope

Most successful JSON responses are **objects whose top-level keys are part of
the contract**. In practice, the exact key is route-specific and clients rely
on the current `KeymasterClient` behavior. Examples:

| Endpoint | Response shape |
| --- | --- |
| `GET /api/v1/wallet` | `{ "wallet": WalletFile }` |
| `GET /api/v1/ids` | `{ "ids": string[] }` |
| `POST /api/v1/ids` | `{ "did": string }` |
| `PUT /api/v1/wallet` | `{ "ok": boolean }` |
| `GET /api/v1/registries` | `{ "registries": string[] }` |
| `POST /api/v1/login` | `{ "adminApiKey": string }` |
| `GET /api/v1/wallet/mnemonic` | `{ "mnemonic": string }` |
| `GET /api/v1/addresses/check/:address` | `AddressCheckResult` (flat object) |
| `POST /api/v1/lightning/invoice` | `LightningInvoice` (flat object) |

Many status-style operations use `{ "ok": boolean }`, and many create-style
operations return `{ "did": "..." }`, but there are shipped exceptions.
For example, `POST /api/v1/wallet/backup` currently returns the backup DID in
`ok`, and several Nostr / Lightning / address-check routes return flat
objects rather than a single nested payload key.

A new implementation MUST honor every key the existing
[`KeymasterClient`](../../../packages/keymaster/src/keymaster-client.ts)
parses (search the file for `response.data.<key>` to enumerate). The full
key inventory, including routes that return unwrapped objects, is the
contract.

### 2.2 Authentication

- `POST /api/v1/login` accepts `{ "passphrase": string }` and returns
  `{ "adminApiKey": string }`.
  - If `ARCHON_ENCRYPTED_PASSPHRASE` is unset, the server returns the
    configured admin API key (or empty string) without checking. This is
    development mode.
  - If set, the request passphrase MUST equal it; otherwise return HTTP 401
    `{ "error": "Incorrect passphrase" }`.
- All routes other than `/ready`, `/version`, `/login`, and `/metrics`
  require the `X-Archon-Admin-Key` header to match `ARCHON_ADMIN_API_KEY`.
- Header missing/wrong → HTTP 401 `{ "error": "Unauthorized — valid admin
  API key required" }` (note the em dash; matches the Gatekeeper wording).
- When `ARCHON_ADMIN_API_KEY` is empty, all routes are open
  (development mode). Implementations MUST log a warning at startup in
  this case.

The "admin key" is the only auth boundary. There is no per-user
authentication — the wallet itself is the identity vault, and possession
of the admin key implies full access to everything in it.

### 2.3 CORS

The service MUST emit permissive CORS (`Access-Control-Allow-Origin: *`,
`-Methods: *`, `-Headers: *`) and respond to preflight `OPTIONS`. This is
required for the React wallet, Explorer, and any browser-based tooling.

### 2.4 Body-size limits

JSON body bounded by Express's default unless overridden. Binary endpoints
(`/files`, `/images`, IPFS attachments) are bounded by
`ARCHON_KEYMASTER_UPLOAD_LIMIT` (default `10mb`). Limit string format is
the same as Gatekeeper's: `<digits>(b|kb|mb)?`, case-insensitive.

### 2.5 Route inventory

There are **146 routes** under `/api/v1`. Rather than list them all here,
they are grouped into the functional sections below; complete and
authoritative inventory:

```bash
grep -E "v1router\.(get|post|put|delete)\(" \
  services/keymaster/server/src/keymaster-api.ts
```

Each section below describes the contract for a route family
(method/path/body/response semantics). The OpenAPI export at
[docs/keymaster-api.json](../../keymaster-api.json) lists every route with
its swagger annotations.

---

## 3. Wallet model

The wallet is a **single passphrase-encrypted JSON document** stored in
the configured backend. Its in-memory (decrypted) shape:

```jsonc
{
  "version": 2,
  "seed": {
    "mnemonicEnc": {                           // the BIP39 mnemonic encrypted with the passphrase
      "salt": "<base64(16 bytes)>",
      "iv":   "<base64(12 bytes)>",
      "data": "<base64(ciphertext + AES-GCM tag)>"
    }
  },
  "counter": <int>,                            // monotonically incremented per createId
  "current": "<id name>" | undefined,          // currently selected ID
  "ids": {
    "<id name>": IDInfo,
    ...
  },
  "aliases": { "<alias>": "<DID>", ... }
}
```

`IDInfo`:

```jsonc
{
  "did": "did:cid:...",
  "account": <int>,                            // BIP44-style account index
  "index": <int>,                              // key index inside the account
  "owned":   ["<did>", ...],                   // assets created by this ID
  "held":    ["<did>", ...],                   // credentials accepted by this ID
  "addresses": { "<address>": StoredAddressInfo, ... },
  "nostr":     { "nsec": "<nsec...>", ... } | undefined,
  "dmail":     { ... } | undefined,
  "notices":   { ... } | undefined
}
```

### 3.1 At-rest encryption

The on-disk wallet is `WalletEncFile`:

```jsonc
{
  "version": <int>,
  "seed": { "mnemonicEnc": {...} },            // same as decrypted form
  "enc":  "<JWE Compact string of the rest of the wallet>"
}
```

The `enc` field is built by:

1. Decrypt `seed.mnemonicEnc` with the passphrase to get the BIP39 mnemonic.
2. Derive the BIP32 root HDKey from the mnemonic.
3. Generate a secp256k1 JWK pair from `hdkey.privateKey`.
4. Take everything in the wallet **except** `version` and `seed`, JSON-encode
   it, and call `cipher.encryptMessage(publicJwk, plaintext)` (see
   [§4.5](#45-jwe-envelope-encryption)).

To decrypt: derive the same JWK pair, JWE-decrypt `enc`, and merge the
result back with `version` and `seed`.

### 3.2 Passphrase encryption

`encryptWithPassphrase(plaintext, pass)` and the matching decrypt produce
`{ salt, iv, data }`:

- Random 16-byte salt
- Random 12-byte IV
- Key: `PBKDF2(SHA-512, passphrase, salt, c=100000, dkLen=32)`
  - `c` overridable via `PBKDF2_ITERATIONS` env var (decryption uses
    whatever `c` was used at encrypt time — there's no parameter stored)
  - **Implementations MUST use `c=100000` as the default** to interop with
    existing wallets
- Cipher: AES-256-GCM with the derived key and the random IV
- `data` is `ciphertext || tag` (16-byte tag appended, the AES-GCM
  default), base64-encoded (standard, with padding)
- All three fields encoded with **base64 standard alphabet, with `=`
  padding** (NOT base64url)

Implementation reference:
[packages/cipher/src/passphrase.ts](../../../packages/cipher/src/passphrase.ts).

### 3.3 Key derivation (BIP32 / BIP44-ish)

Each ID derives a private key from the wallet root using a derivation path
that the TypeScript implementation defines. New implementations MUST
match the path so that a wallet created by one can be loaded by another.

The current scheme:

- `account` = `IDInfo.account` (assigned to each ID at create time)
- `index` = `IDInfo.index`
- Derivation: BIP32 path `m/44'/0'/<account>'/0/<index>`
- Private key bytes feed `cipher.generateJwk(privateKey)` to produce the
  `{ publicJwk, privateJwk }` pair

The `counter` field on the wallet records how many IDs have been created
overall and supplies the next `account` value. Removing an ID does NOT
decrement the counter — account numbers are never reused.

### 3.4 Wallet operations

| Route | Behavior |
| --- | --- |
| `GET /api/v1/wallet` | Returns the **decrypted** wallet object. Requires server to hold the passphrase (via `ARCHON_ENCRYPTED_PASSPHRASE`). |
| `PUT /api/v1/wallet` | Body: `{ "wallet": WalletFile }`. Validates passphrase by decrypting or re-encrypting the submitted wallet and saves it. Returns `{ "ok": boolean }`. |
| `POST /api/v1/wallet/new` | Body: `{ "mnemonic"?: string, "overwrite"?: boolean }`. Generates a new mnemonic if not supplied. Returns `{ "wallet": WalletFile }`. |
| `POST /api/v1/wallet/backup` | Encrypts the wallet to a new backup asset DID, records that DID on the seed bank document (see §3.5), and returns `{ "ok": "<backup DID>" }`. |
| `POST /api/v1/wallet/recover` | Restores the wallet from the seed bank using the current passphrase. Returns `{ "wallet": WalletFile }`. |
| `POST /api/v1/wallet/check` | Walks every DID owned/held/aliased and verifies it resolves. Returns `{ "check": { checked, invalid, deleted } }`. |
| `POST /api/v1/wallet/fix` | Removes invalid/deleted entries identified by `check`. Returns `{ "fix": { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } }`. |
| `GET /api/v1/wallet/mnemonic` | Returns the decrypted BIP39 mnemonic as `{ "mnemonic": string }`. |
| `POST /api/v1/wallet/passphrase` | Body: `{ "passphrase": "<new>" }`. Re-encrypts `mnemonicEnc` and the wallet body with a new passphrase. Returns `{ "ok": boolean }`. |
| `GET /api/v1/export/wallet/encrypted` | Returns the on-disk `WalletEncFile` (no decryption). Useful for manual backup. |

### 3.5 Seed bank

The "seed bank" is a special DID that the wallet creates on first use to
back itself up. Operations:

- `wallet.backup` creates a **new** asset DID controlled by the seed-bank
  DID, containing the encrypted wallet body, then updates the seed-bank DID
  document data to point at that backup DID.
- `wallet.recover` uses the explicit `did` argument when provided; otherwise
  it resolves the seed-bank DID, reads the `wallet` pointer from that DID
  document's data, then decrypts the referenced backup asset.
- The seed-bank DID is derived from the wallet root key material and resolved
  on demand by the TypeScript implementation; it is not persisted as a
  separate field in the wallet JSON.

A new implementation MUST use the same anchor algorithm so a wallet
backed up by the TS implementation can be recovered by the new one.

### 3.6 Concurrency

All wallet writes MUST be serialized. The TypeScript reference uses an
async-promise lock (`AbstractBase.updateWallet`) to ensure a load-mutate-
save cycle is atomic. Implementations MAY use any equivalent mechanism
(file lock, mutex, optimistic concurrency with retry).

---

## 4. Cryptographic primitives

The Keymaster's cryptographic surface lives in
[packages/cipher/src/](../../../packages/cipher/src/). Reference
implementations:

- [cipher-base.ts](../../../packages/cipher/src/cipher-base.ts) — abstract
- [cipher-node.ts](../../../packages/cipher/src/cipher-node.ts) — Node
- [jwe.ts](../../../packages/cipher/src/jwe.ts) — JWE Compact
- [passphrase.ts](../../../packages/cipher/src/passphrase.ts) — wallet at-rest
- [concat-kdf.ts](../../../packages/cipher/src/concat-kdf.ts) — RFC 7518

### 4.1 BIP39 / BIP32

- Mnemonics: **BIP39** word lists, default English, 12 words minimum.
- Seed: BIP39 PBKDF2 → BIP32 root HDKey.
- Per-ID derivation as in [§3.3](#33-key-derivation-bip32--bip44-ish).

### 4.2 secp256k1 JWK

Per the [Gatekeeper spec §3.4](../gatekeeper/README.md#34-ecdsajwkpublic):

```jsonc
{ "kty": "EC", "crv": "secp256k1",
  "x": "<base64url(32-byte X)>",
  "y": "<base64url(32-byte Y)>",
  "d": "<base64url(32-byte private)>"          // only on private JWKs
}
```

Convert JWK → SEC1-compressed (33 bytes): prefix is `0x02` if the last
byte of Y is even, else `0x03`, followed by the 32-byte X.

### 4.3 Signing and verification

- ECDSA over SHA-256, fixed 64-byte (`r||s`) signature form, hex-encoded
  for over-the-wire transport in the legacy `signHash` API; base64url-
  encoded inside `Proof.proofValue` (see Gatekeeper spec §5).
- Schnorr (BIP340) is supported for **Nostr signing only** (`signSchnorr`,
  `signNostrEvent`). Output: 64-byte signature, hex-encoded.
- Verification follows the same encoding.

### 4.4 Canonical JSON

The Keymaster uses the same canonical-JSON algorithm as the Gatekeeper —
RFC 8785 JCS-equivalent. The TS implementation depends on the
[`canonicalize`](https://www.npmjs.com/package/canonicalize) npm package.
DID generation, `hashJSON`, and `Proof.proofValue` signing all share this
serialization. See [Gatekeeper spec §4.1](../gatekeeper/README.md#41-canonical-json).

### 4.5 JWE envelope encryption

Encrypted messages use **JWE Compact Serialization** with **ECDH-ES** key
agreement and **A256GCM** content encryption. Reference:
[packages/cipher/src/jwe.ts](../../../packages/cipher/src/jwe.ts).

To encrypt for `recipientPubKey`:

1. Generate ephemeral secp256k1 keypair.
2. Build header `{ alg: "ECDH-ES", enc: "A256GCM", epk: { kty, crv, x, y } }`,
   JSON-encode, base64url (the **protected header** `headerB64`).
3. Compute `sharedSecret = ECDH(ephemeral_priv, recipientPubKey)`.
4. Derive content encryption key (CEK):
   `cek = ConcatKDF(sharedSecret[1..], 256, "A256GCM")`
   (per RFC 7518 §4.6.2; for ECDH-ES direct, `algorithmId == enc`).
5. Generate random 96-bit IV.
6. AEAD-encrypt plaintext with AES-256-GCM, key=cek, iv=iv,
   AAD=`ascii(headerB64)`. Output is `ciphertext || tag` (16-byte tag).
7. Assemble JWE Compact:
   `headerB64 . "" . base64url(iv) . base64url(ciphertext) . base64url(tag)`
   — the encrypted-key segment is empty for ECDH-ES direct.

Decryption: parse the five segments, derive CEK from `epk` + recipient
private key + ConcatKDF, AEAD-decrypt with `cipher_text || tag` and AAD
= ASCII bytes of the protected header.

A legacy XChaCha20-Poly1305 path exists (`decryptMessageLegacy`) for
ciphertexts produced before the JWE migration. A conformant
implementation MAY skip this path if it doesn't need to read pre-JWE
messages from existing wallets.

### 4.6 Proof of work

`cipher.addProofOfWork(obj, difficulty)` finds a nonce such that
`sha256(canonical_json(obj_with_nonce))` has at least `difficulty` leading
zero bits. Used by some asset types (notably credentials) to deter spam.
Difficulty is 0–256 inclusive; 0 is a no-op.

---

## 5. Identity (ID) lifecycle

An "ID" is a named, BIP32-derived `agent` DID. The wallet keeps a
namespace of IDs; the `current` field selects which one is the "active"
identity for asset-creating operations that don't take an explicit owner.

| Route | Behavior |
| --- | --- |
| `GET /api/v1/ids` | `{ "ids": string[] }` — list of names, alphabetically. |
| `POST /api/v1/ids` | Body: `{ "name": string, "options"?: { "registry"?: string } }`. Derives a new keypair, creates an `agent` DID via Gatekeeper, stores `IDInfo`. Returns `{ "did": string }`. Increments `counter`. Sets `current` if the wallet had none. |
| `GET /api/v1/ids/:id` | Resolves the supplied ID name or DID through the same lookup path as `GET /api/v1/did/:id` and returns `{ "docs": DidCidDocument }`. |
| `DELETE /api/v1/ids/:id` | Removes the ID from the wallet (does NOT deactivate the DID on the gatekeeper). Returns `{ "ok": boolean }`. |
| `POST /api/v1/ids/:id/rename` | Body: `{ "name": string }`. Returns `{ "ok": boolean }`. |
| `POST /api/v1/ids/:id/change-registry` | Body: `{ "registry": string }`. Submits an `update` op moving the DID to the new registry. Returns `{ "ok": boolean }`. |
| `POST /api/v1/ids/:id/backup` | Anchors a JWE backup of the ID's owned-asset list to its DID document. Returns `{ "ok": boolean }`. |
| `POST /api/v1/ids/:id/recover` | Body: `{ "did": string }`. Decrypts and re-imports an ID backup. Returns `{ "recovered": string }` (the ID name). |
| `GET /api/v1/ids/current` | `{ "current": string | undefined }` |
| `PUT /api/v1/ids/current` | Body: `{ "name": string }`. Sets the active ID. Returns `{ "ok": boolean }`. |

Resolution endpoints proxied through to Gatekeeper:

| Route | Behavior |
| --- | --- |
| `GET /api/v1/did/:id` | Body-less; query params match Gatekeeper's `/did/:did` (`versionTime`, `versionSequence`, `confirm`, `verify`). Accepts a DID **or** a wallet alias / ID name; resolves the alias first, then forwards to Gatekeeper. Returns `{ "docs": DidCidDocument }`. |
| `PUT /api/v1/did/:id` | Body: `{ "doc": DidCidDocument }`. Submits an `update` operation signing it with the ID's key. Returns `{ "ok": boolean }`. |
| `DELETE /api/v1/did/:id` | Submits a `delete` operation. Returns `{ "ok": boolean }`. |

The `:id` parameter accepts (in this lookup order): wallet alias name, ID
name, raw DID. Implementations MUST resolve aliases/names BEFORE
calling the Gatekeeper.

### 5.1 Operation signing

For every DID write (`createId`, asset create, asset update, asset
delete), the Keymaster:

1. Builds the unsigned `Operation` (per Gatekeeper spec §3.1).
2. Removes any existing `proof` field (defensive).
3. Computes `msgHash = sha256(canonicalize(op_without_proof))`.
4. Signs with the ID's private key: `sig = ECDSA(secp256k1, priv, msgHash)`.
5. Builds the `proof` object (Gatekeeper spec §3.2):
   - `type = "EcdsaSecp256k1Signature2019"`
   - `created = now() in RFC 3339`
   - `verificationMethod` per Gatekeeper §5.3 (relative `#key-1` for agent
     create, otherwise `<signerDid>#key-1`)
   - `proofPurpose = "authentication"` for the current TypeScript DID and
     asset write paths (`create`, `update`, `delete`)
   - `proofValue = base64url(sig)`
6. Submits via `gatekeeper.createDID(op)` / `updateDID(op)`.

---

## 6. Aliases and addresses

### 6.1 Aliases

An alias is a wallet-local short name for a DID. Aliases are not visible
to the Gatekeeper or to other peers.

| Route | Behavior |
| --- | --- |
| `GET /api/v1/aliases` | `{ "aliases": { "<alias>": "<DID>", ... } }` |
| `POST /api/v1/aliases` | Body: `{ "alias": string, "did": string }`. Returns `{ "ok": boolean }`. |
| `GET /api/v1/aliases/:alias` | `{ "did": string }` or 404. |
| `DELETE /api/v1/aliases/:alias` | `{ "ok": boolean }`. |

Alias names: max length `maxAliasLength` (default 32 chars). Character set
not enforced; clients SHOULD use ASCII identifiers.

### 6.2 Addresses (LUD-16)

An "address" is an external `name@domain` Lightning address (LUD-16) that
the wallet has chosen to track for sending zaps.

| Route | Behavior |
| --- | --- |
| `GET /api/v1/addresses` | `{ "addresses": { "<address>": StoredAddressInfo, ... } }` |
| `GET /api/v1/addresses/:domain` | Returns the **locally stored** current-ID address record for the supplied domain, or `{ "address": null }` if none is stored. It does not resolve LNURL or remote DID anchors. |
| `POST /api/v1/addresses/import` | Fetches `https://<domain>/.well-known/names`, imports any names that already point at the current ID's DID, and returns `{ "addresses": Record<string, AddressInfo> }`. |
| `GET /api/v1/addresses/check/:address` | Probes whether the address is `claimed`/`available`/`unsupported`/`unreachable`. Returns a flat `AddressCheckResult` object: `{ "address": string, "status": ..., "available": boolean, "did": string | null }`. |
| `POST /api/v1/addresses` | Body: `{ "address": string }`. Adds the address to the current ID. |
| `DELETE /api/v1/addresses/:address` | Removes the address. |

---

## 7. Asset lifecycle

An "asset" is any DID owned by an agent that is not an agent itself. The
DID type is `asset`, the controller is the owner agent, and the body of
the DID document carries the asset payload.

| Route | Behavior |
| --- | --- |
| `POST /api/v1/assets` | Body: `{ "data": <any JSON>, "options"?: CreateAssetOptions }`. Creates an asset DID owned by the current ID. Returns `{ "did": string }`. |
| `GET /api/v1/assets` | `{ "assets": string[] }` — DIDs the current ID owns. |
| `GET /api/v1/assets/:id` | Resolves the asset; returns `{ "asset": <didDocumentData> }`. |
| `PUT /api/v1/assets/:id` | Body: `{ "data": <JSON> }`. Submits an `update` op replacing the asset data. |
| `POST /api/v1/assets/:id/transfer` | Body: `{ "controller": "<DID>" }`. Reassigns ownership; the previous owner can no longer mutate the asset. |
| `POST /api/v1/assets/:id/clone` | Creates a new asset DID with the same data, owned by the current ID. |

`CreateAssetOptions`:

```jsonc
{
  "registry": "local" | "hyperswarm" | "BTC:..." | undefined,  // defaults to wallet defaultRegistry
  "controller": "<DID>" | undefined,                            // defaults to current ID
  "validUntil": "<RFC 3339>" | undefined,                       // ephemeral expiry
  "alias": string | undefined                                   // also add this alias
}
```

Asset data MUST be valid JSON. The TS implementation enforces a
`maxDataLength` of 8 KB on the JSON-stringified form.

### 7.1 Owned-list bookkeeping

When an ID creates an asset, its `IDInfo.owned[]` array is appended with
the new DID. When an asset is transferred, the previous owner's `owned[]`
loses the DID and the new owner's `owned[]` gains it (only for IDs in
this wallet — transfers to external DIDs leave the local list shrunk).

`wallet.check` and `wallet.fix` rebuild this bookkeeping by walking every
DID in `owned` and verifying it still resolves with the right controller.

---

## 8. Encryption envelope

The Keymaster's encrypt/decrypt routes are thin wrappers around JWE
([§4.5](#45-jwe-envelope-encryption)) that store the ciphertext as an
asset DID owned by the sender:

| Route | Behavior |
| --- | --- |
| `POST /api/v1/keys/encrypt/message` | Body: `{ "msg": string, "receiver": "<DID>", "options"?: EncryptOptions }`. Resolves the receiver, JWE-encrypts the UTF-8 message bytes to the receiver's `verificationMethod[0].publicKeyJwk`, creates an asset DID containing the ciphertext envelope, returns `{ "did": string }`. |
| `POST /api/v1/keys/decrypt/message` | Body: `{ "did": string }`. Resolves the asset, locates the receiver's private key in the wallet, decrypts the JWE, returns `{ "message": string }`. |
| `POST /api/v1/keys/encrypt/json` | Same as `encrypt/message` but `JSON.stringify`s the input first. |
| `POST /api/v1/keys/decrypt/json` | Same as `decrypt/message` but `JSON.parse`s the result. |
| `POST /api/v1/keys/sign` | Body: `{ "contents": "<JSON string>" }`. The server parses `contents`, canonicalizes the resulting JSON value, signs it with the current ID's key, and returns `{ "signed": <input with .proof> }`. |
| `POST /api/v1/keys/verify` | Body: `{ "json": <signed JSON> }`. Verifies `json.proof.proofValue`. Returns `{ "ok": boolean }`. |
| `POST /api/v1/keys/rotate` | Generates a new keypair for the current ID, submits an `update` op replacing the verification method. |

`EncryptOptions` extends `CreateAssetOptions`:

```jsonc
{
  // CreateAssetOptions fields plus:
  "encryptForSender": true | false | undefined,   // encrypt twice so sender can re-read later
  "includeHash":      true | false | undefined    // record sha256(plaintext) on the envelope
}
```

The on-asset envelope shape (`didDocumentData`):

```jsonc
{
  "encrypted": {
    "sender":          "<DID>",
    "created":         "<RFC 3339>",
    "cipher_hash":     "<hex>" | null,            // present iff includeHash
    "cipher_sender":   "<JWE>" | null,            // present iff encryptForSender
    "cipher_receiver": "<JWE>"
  }
}
```

`decryptMessage` tries `cipher_receiver` first (current ID is receiver),
falling back to `cipher_sender` (current ID is sender re-reading own
message).

---

## 9. Credentials and challenges

W3C-compliant verifiable credentials, encoded as W3C VC v2 JSON.

```jsonc
VerifiableCredential = {
  "@context": ["https://www.w3.org/ns/credentials/v2", ...],
  "type": ["VerifiableCredential", ...],
  "issuer": "<DID>",
  "validFrom":  "<RFC 3339>",
  "validUntil": "<RFC 3339>" | undefined,
  "credentialSchema": { "id": "<schema DID>", "type": "JsonSchema" },
  "credentialSubject": { "id": "<DID>", ...claims },
  "proof": Proof
}
```

### 9.1 Issuing flow

1. `POST /api/v1/credentials/bind` — `{ "subject": DID, "options"?: { schema, validFrom, validUntil, claims, types } }` → returns the `{ "credential": <unsigned VC> }`.
2. `POST /api/v1/credentials/issued` — `{ "credential": <VC>, "options"?: IssueCredentialsOptions }` → signs (via the issuer ID's key into `proof`), encrypts to the subject (JWE), creates an asset DID, returns `{ "did": string }`.
3. `POST /api/v1/credentials/issued/:did/send` — emits a notice to the subject (see [§11](#11-files-images-dmail-notices)).
4. Subject calls `POST /api/v1/credentials/held` to "accept" — decrypts the JWE, stores DID in `IDInfo.held[]`.

### 9.2 Held / Issued endpoints

| Route | Behavior |
| --- | --- |
| `GET /api/v1/credentials/held` | `{ "held": string[] }` of accepted credential DIDs. |
| `POST /api/v1/credentials/held` | Body: `{ "did": string }`. Accepts/imports a credential. |
| `GET /api/v1/credentials/held/:did` | `{ "credential": VerifiableCredential }`. |
| `DELETE /api/v1/credentials/held/:did` | Removes from `held[]` (does not revoke). |
| `POST /api/v1/credentials/held/:did/publish` | Body: `{ "options"?: { reveal?: boolean } }`. Anchors a stripped (or full, if `reveal=true`) credential onto the holder's DID document. |
| `POST /api/v1/credentials/held/:did/unpublish` | Removes a published credential from the holder's DID document. |
| `GET /api/v1/credentials/issued` | `{ "issued": string[] }` of credentials the current ID has issued. |
| `POST /api/v1/credentials/issued` | Issue (see above). |
| `GET /api/v1/credentials/issued/:did` | `{ "credential": VerifiableCredential }`. |
| `POST /api/v1/credentials/issued/:did` | Body: `{ "credential": VC }`. Update an in-flight issued credential (e.g. rotate claims). |
| `POST /api/v1/credentials/issued/:did/send` | Send/notify the subject. |
| `DELETE /api/v1/credentials/issued/:did` | Revoke (deactivates the asset DID). |

### 9.3 Challenges and responses

A "challenge" is a JSON spec from a verifier asking the holder to present
specific credentials (by schema and optionally by issuer). The
verifier-prover protocol:

| Route | Behavior |
| --- | --- |
| `GET /api/v1/challenge` | Creates a challenge asset using default parameters and returns `{ "did": string }`. There is no separate template-returning HTTP route in the current TS server. |
| `POST /api/v1/challenge` | Body: `{ "challenge"?: Challenge, "options"?: { registry?, validUntil? } }`. Persists the challenge as an asset DID and returns `{ "did": string }`. |
| `POST /api/v1/response` | Body: `{ "challenge": string, "options"?: CreateResponseOptions }`. Holder gathers matching held credentials, builds a `ChallengeResponse`, encrypts to the challenger, and creates a response asset. Returns `{ "did": string }`. |
| `POST /api/v1/response/verify` | Body: `{ "response": string, "options"?: { retries?, delay? } }`. Verifier decrypts, validates each presented VC's signature against its issuer's key, and returns `{ "verify": ChallengeResponse }`. |

`Challenge`:

```jsonc
{
  "credentials": [
    { "schema": "<schema DID>", "issuers"?: ["<DID>", ...] }
  ]
}
```

`ChallengeResponse`:

```jsonc
{
  "challenge": "<challenge DID>",
  "credentials": [{ "vc": "<DID of the VC>", "vp": "<DID of the VP envelope>" }],
  "requested": <int>,
  "fulfilled": <int>,
  "match":     <bool>,
  "vps":       <unknown[]>,                     // verified-presentation payloads
  "responder": "<DID>"
}
```

---

## 10. Groups, schemas, polls, vaults

Each of these is a typed asset whose `didDocumentData` follows a specific
shape.

### 10.1 Groups

```jsonc
{ "version": 2, "members": ["<DID>", ...] }
```

| Route | Behavior |
| --- | --- |
| `POST /api/v1/groups` | `{ "name": string, "options"?: CreateAssetOptions }` → `{ "did": string }`. |
| `GET /api/v1/groups` | `{ "groups": string[] }`. |
| `GET /api/v1/groups/:name` | `{ "group": Group }`. |
| `POST /api/v1/groups/:name/add` | `{ "member": string }` → `{ "ok": boolean }`. |
| `POST /api/v1/groups/:name/remove` | `{ "member": string }` → `{ "ok": boolean }`. |
| `POST /api/v1/groups/:name/test` | `{ "member"?: string }`. Returns `{ "test": boolean }` indicating membership (or whether it is a valid group). |

### 10.2 Schemas

A schema is a JSON Schema document used as a credential template.

| Route | Behavior |
| --- | --- |
| `POST /api/v1/schemas` | `{ "schema"?: <JSON>, "options"?: CreateAssetOptions }` → `{ "did": string }`. |
| `GET /api/v1/schemas` | `{ "schemas": string[] }`. |
| `GET /api/v1/schemas/:id` | `{ "schema": <JSON> }`. |
| `PUT /api/v1/schemas/:id` | `{ "schema": <JSON> }` → `{ "ok": boolean }`. |
| `POST /api/v1/schemas/:id/test` | Returns `{ "test": boolean }`. |
| `POST /api/v1/schemas/:id/template` | Returns `{ "template": <JSON> }` — an empty instance matching the schema. |

### 10.3 Polls

```jsonc
PollConfig = {
  "version": 2,
  "name":        string,
  "description": string,
  "options":     string[],
  "deadline":    "<RFC 3339>"
}
```

A poll is owned by a creator, scoped to a voter group, and produces
ballots which are sealed Vault items revealed after the deadline.

16 routes covering create / view / vote / send / publish / voter management.
See the route list at the top of this document and the
[KeymasterInterface](../../../packages/keymaster/src/types.ts#L361) for
exact method signatures. The data shape on the poll asset:

```jsonc
{
  "poll": PollConfig,
  "voters": "<group DID>",
  "ballots": ["<ballot DID>", ...],
  "vault":  "<vault DID>"          // sealed ballot box
}
```

### 10.4 Vaults

A vault is an end-to-end-encrypted shared key-value store with multi-member
access. Access control uses per-member ECDH-ES key wrapping.

```jsonc
Vault = {
  "version": <int>,
  "publicJwk": EcdsaJwkPublic,                   // vault's owning public key
  "salt":      "<base64>",
  "config":    "<JWE>",                          // encrypted metadata
  "members":   "<JWE>",                          // encrypted member list
  "keys":      { "<memberDid>": "<JWE-wrapped CEK>" },
  "items":     "<JWE>",                          // encrypted item map
  "sha256":    "<hex>"                           // tamper detection
}
```

| Route | Behavior |
| --- | --- |
| `POST /api/v1/vaults` | `{ "options"?: VaultOptions }` → `{ "did": string }`. |
| `GET /api/v1/vaults/:id` | `{ "vault": Vault }`. |
| `POST /api/v1/vaults/:id/test` | Membership / sanity test. |
| `POST /api/v1/vaults/:id/members` | Add member. |
| `DELETE /api/v1/vaults/:id/members/:member` | Remove member. |
| `GET /api/v1/vaults/:id/members` | `{ "members": string[] }`. |
| `POST /api/v1/vaults/:id/items` | Body: `{ "name": string, "buffer": "<base64>" }`. |
| `DELETE /api/v1/vaults/:id/items/:name` | |
| `GET /api/v1/vaults/:id/items` | `{ "items": Record<string, ...> }`. |
| `GET /api/v1/vaults/:id/items/:name` | Returns the binary item (decrypted). |

---

## 11. Files, images, dmail, notices

### 11.1 Files

Binary blobs stored on IPFS via the Gatekeeper, with metadata wrapped as
an asset DID.

| Route | Behavior |
| --- | --- |
| `POST /api/v1/files` | Body: `application/octet-stream` (up to `ARCHON_KEYMASTER_UPLOAD_LIMIT`); query/headers carry `filename`, `contentType`, `bytes`. Pushes bytes to Gatekeeper `/ipfs/data`, creates asset, returns `{ "did": string }`. |
| `PUT /api/v1/files/:id` | Replace the file under the same DID. |
| `GET /api/v1/files/:id` | `{ "file": FileAsset }` (metadata + base64 of bytes). |
| `POST /api/v1/files/:id/test` | Sanity check. |

### 11.2 Images

Same as files but with image-specific metadata (`width`, `height`).

### 11.3 IPFS passthrough

| Route | Behavior |
| --- | --- |
| `GET /api/v1/ipfs/data/:cid` | Streams the raw bytes from Gatekeeper's IPFS proxy. The Keymaster does NOT expose JSON / text / stream IPFS endpoints — only this byte-level read for clients that already have a CID. |

### 11.4 Dmail (decentralized mail)

Encrypted DM with optional file attachments.

| Route | Behavior |
| --- | --- |
| `POST /api/v1/dmail` | `{ "message": DmailMessage, "options"?: CreateAssetOptions }` → `{ "did": string }`. Creates the asset; does NOT send (no notice yet). |
| `PUT /api/v1/dmail/:id` | Update message content. |
| `DELETE /api/v1/dmail/:id` | Remove from local index. |
| `POST /api/v1/dmail/:id/send` | Notifies recipients (creates notice asset DIDs). |
| `POST /api/v1/dmail/:id/file` | File the message under tags. Body: `{ "tags": string[] }`. |
| `POST /api/v1/dmail/import` | `{ "did": string }` — import a dmail received via notice. |
| `GET /api/v1/dmail` | `{ "dmail": Record<DID, DmailItem> }`. |
| `GET /api/v1/dmail/:id` | `{ "message": DmailMessage }`. |
| `GET /api/v1/dmail/:id/attachments` | `{ "attachments": Record<string, ...> }`. |
| `POST /api/v1/dmail/:id/attachments` | Add an attachment (binary body, `name` query). |
| `DELETE /api/v1/dmail/:id/attachments/:name` | |
| `GET /api/v1/dmail/:id/attachments/:name` | Returns the binary attachment. |

### 11.5 Notices

A notice is a small asset DID created by one ID and delivered to one or
more recipients. It points at a payload DID (a credential, dmail, etc.).

```jsonc
NoticeMessage = { "to": ["<DID>", ...], "dids": ["<DID>", ...] }
```

| Route | Behavior |
| --- | --- |
| `POST /api/v1/notices` | `{ "message": NoticeMessage, "options": CreateAssetOptions }` → `{ "did": string }`. |
| `PUT /api/v1/notices/:id` | Update notice content. |
| `POST /api/v1/notices/refresh` | Walk each ID's address book and discover/import any new notices addressed to it. Returns `{ "ok": boolean }`. |

---

## 12. Nostr and Lightning passthrough

### 12.1 Nostr

The wallet can host a Nostr identity for each ID (one nsec per ID,
derived from the same secp256k1 key as the DID).

| Route | Behavior |
| --- | --- |
| `POST /api/v1/nostr` | Body: `{ "id"?: string }`. Generates Nostr keys for the named ID (or current). Returns `{ "nostr": NostrKeys }` (`{ npub, pubkey }`). |
| `DELETE /api/v1/nostr` | Removes Nostr keys from the ID. |
| `POST /api/v1/nostr/import` | Body: `{ "nsec": string, "id"?: string }`. Imports an externally-generated nsec. |
| `POST /api/v1/nostr/nsec` | Body: `{ "id"?: string }`. Returns `{ "nsec": string }` (export). |
| `POST /api/v1/nostr/sign` | Body: `{ "event": NostrEvent, "id"?: string }`. Signs the event (Schnorr / BIP340) and returns `{ "event": NostrEvent }` with `id`/`pubkey`/`sig` populated. |

`NostrKeys = { npub: <bech32>, pubkey: <hex> }`.
`nsec` is a `bech32`-encoded 32-byte private key with prefix `nsec`.

### 12.2 Lightning

Lightning routes are passthrough: the Keymaster forwards them to the
Drawbridge service, which holds the actual LNbits credentials. The
Drawbridge URL is implicit in the gatekeeper client (it is implemented
as an extension of the gatekeeper client); a compliant Keymaster MUST
reach Lightning functionality via the same `DrawbridgeClient`.

| Route | Behavior |
| --- | --- |
| `POST /api/v1/lightning` | `{ "id"?: string }`. Provisions an LNbits wallet for the ID, stores `LightningConfig` in `IDInfo`. |
| `DELETE /api/v1/lightning` | Decommissions the Lightning wallet. |
| `POST /api/v1/lightning/balance` | `{ "balance": LightningBalance }`. |
| `POST /api/v1/lightning/invoice` | `{ "amount": number, "memo": string, "id"?: string }` → `{ "invoice": LightningInvoice }`. |
| `POST /api/v1/lightning/pay` | `{ "bolt11": string, "id"?: string }` → `{ "payment": LightningPayment }`. |
| `POST /api/v1/lightning/payment` | `{ "paymentHash": string, "id"?: string }` → `{ "status": LightningPaymentStatus }`. |
| `POST /api/v1/lightning/decode` | `{ "bolt11": string }` → `{ "decoded": DecodedLightningInvoice }`. |
| `POST /api/v1/lightning/publish` | Publishes the ID's invoice key to its DID document (so others can zap by DID). |
| `POST /api/v1/lightning/unpublish` | |
| `POST /api/v1/lightning/zap` | `{ "id": string, "amount": number, "memo"?: string, "name"?: string }`. Resolves recipient (DID, alias, or LUD-16) and pays. |
| `POST /api/v1/lightning/payments` | `{ "payments": LightningPaymentRecord[] }`. |

---

## 13. Storage backends

Reference implementations: **JSON file** (default), **SQLite**, **Redis**,
**MongoDB**. Selector: `ARCHON_KEYMASTER_DB ∈ { json, sqlite, redis, mongodb }`.

A storage backend implements:

```ts
interface WalletBase {
  saveWallet(wallet: StoredWallet, overwrite?: boolean): Promise<boolean>;
  loadWallet(): Promise<StoredWallet | null>;
  updateWallet(mutator: (wallet: StoredWallet) => void): Promise<void>;
}
```

`updateWallet` MUST be atomic and serialize concurrent callers.
Implementations MAY also wrap the chosen backend in a write-through
in-memory `WalletCache` (enabled via `ARCHON_WALLET_CACHE=true`) to avoid
re-reading the entire wallet on every request.

### 13.1 Filesystem layout

| Backend | Path |
| --- | --- |
| `json` | `${dataFolder}/wallet.json` (default `data/wallet.json`) |
| `sqlite` | `${dataFolder}/wallet.db` |

The container mounts `./data` at `/app/keymaster/data`.

### 13.2 Wire shape

The stored payload is **always** the JSON-serialized `WalletEncFile`
(see [§3.1](#31-at-rest-encryption)). Backends that store rows/documents
use the wallet's `version` as a discriminator; everything else is opaque
JSON to the storage layer.

---

## 14. Prometheus metrics contract

Exposed at `GET /metrics`.

| Metric | Type | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram (buckets: 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5) | `method`, `route`, `status` |
| `wallet_operations_total` | counter | `operation`, `status` |
| `service_version_info` | gauge | `version`, `commit` |

Plus Prometheus default process metrics (`process_resident_memory_bytes`,
`process_start_time_seconds`, etc.) — implementations SHOULD emit them so
the existing Grafana dashboards keep working.

### 14.1 Route normalization

The `route` label collapses dynamic segments. Required:

```
/did/<id>          -> /did/:id
/ids/<id>          -> /ids/:id
/aliases/<alias>   -> /aliases/:alias
/addresses/check/<x>     -> /addresses/check/:address
/addresses/<x>     -> /addresses/:address
/groups/<name>     -> /groups/:name
/schemas/<id>      -> /schemas/:id
/agents/<id>       -> /agents/:id
/credentials/held/<did>   -> /credentials/held/:did
/credentials/issued/<did> -> /credentials/issued/:did
/assets/<id>       -> /assets/:id
/polls/<p>/voters/<v>     -> /polls/:poll/voters/:voter
/polls/ballot/<did>       -> /polls/ballot/:did
/polls/<p>         -> /polls/:poll
/images/<id>       -> /images/:id
/files/<id>        -> /files/:id
/ipfs/data/<cid>   -> /ipfs/data/:cid
/vaults/<id>/members/<m>  -> /vaults/:id/members/:member
/vaults/<id>/items/<n>    -> /vaults/:id/items/:name
/vaults/<id>       -> /vaults/:id
/dmail/<id>/attachments/<n>  -> /dmail/:id/attachments/:name
/dmail/<id>        -> /dmail/:id
/notices/<id>      -> /notices/:id
```

Unlike the Gatekeeper, the Keymaster TS implementation passes
**`req.path`** to the metric label, which **does not** include the
`/api/v1` prefix in the current version. A new implementation SHOULD
match this for backward compatibility with existing dashboards. (If you
add the `/api/v1` prefix, audit dashboard queries first.)

### 14.2 `wallet_operations_total`

Incremented by the implementation on key wallet-mutation paths
(`createId`, `removeId`, etc.) with `status: "success" | "error"`. The TS
implementation increments this on `createId` only at present; new
implementations MAY cover more operations but MUST NOT remove existing
labels.

---

## 15. Container and runtime contract

### 15.1 Image

- Container exposes port `4226` by default.
- Mounts `./data` at `/app/keymaster/data` (set `ARCHON_DATA_DIR` to
  override).
- `GIT_COMMIT` build arg / env populates the `service_version_info` commit
  label and `/version`. Truncated to 7 chars.

### 15.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_KEYMASTER_PORT` | `4226` | HTTP listen port. |
| `ARCHON_BIND_ADDRESS` | `0.0.0.0` | HTTP bind address. |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Gatekeeper base URL. |
| `ARCHON_NODE_ID` | empty | Required. Name of the canonical agent ID this server provisions on startup. |
| `ARCHON_KEYMASTER_DB` | `json` | Storage backend (`json`, `sqlite`, `redis`, `mongodb`). |
| `ARCHON_ENCRYPTED_PASSPHRASE` | empty | Wallet passphrase. Empty enables `/login` dev mode (returns admin key without checking). |
| `ARCHON_WALLET_CACHE` | `false` | Enables the in-memory write-through cache. |
| `ARCHON_DEFAULT_REGISTRY` | unset (uses `hyperswarm` in code) | Default registry for created DIDs. |
| `ARCHON_KEYMASTER_UPLOAD_LIMIT` | `10mb` | Body cap for `/files`, `/images`, dmail attachments. |
| `ARCHON_ADMIN_API_KEY` | empty | Admin auth header value. |
| `GIT_COMMIT` | `unknown` | Build commit. |
| `PBKDF2_ITERATIONS` | `100000` | Override PBKDF2 cost for `encryptWithPassphrase`. **Implementations MUST keep `100000` as the default to interop with existing wallets.** |

### 15.3 Startup sequence

1. Bind HTTP listener.
2. Connect to Gatekeeper (`waitUntilReady=true`, polling every 5s).
3. Initialize the wallet backend.
4. Construct the in-process Keymaster with the wallet, Gatekeeper client,
   and cipher implementation.
5. Run `waitForNodeId()`:
   - `ARCHON_NODE_ID` MUST be set.
   - If the wallet doesn't have an ID with that name, create one
     (`keymaster.createId(ARCHON_NODE_ID)`).
   - Loop until the new ID resolves on the Gatekeeper (10s between polls).
6. Mark `serverReady = true`.

`/api/v1/ready` returns `{ "ready": serverReady }` and MUST return
`{ "ready": false }` until the node ID resolves.

### 15.4 Healthcheck

```
test "$(wget -qO- http://127.0.0.1:4226/api/v1/ready | jq -r .ready)" = "true"
```

(The TS implementation lets the `/ready` body be `{ "ready": true }`
JSON. A simple `grep` for `"ready":true` is also acceptable.)

### 15.5 Graceful shutdown

On `SIGTERM` / `SIGINT`, stop accepting connections, drain in-flight
requests, close the wallet backend, exit. The TS reference uses
`server.close()` then `process.exit(0)`.

---

## 16. Error responses and logging

### 16.1 Error envelope

- 4xx/5xx caught errors return JSON `{ "error": "<message>" }` with the
  appropriate status code. Some legacy paths return `text/plain`
  `Error: <message>` — new implementations SHOULD prefer JSON but MUST
  accept either when consuming responses.
- The unhandled-route fallback (`/api/*`) returns HTTP 404
  `{ "message": "Endpoint not found" }`.

### 16.2 Common errors

| Status | Error string | Meaning |
| --- | --- | --- |
| 401 | `Incorrect passphrase` | `/login` body's passphrase didn't match. |
| 401 | `Unauthorized — valid admin API key required` | Missing/wrong `X-Archon-Admin-Key`. |
| 404 | `DID not found` | Resolution miss. |
| 500 | `Incorrect passphrase.` | `decryptWalletFromStorage` couldn't decrypt with the configured passphrase. (Note: trailing period; Keymaster wraps the cipher error.) |
| 500 | `<thrown error toString>` | Unhandled exception. |

### 16.3 Logging

- One line per HTTP request: morgan's "dev" format
  (`METHOD path status duration-ms - content-length`).
- Errors during wallet save / passphrase decrypt SHOULD log `console.error`
  before the response is sent.
- Startup banner: `Keymaster server v<version> (<commit>) running on
  <addr>:<port>`, `Keymaster server persisting to <db>`, plus the admin-key
  warning if unset.

---

## 17. Test fixtures and reference implementation

### 17.1 Reference

- TypeScript service: [services/keymaster/server/](../../../services/keymaster/server/)
- TypeScript SDK: [packages/keymaster/](../../../packages/keymaster/)
- Cipher primitives: [packages/cipher/](../../../packages/cipher/)
- Image: `ghcr.io/archetech/keymaster`
- HTTP client (any language can mirror this surface):
  [packages/keymaster/src/keymaster-client.ts](../../../packages/keymaster/src/keymaster-client.ts)
- Python SDK (parity-tested): [python/keymaster_sdk/](../../../python/keymaster_sdk/)

### 17.2 Conformance tests

| Suite | What it covers |
| --- | --- |
| [tests/keymaster/](../../../tests/keymaster/) | Jest unit tests of the in-process Keymaster class. Many of them mock the Gatekeeper client with `nock` and exercise the full wallet/DID flows. |
| [tests/cli/](../../../tests/cli/) | End-to-end CLI tests that shell into a running CLI container and round-trip through Keymaster → Gatekeeper. Run on every PR by [`docker-build-test.yml`](../../../.github/workflows/docker-build-test.yml). |
| [python/keymaster_sdk/tests/](../../../python/keymaster_sdk/tests/) | Python SDK integration tests against a running Keymaster (via [`python-sdk-tests.yml`](../../../.github/workflows/python-sdk-tests.yml)). A new HTTP-compatible Keymaster MUST pass these. |

### 17.3 Adding a third implementation

Recommended order:

1. **Wallet at-rest format first.** Implement `encryptWithPassphrase`
   and the JWE envelope (§3.1, §3.2, §4.5) and prove you can read a
   `WalletEncFile` produced by the TS implementation.
2. **Crypto primitives next.** Build secp256k1 sign / verify, JWK
   conversion, BIP39, and BIP32 derivation. Verify against the
   `tests/keymaster/` fixtures and the
   [`tests/gatekeeper/proof-vectors.json`](../../../tests/gatekeeper/proof-vectors.json)
   shared with the Gatekeeper.
3. **Wallet backend.** Implement at least the JSON file backend; SQLite,
   Redis, Mongo are optional.
4. **HTTP routes.** Stand up an HTTP server with the
   [§2 contract](#2-http-api-contract) and the route-by-route semantics
   in §5–§12. Use the OpenAPI export at
   [docs/keymaster-api.json](../../keymaster-api.json) as a checklist.
5. **CI.** Add a docker compose flavor and a matrix entry in
   [`docker-build-test.yml`](../../../.github/workflows/docker-build-test.yml)
   so the 27-test CLI suite runs against your image on every PR. (Same
   pattern the Rust Gatekeeper port uses; see
   [docs/services/gatekeeper/README.md §17](../gatekeeper/README.md#17-reference-implementations).)

A new implementation is considered drop-in when it can be substituted into
`docker-compose.yml` and the CLI test suite passes against it.
