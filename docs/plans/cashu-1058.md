# Cashu ecash (#1058)

Status: plan; not implemented.

Archon agents get Cashu ecash: a seed-recoverable wallet in Keymaster, tokens
sent over DIDComm and locked to the recipient's DID key, and an optional mint a
node operator can run on its existing CLN node. Lightning stays the settlement
layer; ecash is the spend layer agents hold and pass to each other.

## Scope

| Phase | Delivers |
|---|---|
| 1 | Keymaster ecash wallet: mints, balance, mint/melt over Lightning, send/receive tokens, restore |
| 2 | DID-locked ecash: NUT-11 P2PK tokens bound to a DID key, carried over DIDComm |
| 3 | Optional node mint: cdk-mintd as a Compose profile, discovered through Drawbridge |

Every phase ships in TypeScript and Python Keymaster, the REST API, both SDKs,
all three CLIs, MCP, the wallets (`packages/wallet-ui`) and the standalone clients
(`packages/keymaster-ui`).

Not in scope: NUT-24 (Cashu as an HTTP 402 payment method at Drawbridge) and mint
reputation credentials (Sigil). Both are recorded in #1058 as later work.

## Decisions

- **One ecash seed per wallet.** NUT-13 secrets derive from the wallet's existing
  BIP-39 seed, so the mnemonic restores held ecash in Archon and in any NUT-13
  wallet. Keyset counters are wallet-wide because every identity shares that seed.
  Outstanding DID-locked sends are the exception: their secrets are not derived
  from the seed, so reclaiming them needs the wallet file or a wallet backup.
- **Balances are per identity.** Proofs are stored under the identity that holds
  them. A restore recovers the funds but not that attribution; restored proofs go
  to the current identity.
- **Python stays in parity.** The Python Keymaster implements the Cashu
  cryptography itself rather than depending on Nutshell, which is a full wallet
  application.
- **The mint is optional.** It is a Compose profile like Lightning, and a node
  without it is an ordinary Cashu client of other mints.

## Phase 1: Keymaster wallet

### Storage

The wallet file is already encrypted at rest; ecash proofs are bearer value and
live there like the Nostr `nsec`.

```ts
// WalletFile
cashu?: {
    mints: Record<string, { added: string; unit: 'sat' }>;   // trusted mints, by normalized URL
    counters: Record<string, number>;                        // keyset id -> next NUT-13 counter
};

// IDInfo
cashu?: Record<string, {           // mint URL
    proofs: Proof[];               // unspent
    pending?: Proof[];             // sent or melting, not yet confirmed spent
    quotes?: CashuQuote[];         // open mint and melt quotes
}>;

interface CashuQuote {
    kind: 'mint' | 'melt';
    id: string;                    // mint's quote id
    amount: number;
    keyset: string;                // keyset of the outputs
    counters: [number, number];    // reserved NUT-13 counter range for outputs or change
    created: string;
}
```

Counters are reserved and saved before the blinded outputs they cover are sent to
the mint, so a crash can never reuse a counter the mint has signed. A reservation
is released for reuse only once the mint is known not to have signed it: an error
response, or a NUT-09 restore of the range after an interrupted request. Unsigned
gaps therefore do not accumulate, and the counter sequence stays within the
NUT-13 recovery scan, which stops after three empty batches of 100.

A quote record is saved before its invoice is paid or its melt is submitted, and
removed only after it settles. A paid mint quote is claimable by its id alone, so
losing the id strands the payment at the mint; `checkCashu` claims paid mint
quotes and collects melt change through the quote state, falling back to NUT-09
for the reserved change outputs.

Proof changes and counter changes go through `updateWallet`, so concurrent
operations in one Keymaster cannot spend or derive from the same state.

### Mint trust

Keymaster talks only to mints in `cashu.mints`. Receiving a token from any other
mint fails with an error that names the mint, and the user adds it explicitly.
Accepting a mint's tokens means trusting the mint with that value.

### Methods

