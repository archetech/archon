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
- **Cashu is enabled like Lightning.** `add-cashu [id]` enables Cashu for an
  identity on its node's mint, as `add-lightning [id]` creates its Lightning
  wallet on the node, and `publish-cashu [id]` advertises it in the DID document
  as `publish-lightning` does. Outside mints are added per identity.

## Phase 1: Keymaster wallet

### Storage

The wallet file is already encrypted at rest; ecash proofs are bearer value and
live there like the Nostr `nsec`.

```ts
// WalletFile
cashu?: {
    counters: Record<string, number>;   // keyset id -> next NUT-13 counter
};

// IDInfo: one entry per mint the identity uses, by normalized public URL
cashu?: Record<string, {
    added: string;
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
is released for reuse only when the mint rejects the request that used it, since
a rejected request can no longer sign. An interrupted swap is retried with the
same inputs and outputs until the mint answers; if the first attempt succeeded,
the retry is rejected and NUT-09 recovers the signatures. A melt's change outputs
stay reserved by its quote record until the quote is paid or unpaid, because a
pending melt can still sign them. Unsigned gaps come only from rejected requests,
which reuse their range, so the sequence stays within the NUT-13 recovery scan,
which stops after three empty batches of 100.

A quote record is saved before its invoice is paid or its melt is submitted, and
removed only after it settles. A paid mint quote is claimable by its id alone, so
losing the id strands the payment at the mint; `checkCashu` claims paid mint
quotes and collects melt change through the quote state, falling back to NUT-09
for the reserved change outputs.

Proof changes and counter changes go through `updateWallet`, so concurrent
operations in one Keymaster cannot spend or derive from the same state.

### Enabling and mint trust

An identity uses only the mints in its own `cashu` entry, as its Lightning
configuration is its own. `addCashu` adds the node's mint, the way `addLightning`
creates a wallet on the node: it is idempotent, and on a node without the `cashu`
capability it fails with an error that points to `addCashuMint`. `addCashuMint`
adds any other mint by URL.

Receiving a token from a mint the identity has not added fails with an error that
names the mint. Accepting a mint's tokens means trusting the mint with that
value, so the user adds it explicitly.

Removing a mint discards any proofs held there, which are the funds themselves,
so `removeCashu` and `removeCashuMint` refuse while the identity holds proofs at
the mint unless forced.

`publishCashu` adds a `#cashu` service to the identity's DID document, of type
`Cashu`, whose `serviceEndpoint` lists its mint URLs. `unpublishCashu` removes it.
Senders use it to pick a mint the recipient accepts (Phase 2).

### Methods

| Method | Behaviour |
|---|---|
| `addCashu(name?)` | Enable Cashu on the node's mint (Phase 3) |
| `removeCashu(force?, name?)` | Remove every mint from the identity |
| `addCashuMint(url, name?)` | Add an outside mint |
| `removeCashuMint(url, force?, name?)` | Remove one mint |
| `listCashuMints(name?)` | The identity's mints with NUT-06 info |
| `publishCashu(name?)` | Add the `#cashu` service listing the identity's mints |
| `unpublishCashu(name?)` | Remove the `#cashu` service |
| `getCashuBalance(mint?, name?)` | Unspent and pending totals for an identity |
| `createCashuMintQuote(amount, mint?)` | NUT-04 quote: a BOLT11 invoice to pay |
| `claimCashuMintQuote(quoteId, mint?, name?)` | Mint proofs once the quote is paid |
| `meltCashu(bolt11, mint?, name?)` | NUT-05: pay an invoice from proofs, keep change |
| `sendCashu(amount, mint?, name?)` | Swap to exact proofs and return a `cashuB` token |
| `receiveCashu(token, name?)` | Swap the token's proofs for new ones at its mint |
| `checkCashu(mint?, name?)` | NUT-07: settle pending proofs; settle open quotes and reservations |
| `restoreCashu(mint?, name?)` | NUT-09: recover proofs from the seed |
| `listCashuQuotes(mint?, name?)` | Open mint and melt quotes with their state |

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
- New error types for a mint the identity has not added, insufficient balance, a quote not paid
  and a token already spent.

### Surfaces

- Keymaster REST: a `cashu` route family in its own router, listed in
  `swaggerConf.js` and `docs/keymaster-api.json`, served identically by the Python
  service.
- `KeymasterClient` and the Python SDK.
- The CLI commands below, in `scripts/archon-cli.js`,
  `packages/keymaster/src/cli.ts` and `python/keymaster/src/keymaster/cli.py`.
