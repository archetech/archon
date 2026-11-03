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
  them. A restore recovers the funds but not that attribution. It checks recovered
  proofs against every identity's proofs and journal, keeps existing ownership,
  and assigns only proofs no identity holds or has sent to the requested identity.
- **Python stays in parity.** The Python Keymaster implements the Cashu
  cryptography itself rather than depending on Nutshell, which is a full wallet
  application.
- **The mint is optional.** It is a Compose profile like Lightning, and a node
  without it is an ordinary Cashu client of other mints.
- **Satoshis only.** The wallet uses each mint's `sat` keysets and ignores keysets
  in other units.
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
    counters: Record<string, {          // by keyset id
        next: number;                   // next never-used NUT-13 counter
        free: [number, number][];       // released ranges, reused before next
    }>;
};

// IDInfo: one entry per mint the identity uses, by normalized URL
cashu?: Record<string, {
    added: string;
    proofs: Proof[];               // unspent, spendable by this identity
    operations?: CashuOperation[]; // journal of unsettled operations
}>;

interface CashuOperation {
    id: string;
    kind: 'mint' | 'melt' | 'swap' | 'receive' | 'send' | 'locked-send';
    quote?: string;                // mint or melt quote id
    inputs: Proof[];               // proofs the operation spends
    keyset: string;                // keyset of the outputs
    outputs: {                     // in request order
        amount: number;            // 0 for a blank NUT-08 change output
        role: 'keep' | 'send';     // credited to proofs, or handed out as the token
        counter?: number;          // NUT-13 derivation
        secret?: string;           // non-derived secret, e.g. P2PK,
        r?: string;                // with its blinding factor
    }[];
    sent?: Proof[];                // proofs handed out as a token, until redeemed
    message?: { id: string; packed: string; delivered: boolean }; // locked-send DIDComm delivery
    created: string;
}
```

A mint URL is normalized before it is stored or compared: lowercase scheme and
host, default port removed, no trailing slash, no query or fragment. A token
names its mint by the same normalized form, so a token's mint matches an
identity's entry exactly.

Every operation that talks to the mint is journaled first. Its record, with its
inputs, its quote and everything needed to rebuild its outputs, is saved before
the request is sent, so an interrupted operation can be finished after a restart
rather than lost. Each output keeps its amount and role, so a resubmission
reproduces the same request and recovered signatures go to the balance or the
token as intended. Outputs with seed-derived secrets need only their counter;
outputs with random secrets, such as the P2PK outputs of a locked send,
store the secrets and blinding factors themselves, since neither the mnemonic
nor the response can supply them. A record is retired only after its result is
saved.

The journal also says what each unspent proof is for, which NUT-07 alone cannot.
After a restart, `checkCashu` settles each record by kind:

| Kind | Settled when | Outcome |
|---|---|---|
| `mint` | the quote is paid, or expires unpaid | claim the proofs, or drop the record |
| `melt` | the quote is paid or unpaid | keep the change, or return the inputs to `proofs` |
| `swap` | the inputs are spent, or the mint rejects a retry | recover outputs through NUT-09, or return the inputs once NUT-07 shows them unspent |
| `receive` | the inputs are spent, or the mint rejects a retry | recover outputs through NUT-09, or drop the record and report the token as already spent |
| `send`, `locked-send` | the swap settles as above, then every `sent` proof is spent | the token was redeemed; until then it is outstanding, not balance |

Inputs return to `proofs` only when the identity owned them and NUT-07 shows them
unspent. A received token's proofs were never the identity's, so its value is
credited only from the swap's outputs: if someone else spent the token first, the
receive yields nothing.

A sent token is never returned to the balance because its proofs are unspent: the
recipient may not have redeemed it yet. `reclaimCashu` takes back an unredeemed
token explicitly, by swapping it, or for a locked send by the refund key once the
locktime has passed.

Counters are reserved and saved before the blinded outputs they cover are sent to
the mint, so a crash can never reuse a counter the mint has signed. A reservation
is released for reuse only once the request that used it is settled and can no
longer sign: all of it when the mint rejects the request, and the unsigned tail
of a melt's change outputs once the melt is paid, since NUT-08 lets the mint sign
fewer change outputs than were sent, or none. Released ranges go to the keyset's
`free` list and are allocated before `next`. An interrupted request is retried
with the same inputs and outputs until the mint answers; if the first attempt
succeeded, the retry is rejected and NUT-09 recovers the signatures. Every unsigned
counter of a settled request is reused, so gaps in the signed sequence are bounded
by the outputs of requests still in flight, and stay within the NUT-13 recovery
scan, which stops after three empty batches of 100.

`restoreCashu` scans every `sat` keyset the mint lists, active and inactive,
since proofs minted under a since-rotated keyset are still redeemable.

Counters are only as current as the wallet file. A wallet recovered from its
mnemonic, from a backup (`recoverWallet`) or an identity recovered with
`recoverId` may hold counters the mint has already signed. `restoreCashu` sets
each keyset's `next` past the highest signed counter it finds, and a request the
mint rejects because its outputs are already signed triggers a NUT-09 scan of
that keyset and a retry with fresh counters, so stale counters repair themselves
instead of failing every operation.

Proof, journal and counter changes go through `mutateWallet`, so concurrent
operations in one Keymaster cannot spend or derive from the same state. The lock
is not held across mint requests. An operation takes it to select inputs, reserve
counters and write its journal record, moving the inputs out of `proofs` into
the record; it sends the request unlocked; and it takes the lock again to save
the result and retire the record. Inputs in a journal record are unavailable to
other operations, so nothing else can spend them meanwhile.

### Enabling and mint trust

An identity uses only the mints in its own `cashu` entry, as its Lightning
configuration is its own. `addCashu` adds the node's mint, the way `addLightning`
creates a wallet on the node: it is idempotent, and on a node without the `cashu`
capability it fails with an error that points to `addCashuMint`. `addCashuMint`
adds any other mint by URL.

Both refuse a mint whose NUT-06 info does not advertise NUT-07, NUT-08 and NUT-09.
Without NUT-07 the journal cannot be settled; without NUT-08 the unused part of a
melt's fee reserve is never returned as change; and without NUT-09 ecash minted
there could not be recovered from the mnemonic.

Receiving a token from a mint the identity has not added fails with an error that
names the mint. Accepting a mint's tokens means trusting the mint with that
value, so the user adds it explicitly.

Removing a mint discards the identity's proofs and journal there, which are the
funds themselves and the only record of paid quotes, outstanding tokens and
random output secrets. `removeCashu` and `removeCashuMint` refuse while either is
non-empty unless forced.

The same state makes the existing identity removals dangerous, since both ports
delete the whole `IDInfo`. `removeId` refuses to remove an identity holding Cashu
proofs or journal records. `fixWallet`, which removes identities whose DIDs are
deactivated or fail to resolve, keeps such identities and reports them instead.

`publishCashu` adds a `#cashu` service to the identity's DID document, of type
`Cashu`, whose `serviceEndpoint` lists its mint URLs. `unpublishCashu` removes it.
Senders use it to pick a mint the recipient accepts (Phase 2).