| Method | Behaviour |
|---|---|
| `addCashuMint(url?)` | Trust a mint; with no URL, the node's mint (Phase 3) |
| `removeCashuMint(url)` | Refuses while any identity holds proofs there unless forced |
| `listCashuMints()` | Trusted mints with NUT-06 info |
| `getCashuBalance(mint?, name?)` | Unspent and pending totals for an identity |
| `createCashuMintQuote(amount, mint?)` | NUT-04 quote: a BOLT11 invoice to pay |
| `claimCashuMintQuote(quoteId, mint?, name?)` | Mint proofs once the quote is paid |
| `meltCashu(bolt11, mint?, name?)` | NUT-05: pay an invoice from proofs, keep change |
| `sendCashu(amount, mint?, name?)` | Swap to exact proofs and return a `cashuB` token |
| `receiveCashu(token, name?)` | Swap the token's proofs for new ones at its mint |
| `checkCashu(mint?, name?)` | NUT-07: settle pending proofs; settle open quotes and reservations |
| `restoreCashu(mint, name?)` | NUT-09: recover proofs from the seed |

A wallet with Lightning funds the quote with `payLightningInvoice`; the CLI and UI
offer that in one step. `receiveCashu` always swaps at the mint, since a token is
not received until the mint confirms its proofs are unspent.

### Implementation

- TypeScript uses `@cashu/cashu-ts` 4.x. It requires `@noble/curves` 2 while
  `packages/cipher` uses 1.9; upgrading cipher first avoids shipping both copies
  in the browser wallets.
- Python implements NUT-00 hash-to-curve, blinding and unblinding, NUT-12 DLEQ
  verification, NUT-13 derivation, NUT-11 signing and the V4 (`cashuB`, CBOR)
  token format, plus a mint HTTP client.
- Both ports are checked against the NUT specification test vectors and against
  committed TypeScript-generated vectors, as the DIDComm port was.
- New error types for a mint not trusted, insufficient balance, a quote not paid
  and a token already spent.

### Surfaces

- Keymaster REST: a `cashu` route family in its own router, listed in
  `swaggerConf.js` and `docs/keymaster-api.json`, served identically by the Python
  service.
- `KeymasterClient` and the Python SDK.
- CLI: `cashu-add-mint`, `cashu-remove-mint`, `cashu-list-mints`,
  `cashu-balance`, `cashu-mint`, `cashu-melt`, `cashu-send`, `cashu-receive`,
  `cashu-check`, `cashu-restore` in `scripts/archon-cli.js`,
  `packages/keymaster/src/cli.ts` and `python/keymaster/src/keymaster/cli.py`.
- MCP tools in `packages/mcp-server/src/tools.ts`, writes marked mutating.

### Tests

Unit tests mock the mint HTTP API. Integration tests run against the Phase 3
mint with its `fakewallet` backend, which settles quotes without Lightning, so
they need no public test mint.

## Phase 2: DID-locked ecash over DIDComm

### Locking

`sendCashuTo(did, amount, options?)`:

1. Require the mint to advertise NUT-11 in its NUT-06 info. A mint without it may
   treat locked proofs as bearer tokens, so the send is refused rather than
   falling back to an unlocked token.
2. Resolve the recipient and take the public key of its current verification
   method. DID keys are secp256k1, the curve NUT-11 uses; the JWK becomes a
   compressed 33-byte public key.
3. Swap for proofs whose NUT-11 secret locks them to that key, with
   `SIG_INPUTS`, a `locktime` (default seven days), and the sender's current key
   as the `refund` key. The locked proofs stay in the sender's `pending` list,
   since their random secrets exist nowhere else and the refund needs them.
4. Encode the token, pack it for the recipient, and send it through the DIDComm
   service.

An intercepted token is unspendable, and an unclaimed one returns to the sender
after the locktime through `reclaimCashu`.

### Message

```json
{
  "type": "https://archetech.com/didcomm/cashu/1.0/token",
  "body": { "token": "cashuB...", "memo": "optional" }
}
```

Archon's own DIDComm protocols live under `https://archetech.com/didcomm/`,
published from a new `archetech/didcomm` repository through GitHub Pages, as
`archetech.com/schemas/` is. The protocol URI `https://archetech.com/didcomm/cashu/1.0`
resolves to the protocol's specification. Versions follow DIDComm v2: a minor
version only adds, and receivers accept higher minor versions. Keymaster lists the
protocol in its discover-features disclosures so a sender can check support first.