- An MCP tool for each command in `packages/mcp-server/src/tools.ts`, writes
  marked mutating.

### CLI

All Cashu commands, including those Phases 2 and 3 add. They mirror the
Lightning commands: `add-cashu`, `remove-cashu`, `publish-cashu` and
`unpublish-cashu` correspond to their `-lightning` counterparts, operations take
a `cashu-` prefix as the Lightning ones take `lightning-`, and the identity is
the optional trailing `[id]`, defaulting to the current one. `-m, --mint <url>`
selects the mint; it defaults to the node's mint when the identity has it, else
to the identity's only mint, and is required otherwise.

Enabling Cashu for an identity is the same two steps as Lightning:

```
archon add-cashu          # archon add-lightning
archon publish-cashu      # archon publish-lightning
```

| Command | Method | Phase | Writes |
|---|---|---|---|
| `add-cashu [id]` | `addCashu` | 1; needs the node mint (3) | yes |
| `remove-cashu [id] [--force]` | `removeCashu` | 1 | yes |
| `add-cashu-mint <url> [id]` | `addCashuMint` | 1 | yes |
| `remove-cashu-mint <url> [id] [--force]` | `removeCashuMint` | 1 | yes |
| `list-cashu-mints [id]` | `listCashuMints` | 1 | no |
| `publish-cashu [id]` | `publishCashu` | 1 | yes |
| `unpublish-cashu [id]` | `unpublishCashu` | 1 | yes |
| `cashu-balance [id] [-m]` | `getCashuBalance` | 1 | no |
| `cashu-mint <amount> [id] [--pay] [-m]` | `createCashuMintQuote`, then `payLightningInvoice` and `claimCashuMintQuote` with `--pay` | 1 | yes |
| `cashu-claim <quoteId> [id] [-m]` | `claimCashuMintQuote` | 1 | yes |
| `cashu-quotes [id] [-m]` | `listCashuQuotes` | 1 | no |
| `cashu-melt <bolt11> [id] [-m]` | `meltCashu` | 1 | yes |
| `cashu-send <amount> [id] [-m]` | `sendCashu`; prints the token | 1 | yes |
| `cashu-receive <token> [id]` | `receiveCashu` | 1 | yes |
| `cashu-check [id] [-m]` | `checkCashu` | 1 | yes |
| `cashu-restore [id] [-m]` | `restoreCashu` | 1 | yes |
| `cashu-send-to <recipient> <amount> [memo] [--locktime <duration>] [-m]` | `sendCashuTo`; recipient is a DID or alias | 2 | yes |
| `cashu-accept [id]` | `receiveCashuMessages` | 2 | yes |
| `cashu-reclaim [id] [-m]` | `reclaimCashu`: refunds expired locked sends | 2 | yes |

Without `--pay`, `cashu-mint` prints the quote id and invoice and the user runs
`cashu-claim` after paying it. Commands that change ecash state print the
resulting balance.

Operators manage the node mint (Phase 3) with cdk-mintd's own tooling inside its
container; Archon adds no mint administration command.

### Tests

Unit tests mock the mint HTTP API. Integration tests run against the Phase 3
mint with its `fakewallet` backend, which settles quotes without Lightning, so
they need no public test mint.

## Phase 2: DID-locked ecash over DIDComm

### Locking

`sendCashuTo(did, amount, options?)`:

1. Choose the mint: the one given, else a mint listed in the recipient's `#cashu`
   service that the sender also uses, preferring the sender's node mint. With
   neither, the send fails and names the recipient's mints, or reports that the
   recipient publishes none.
2. Require the mint to advertise NUT-11 in its NUT-06 info. A mint without it may
   treat locked proofs as bearer tokens, so the send is refused rather than
   falling back to an unlocked token.
3. Resolve the recipient and take the public key of its current verification
   method. DID keys are secp256k1, the curve NUT-11 uses; the JWK becomes a
   compressed 33-byte public key.
4. Swap for proofs whose NUT-11 secret locks them to that key, with
   `SIG_INPUTS`, a `locktime` (default seven days), and the sender's current key
   as the `refund` key. The locked proofs stay in the sender's `pending` list,
   since their random secrets exist nowhere else and the refund needs them.
5. Encode the token, pack it for the recipient, and send it through the DIDComm
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
- `addCashu()` adds that public URL to the identity. Tokens name the mint
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

- enable and remove Cashu, and publish or unpublish it, as the Lightning view does
- the identity's mints, with add and remove
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
