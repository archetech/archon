# DIDComm — Phase 0 spike

Throwaway spike for the [DIDComm design doc](../../docs/didcomm-design.md). It
de-risks the build-vs-buy and curve decisions by packing/unpacking real DIDComm
v2 envelopes between two Archon-shaped DIDs using the
[`didcomm-node`](https://www.npmjs.com/package/didcomm-node) library through the
two adapter interfaces (`DIDResolver`, `SecretsResolver`) that later phases will
back with the gatekeeper and the wallet.

This is **not** wired into the monorepo (root `workspaces` is only `packages/*`)
— it is a standalone, self-contained project.

## Run

```sh
cd spike/didcomm-phase0
npm ci          # installs didcomm-node@0.4.1 (WASM, Node target)
node spike.mjs
```

Expected output: three `PASS` lines (anoncrypt, authcrypt, authcrypt+sign).

## What it does

- Generates X25519 key-agreement keys (Alice + Bob) and a **secp256k1** signing
  key for Alice, via Node's built-in `crypto` exported as JWK.
- Builds Archon-shaped (normalized) DID documents — `{ id, keyAgreement[],
  authentication[], verificationMethod[] (publicKeyJwk), service[] }` with a
  `DIDCommMessaging` service — served from an in-memory `DIDResolver`.
- Exposes the private keys via an in-memory `SecretsResolver`
  (`get_secret` / `find_secrets`, keyed by full DID-fragment kids).
- Runs three pack→unpack round-trips and asserts the plaintext + metadata.

## Findings

| Test | Result | Algorithm selected by the library |
|---|---|---|
| anoncrypt (anonymous sender) | PASS | `XC20P` + `ECDH-ES+A256KW` over X25519 |
| authcrypt (authenticated sender) | PASS | `A256CBC-HS512` + `ECDH-1PU+A256KW` over X25519 |
| authcrypt + sign | PASS | encryption as above; signature **`ES256K`** (secp256k1) |

### Decisions locked

- **Use `didcomm-node`** (not the `didcomm` package — that one is a
  bundler/WASM target that does not load under plain Node). The adapter surface
  is small and exactly what Phase 2 needs.
- **X25519 for key agreement.** The library's encryption curves are X25519 and
  P-256 only; secp256k1 cannot do key agreement.
- **secp256k1 keys sign DIDComm as-is** via `ES256K` — confirmed by a valid JWS
  with `non_repudiation: true`. So each Archon identity needs only a *new*
  X25519 key-agreement key; existing keys keep signing.

### Notes for Phase 1/2

- Verification-method `id`s must be full DID fragments (`did:cid:x#key-…`) and
  the wallet secret `id`s must match the DID-doc vm `id`s exactly.
- `forward: false` is required for direct two-party delivery; the default
  (`true`) invokes the Forward/mediator routing protocol (Phase 3/6).

### Caveats (validated-by-construction, not against live Archon)

- DID docs here are **mocks** shaped like the gatekeeper's normalized output —
  Phase 1 must prove a real `DidCidDocument` normalizes cleanly.
- X25519 keys are generated ad hoc, not derived from a wallet HD seed — that
  deterministic derivation is the first Phase 1 task.