### Receiving

`receiveCashuMessages(name?)` takes token messages from the DIDComm inbox, signs
each locked proof with the matching private key and swaps it. The matching key
may be an earlier derivation if the recipient has rotated keys; Keymaster already
searches retained derivations. Processed messages are recorded so a token message
is not redeemed twice.

The specification for DID-locked ecash is `cashu/1.0/README.md` in
`archetech/didcomm`, with a JSON Schema for the message body: the key selection
rule, the locking tags, the message type and the refund path. Archon's `docs/`
links to it.

## Phase 3: Optional node mint

### Component

- `docker/compose/cashu-mint.yml`, included from `docker-compose.yml` and enabled
  by the `cashu` profile in `COMPOSE_PROFILES`.
- The `cashubtc/mintd` image at a pinned version.
- An entrypoint generates the mint configuration from environment variables and,
  on first start, the mint mnemonic, persisted like the Lightning macaroon
  secrets.
- SQLite under `./data/cashu-mint`, bind-mounted and running as
  `${ARCHON_UID}:${ARCHON_GID}`.
- `ARCHON_CASHU_MINT_BACKEND`: `cln` uses the bundled CLN's RPC socket and needs
  the `lightning` profile; `fakewallet` is for development and CI.
- Conservative defaults for mint and melt limits and fees, with all values set in
  environment variables documented in `sample.env`.

### Exposure

- The mint publishes no host port. Drawbridge is the only route to it, for
  Keymaster as well as external wallets.
- Drawbridge proxies the mint's `/v1/*` API under `/cashu`, stripping the prefix,
  outside L402. Cashu mint URLs may carry a path, so the mint's public URL is
  `<public host>/cashu` and cdk-mintd needs no prefix support.
- Drawbridge `/capabilities` reports `cashu` when a mint URL is configured, and a
  discovery route returns the public mint URL, as `/didcomm-endpoint` does for
  DIDComm.
- `addCashuMint()` with no argument trusts that public URL. Tokens name the mint
  by URL, so Keymaster records the public one and sends its requests to its own
  node's `/cashu` path; tokens it issues are then redeemable by external wallets.

### Operator documentation

Running a mint holds other people's funds on the node's Lightning balance. The
operator documentation states that, the limits, the keyset rotation procedure and
the backup of the mint database and mnemonic.

## User interface

Both `packages/wallet-ui` and `packages/keymaster-ui` get a Cashu view, always
available so a wallet on a node without a mint can add an outside one. The `cashu`
capability only offers the node's own mint as a one-step choice. The view has:

- trusted mints, with add and remove
- balance per mint for the current identity
- mint: show the quote invoice, or pay it from Lightning
- melt: pay an invoice
- send a token (copy and QR), receive a token (paste)
- send to a DID, list incoming token messages and claim them, reclaim expired
  sends

`tests/wallet/ui-capability-parity.test.ts` covers the new Keymaster methods
without allowlist entries.

## Delivery

| PR | Content |
|---|---|
| 1 | `packages/cipher` on `@noble/curves` 2 |
| 2 | Mint component with `fakewallet` and `cln` backends; Drawbridge proxy, capability and discovery |
| 3 | Keymaster wallet core and REST, TypeScript and Python, with vectors |
| 4 | SDKs, CLIs, MCP |
| 5 | DID-locked sends over DIDComm, both ports; the protocol specification in `archetech/didcomm` |
| 6 | Wallet and client UI |

The mint component lands before the wallet so the wallet's integration tests have
a mint to run against.

## Risks

- Cashu implementations are still under security audit; keep mint limits low and
  label the feature experimental in operator documentation.
- Mints rotate keysets. The wallet swaps proofs from inactive keysets during
  `checkCashu`, and the operator documentation covers rotation.
- Two copies of one wallet in use at once derive the same counters and hold the
  same proofs. The mint rejects the second use, so operations fail and each copy
  shows proofs the other has spent until `checkCashu` reconciles them.
