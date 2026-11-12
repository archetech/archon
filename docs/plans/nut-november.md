# Nut November options

Status: option A is delivered ([cashu-402-1596.md](cashu-402-1596.md)), and option E
is open upstream as cashubtc/cdk#2874. The other options are undecided.

[Nut November](https://nutnovember.org) is a month-long Cashu hackathon. Work
made from November 1 counts; submissions close **November 27, 23:59 UTC**, and
winners are announced November 30. Existing projects may enter if the
submission says what was added in November. Code must be public under an
open-source licence and must use or improve Cashu. Judges publish no criteria
beyond "progress counts for more than polish". An optional show and tell is on
November 17, 16:00 UTC.

## What we can already submit

The Cashu work in [cashu-1058.md](cashu-1058.md) landed November 3–7 and
qualifies as it stands:

- **Node mint:** cdk-mintd behind Drawbridge (#1517). It runs live at https://4tress.org/cashu.
- **Keymaster wallet:** TypeScript and Python, with the REST API (#1520).
- **Other surfaces:** the SDKs, the three CLIs and MCP tools (#1525), and the wallet and client UI (#1531).
- **Ecash locked to a DID (NUT-11) and sent over DIDComm** (#1526), with the spec published at archetech.com/didcomm/cashu/1.0.
- **A regtest suite against real Lightning** (#1529).
- **An upstream bug report:** cashubtc/cdk#2836, a melt that stays PENDING after a failed payment.

## NUTs implemented

As of November 11, with option A delivered. Numbers and names are from the
[NUT index](https://github.com/cashubtc/nuts).

**The wallet, in both Keymasters (TypeScript and Python)**

| NUT | Name | Used for |
|---|---|---|
| 00 | Cryptography and models | Tokens and blind signatures. Python has its own implementation |
| 01 | Mint public keys | Fetching a mint's keys |
| 02 | Keysets and fees | Keysets, keyset rotation and input fees |
| 03 | Swapping tokens | Send, receive and rotation |
| 04 | Minting tokens | Ecash from a paid invoice |
| 05 | Melting tokens | Paying an invoice from ecash |
| 06 | Mint info | Reading it, and refusing a mint without NUT-07, 08 or 09 |
| 07 | Token state check | Settling the journal |
| 08 | Overpaid Lightning fees | Change from a melt's fee reserve |
| 09 | Signature restore | Restoring from the seed, and recovery after a lost response |
| 10 | Spending conditions | Only the kind NUT-11 needs |
| 11 | Pay-to-pubkey | Ecash locked to a DID's key, with a locktime and a refund to the sender |
| 12 | DLEQ proofs | Verifying the mint's signatures |
| 13 | Deterministic secrets | Derived from the wallet's existing BIP-39 seed |
| 20 | Signature on mint quote | Only a quote's creator can claim it |
| 23 | Payment method: BOLT11 | The invoices minted and melted with |

**HTTP 402 payments (option A)**

| NUT | Name | Used for |
|---|---|---|
| 24 | HTTP 402 Payment Required | Drawbridge sends the request and redeems the token |
| 18 | Payment requests | Drawbridge creates them; Keymaster decodes and pays them |
| 26 | Payment request bech32m encoding | Decoding `creqB` requests |

The NUT index lists no implementation of NUT-24 yet.

**Partial**

- **NUT-18:** in-band payment only. A request that asks for a locked token or
  names payment methods is refused, and the Nostr and HTTP POST transports are
  not implemented.
- **NUT-10:** pay-to-pubkey only. Hashed timelock contracts (NUT-14) are not
  implemented.

**Not ours**

- **The mint** is `cashubtc/mintd`, which the node bundles and proxies.
- **NUT-17** (WebSocket subscriptions): Drawbridge removes it from the mint's
  advertised info, since the proxy cannot carry it.
- **NUT-16** and **NUT-21/22** are options below, not built.

Of the optional NUTs, the ones below fit what Archon already has.

## Options

### A. Pay-per-call APIs with ecash (NUT-24), shown by an agent

[NUT-24](https://github.com/cashubtc/nuts/blob/main/24.md) is Cashu's HTTP
402:

1. A server answers `402` with an `X-Cashu` header holding a payment request.
   The request is NUT-18 `creqA` or NUT-26 `creqB`, giving the amount, the unit
   and the accepted mints.
2. The client retries with a `cashuB` token in the same header.
3. A wrong mint, wrong unit, short amount or insufficient lock gets a `400`.

Drawbridge already gates priced API operations behind L402, which needs a
Lightning payment per macaroon. With NUT-24, Drawbridge would offer Cashu as a
second way to pay the same price. Keymaster and the MCP server would pay it
from the agent's own ecash.

- **Demo:** an AI agent with its own DID and ecash calls a priced Archon API
  and pays per request, with no Lightning node, no channel and no account.
- **New work:**
  - Drawbridge:
    - issue the `X-Cashu` request alongside the L402 challenge;
    - verify the token's mint, unit and amount;
    - redeem the token at the mint by swapping it (NUT-03) before serving, so a
      token can't be spent twice;
    - keep the redeemed proofs, or melt them to the node's Lightning.
  - Client: Keymaster and MCP retry a `402` with a token.
  - Encoding: `creqA` and `creqB`. The wallet doesn't parse either yet.
- **Questions for review:**
  - Where Drawbridge keeps redeemed proofs. Its own Keymaster wallet is one
    option; melting to the node is another.
  - Whether a node without its own mint accepts other mints.
- **Risk:** moderate. The plan for #1058 already listed NUT-24 as later work.

### B. Payment requests to a DID (NUT-18 with a DIDComm transport)

[NUT-18](https://github.com/cashubtc/nuts/blob/main/18.md) lets a payee
publish a request (`creqA…`) naming the amount, unit, accepted mints, an
optional NUT-10 lock, and transports for delivering the payment. The
transports defined today are `nostr` (NIP-17 DMs) and `post` (HTTP).

- **Demo:** "request 500 sats from `did:cid:…`". The payer's wallet locks the
  tokens to the payee's DID key and delivers them over DIDComm, the path #1526
  already uses.
- **Interop:** our wallet also pays and creates the `nostr` and `post` requests
  other Cashu wallets produce.
- **New work:**
  - `creqA` and `creqB` encoding and decoding.
  - A `didcomm` transport whose target is a DID. NUT-18 doesn't say how a new
    transport type is added, so this needs a proposal to `cashubtc/nuts`, and
    that proposal is the "improves Cashu" part.
  - Mapping the payload onto our existing DIDComm Cashu message.
- **Risk:** low for the code, which reuses A's encoding. Whether the transport
  is adopted upstream is outside our control and slower than the hackathon.

### C. Members-only mint with private spending (NUT-21/22 through Herald)

- [NUT-21](https://github.com/cashubtc/nuts/blob/main/21.md) lets a mint
  require an OpenID Connect login.
- [NUT-22](https://github.com/cashubtc/nuts/blob/main/22.md) turns that login
  into blind auth tokens, unit `auth`. They are spent one per protected request,
  so the mint knows a user is authorized but can't link their requests. Herald
  is already an OIDC provider.

- **Demo:** a node mint that issues ecash only to holders of an Archon
  identity, or of a membership credential, while their spending stays
  unlinkable within the member group.
- **New work:**
  - Herald's OAuth provider as NUT-21 requires it:
    - a public client using PKCE without a client secret (Herald checks a
      `client_secret` today);
    - signed JWT access tokens in ES256 or RS256, verifiable by the mint
      (Herald issues opaque tokens for `/userinfo`);
    - the device-code grant NUT-21 recommends;
    - refresh tokens.
  - Configure cdk-mintd's auth with Herald as the provider.
  - Claims for the check: DID, membership.
  - Wallet support for NUT-21 login and for minting and spending NUT-22 tokens.
- **Risk:** the highest of the three. It depends on cdk-mintd's auth
  configuration and on Herald's OIDC flow, which has broken on fresh deploys
  before. It is also the least reusable outside Archon.

### Smaller additions

- **D. Animated QR codes (NUT-16).** A serialized token longer than 2,900
  characters overflows one QR code, so the UI can only copy it today
  (`QR_LIMIT` in `CashuView`). The length depends on the number of proofs, not
  the value: a 1,023-sat token of 10 proofs is about 3,000 characters. NUT-16
  animates long tokens across frames. Mostly UI work.
- **E. Upstream fix for cashubtc/cdk#2836.** cdk-cln treats xpay errors
  outside codes 203/205/206/207 as unknown. A failed payment (code 209) then
  leaves the melt PENDING and the proofs stuck. A merged patch improves Cashu
  directly, for every CDK mint, not only ours. The work is in Rust in CDK's
  repository and needs the maintainers' review in time.

## Comparison

| | A. NUT-24 | B. NUT-18 + DIDComm | C. NUT-21/22 | D. NUT-16 | E. cdk#2836 |
|---|---|---|---|---|---|
| Unique to Archon | agent identity + Drawbridge | DID transport | identity-gated mint | no | no |
| Improves Cashu beyond Archon | no | proposed transport | no | no | yes |
| Size | medium | small after A | large, including Herald's provider | small | small–medium |
| Risk | moderate | low (code) | high | low | upstream review |
| Visible in a demo | high | medium | high | medium | low |

## Suggested order

1. **A** by the November 17 show and tell, demoed by an agent paying per call.
2. **D** and **E** alongside, since they are independent and small.
3. **B** after A, reusing its payment-request encoding.
4. **C** only if the others are done.

## Decisions needed

1. **Which options to build.**
2. **Parity.** The #1058 convention ships every phase in both Keymasters, the
   REST API, both SDKs, all three CLIs, MCP and both UIs. For the hackathon,
   one option is to build TypeScript Keymaster, MCP and Drawbridge first and
   port to Python after November 27. The cost is a recorded parity gap until
   the port.
3. **Demo node.** 4tress.org already runs the mint over https. Option A also
   needs Drawbridge's paid routes priced there.
4. **Submission.** One entry covering all the November work, or separate
   entries per option. The rules allow several if each stands on its own, and
   each project can win only one prize.