### Network access

Keymaster reaches mints in two ways.

- **The node's mint** goes through the node's Drawbridge at `<node URL>/cashu`,
  whatever public URL the identity stores for it (Phase 3).
- **Any other mint** is a URL a caller chose, which on a server-side Keymaster
  makes it a request-forgery vector. TypeScript passes cashu-ts's `Mint` a
  `customRequest` built on `fetchPublicHttps` from `@didcid/common/net`; Python
  uses `fetch_public_https` from `keymaster.net`. Both require https, reject
  private addresses at connection time and revalidate redirects, as the existing
  Lightning Address and Herald fetches do. In a browser the same import resolves
  to plain `fetch`, and the mint must allow cross-origin requests, which public
  mints commonly do; a mint that does not fails with an error that says so.

A token received from an unadded mint is rejected before any request is made,
so a token cannot point Keymaster at an arbitrary host.

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
| `getCashuBalance(mint?, name?)` | Spendable, in-flight and outstanding-sent totals for an identity |
| `createCashuMintQuote(amount, mint?, name?)` | NUT-04 quote: a BOLT11 invoice to pay |
| `claimCashuMintQuote(quoteId, mint?, name?)` | Mint proofs once the quote is paid |
| `meltCashu(bolt11, mint?, name?)` | NUT-05: pay an invoice from proofs, keep change |
| `sendCashu(amount, mint?, name?)` | Swap to exact proofs and return a `cashuB` token |
| `receiveCashu(token, name?)` | Swap the token's proofs for new ones at its mint |
| `checkCashu(mint?, name?)` | Settle the journal: NUT-07 states, quote states, retries and NUT-09 |
| `restoreCashu(mint?, name?)` | NUT-09: recover proofs from the seed |
| `listCashuQuotes(mint?, name?)` | Open mint and melt quotes from the journal, with their state |
| `sendCashuTo(recipient, amount, options?)` | Phase 2: locked send over DIDComm; options `{ memo?, locktime?, mint?, name? }` |
| `receiveCashuMessages(name?)` | Phase 2: redeem token messages from the DIDComm inbox |
| `reclaimCashu(mint?, name?)` | Phase 2: take back unredeemed sends, locked ones once their locktime passes |

Every method that omits `mint` uses the same default as the CLI: the node's mint
when the identity has it, else the identity's only mint, else an error.
`getCashuBalance` with no mint and an identity using several returns a total and
a per-mint breakdown instead of failing.

A wallet with Lightning funds the quote with `payLightningInvoice`; the CLI and UI
offer that in one step. `receiveCashu` always swaps at the mint, since a token is
not received until the mint confirms its proofs are unspent.

### Implementation

- TypeScript uses `@cashu/cashu-ts` 4.x. It requires `@noble/curves` 2 while
  `packages/cipher` uses 1.9; upgrading cipher first avoids shipping both copies
  in the browser wallets.
- Python implements NUT-00 hash-to-curve, blinding and unblinding, NUT-12 DLEQ
  verification, NUT-13 derivation, NUT-11 signing and the V4 (`cashuB`, CBOR)
  token format, plus a mint HTTP client. Elliptic-curve operations and BIP-340
  Schnorr signatures use `coincurve`, already a dependency; CBOR adds `cbor2`,
  pinned like the other dependencies.
- NUT-13 derivation depends on the keyset ID version: keysets whose IDs start
  with `01` use the HMAC-SHA256 derivation, and deprecated `00` keysets use the
  BIP32 path `m/129372'/0'/<keyset>'/<counter>'/{0,1}`. Both ports implement
  both, checked against the NUT-13 vectors for each.
- Both ports are checked against the NUT specification test vectors and against
  committed TypeScript-generated vectors, as the DIDComm port was.
- Amounts account for NUT-02 input fees: a send or melt selects enough proofs to
  cover the keyset's `input_fee_ppk` as well as the amount.
- New error types in `packages/common/src/errors.ts` and the Python equivalents,
  following `LightningNotConfiguredError`:

  | Error | `type` |
  |---|---|
  | `CashuNotConfiguredError` | `Cashu not configured` (the identity has no mints) |
  | `CashuUnavailableError` | `Cashu mint unavailable` (no node mint, or a mint unreachable) |
  | `CashuMintNotAddedError` | `Cashu mint not added` |
  | `CashuMintUnsupportedError` | `Cashu mint unsupported` (a required NUT missing) |
  | `CashuInsufficientFundsError` | `Insufficient ecash` |
  | `CashuQuoteUnpaidError` | `Cashu quote not paid` |
  | `CashuTokenSpentError` | `Cashu token already spent` |
  | `CashuStateError` | `Cashu state present` (a removal refused without force) |

  The Keymaster service maps them to HTTP statuses in `keymaster-error-status.ts`
  and its Python counterpart.

### Surfaces

- Keymaster REST: `keymaster-cashu-router.ts`, listed in `swaggerConf.js` in
  mount order and in `docs/keymaster-api.json`, served identically by the Python
  service. As the Lightning routes do, every route is a `POST` (or `DELETE` to
  remove) whose JSON body carries the method's arguments, with the identity as
  `id`:

  | Route | Method |
  |---|---|
  | `POST /cashu`, `DELETE /cashu` | `addCashu`, `removeCashu` (`force`) |
  | `POST /cashu/mints`, `DELETE /cashu/mints` | `addCashuMint`, `removeCashuMint` (`url`, `force`) |
  | `POST /cashu/mints/list` | `listCashuMints` |
  | `POST /cashu/publish`, `POST /cashu/unpublish` | `publishCashu`, `unpublishCashu` |
  | `POST /cashu/balance` | `getCashuBalance` |
  | `POST /cashu/quote`, `POST /cashu/claim`, `POST /cashu/quotes` | `createCashuMintQuote`, `claimCashuMintQuote`, `listCashuQuotes` |
  | `POST /cashu/melt`, `POST /cashu/send`, `POST /cashu/receive` | `meltCashu`, `sendCashu`, `receiveCashu` |
  | `POST /cashu/check`, `POST /cashu/restore` | `checkCashu`, `restoreCashu` |
  | `POST /cashu/send-to`, `POST /cashu/accept`, `POST /cashu/reclaim` | `sendCashuTo`, `receiveCashuMessages`, `reclaimCashu` (Phase 2) |

- Result types in `packages/clients/src/keymaster-types.ts`, mirrored in Python:
  `CashuMintInfo` (`url`, `name`, `nuts`, `keysets`, `isNodeMint`),
  `CashuBalance` (`spendable`, `inFlight`, `outstanding`, and `mints` when
  totalled across several), `CashuMintQuote` (`quote`, `request`, `amount`,
  `state`, `expiry`), `CashuMeltResult` (`paid`, `preimage`, `fee`, `change`),
  `CashuSendResult` (`token`, `amount`, `fee`), `CashuReceiveResult` (`amount`,
  `mint`), `CashuCheckResult` (counts of records settled and still open), and
  `CashuSendToResult` (`token`, `messageId`, `delivered`).
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
| `cashu-send-to <recipient> <amount> [memo] [id] [--locktime <duration>] [-m]` | `sendCashuTo`; recipient is a DID or alias | 2 | yes |
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
they need no public test mint. They join the CLI tests in `tests/cli-tests`, run
by `docker-build-test.yml` against both Keymaster flavors, which enable the
`cashu` profile with `ARCHON_CASHU_MINT_BACKEND=fakewallet`. The fixtures that
drive them must be inputs of `scripts/ci-affected.sh` so a change to them runs
those tests.

## Phase 2: DID-locked ecash over DIDComm

### Locking

`sendCashuTo(recipient, amount, { memo?, locktime?, mint?, name? })`, where
`recipient` is a DID or alias and `locktime` is a duration in seconds (the CLI
also accepts `30m`, `12h` or `7d`), default seven days:

1. Choose the mint: the one given, else a mint listed in the recipient's `#cashu`
   service that the sender also uses, preferring the sender's node mint. With
   neither, the send fails and names the recipient's mints, or reports that the
   recipient publishes none.
2. Require the mint to advertise NUT-11 in its NUT-06 info. A mint without it may
   treat locked proofs as bearer tokens, so the send is refused rather than
   falling back to an unlocked token.
3. Resolve the recipient and take the public key of its first verification
   method, the same key Keymaster already uses to encrypt to a DID. DID keys are
   secp256k1, the curve NUT-11 uses; the JWK becomes a compressed 33-byte public
   key. NUT-11 witnesses are BIP-340 Schnorr signatures rather than the ECDSA
   Keymaster signs DID operations with, made with the same private key:
   cashu-ts's `signP2PKProofs` in TypeScript and `coincurve` in Python.
4. Swap for proofs whose NUT-11 secret locks them to that key, with
   `SIG_INPUTS`, a `locktime` (default seven days), and the sender's current key
   as the `refund` key. The swap is journaled as a `locked-send` with its random
   secrets and blinding factors before it is submitted, and the record keeps the
   locked proofs, since they exist nowhere else and the refund needs them.
5. Encode the token, pack it for the recipient, and send it through the DIDComm
   service. The journal record keeps the packed message and is marked delivered
   only when the DIDComm service accepts it; `checkCashu` resends an undelivered
   message with the same message id, which the recipient deduplicates.

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

The general DIDComm inbox must not consume token messages. `receiveDidComm`
returns them like any other message but leaves them out of the messages it
acknowledges, so `receive-didcomm` and `ack-didcomm` cannot delete a token before
it is redeemed; an explicit `ack-didcomm` of a token message's id still removes it.

`receiveCashuMessages(name?)` takes token messages from the DIDComm inbox, signs
each locked proof with the matching private key and swaps it. The matching key
may be an earlier derivation if the recipient has rotated keys; Keymaster already
searches retained derivations. It journals each redemption as a `receive` and
acknowledges the message only after the record is saved, so a crash cannot lose
a token between the mailbox and the wallet. Processed message ids are recorded so
a resent message is not redeemed twice.

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
  the `lightning` profile; `fakewallet` is for development and CI. The bundled
  CLN is mainnet, so a `cln` mint holds real bitcoin. Operators should run it
  first with `fakewallet`, and the operator documentation says so.
- Conservative defaults for mint and melt limits and fees, with all values set in
  environment variables documented in `sample.env`.

### Exposure

- The mint publishes no host port. Drawbridge is the only route to it, for
  Keymaster as well as external wallets.
- Drawbridge reads the mint's internal URL from `ARCHON_CASHU_MINT_URL`
  (`http://cashu-mint:<port>` in Compose, empty to disable), following
  `ARCHON_DIDCOMM_URL`.
- Drawbridge proxies the mint's `/v1/*` API under `/cashu`, stripping the prefix,
  outside L402 but behind per-source and global rate limits configured like the
  DIDComm ones (`ARCHON_DRAWBRIDGE_CASHU_PER_SOURCE`,
  `ARCHON_DRAWBRIDGE_CASHU_GLOBAL`). Cashu mint URLs may carry a path, so the mint's public URL is
  `<public host>/cashu` and cdk-mintd needs no prefix support.
- Drawbridge `/capabilities` reports `cashu` when the mint URL is configured, and
  `GET /cashu-mint` returns `{ url }`, the public mint URL (`<public host>/cashu`,
  or the onion address), as `/didcomm-endpoint` does for DIDComm.
- `DrawbridgeClient` in `@didcid/clients` gains `getCashuMint()`, and the Python
  Keymaster's Gatekeeper client gains `get_cashu_mint()`.
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
| 1 | `packages/cipher` on `@noble/curves` 2, with tests that existing keys, signatures and encryption are byte-identical before and after |
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
