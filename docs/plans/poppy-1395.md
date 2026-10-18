# Personal Agent Protocol support (#1395)

Status: proposed. Phase 0 has not started. Based on Draft 0.1 of the
[specification](https://personalagentprotocol.org/docs/spec) and
[guides](https://personalagentprotocol.org/docs/guides) as read on 2026-10-18.

## How Poppy maps onto Archon

In Poppy, the Personal Agent is a server on an HTTPS domain. Its `client_id` is a
URL on that domain serving its OAuth Client ID Metadata Document, and one signing
key, published at `jwks_uri`, signs every client and Session assertion. Users are
not identified by the agent's keys. The agent gives each User a separate opaque
User ID at each Company, holds a DPoP key per User per Company, and stores the
User's Account Token (refresh token) after sign-in.

An Archon node therefore acts as a Personal Agent on its own domain (archon.social,
a 4tress domain, or any self-hosted node) for the DIDs in its wallet. An Archon DID
is not presented to Companies.

Constraints from the draft that shape the design:

- **Signing algorithm.** The spec mandates none, but the guides say "support ES256
  and RS256, and sign with ES256 when you can", and Ample Computer accepts only
  ES256 or RS256 client assertions. ES256K and EdDSA cannot be relied on.
  Keymaster has no P-256 keys. The agent's long-lived key belongs to the operator,
  not a User, and the guides say to keep it on the server, as Herald already does
  with its persisted ES256 OIDC key (`services/herald/server/src/oauth/index.ts`).
  DPoP keys are ephemeral and unpublished; WebCrypto suffices. Phase 1 therefore
  needs no new Keymaster key type.
- **User IDs.** They MUST NOT contain or be derived from personal information, and
  the guides say a derived ID must start from an internal ID that is itself random.
  A DID is a public identifier shared across Companies, so store a random ID per
  (DID, `auth.issuer`) rather than deriving one from the DID.
- **Secrets.** Account Tokens MUST NOT enter model context, messages, logs, or
  URLs. The guides extend this to Session Tokens, private keys, device codes, and
  one-time codes. No tool output may contain them.
- **Company content.** Everything a Company returns is untrusted data, never
  instructions (§8.1).
- **Trust.** Companies allowlist or block by `client_id`. A self-hosted domain may
  be conformant and still refused.

Live Companies to test against: Stacktree (`https://stacktr.ee`, live since
2026-10-11) and Ample Computer (`https://ample.computer`, live since 2026-10-17).
Both offer signed-out Sessions and an MCP server. Upstream issues relevant to this
work: client assertion `aud` (#2), User ID controls (#11), and DPoP metadata
conflicting with existing MCP clients (#12), in
`personal-agent-protocol/personal-agent-protocol`. Feedback is taken as GitHub
issues there, not only by email.

## Decisions

1. **Placement.** Recommended: a new `services/poppy` behind Drawbridge, under a
   `poppy` Compose profile. Keymaster keeps identity and secrets; the service is the
   OAuth client and transport, the same split agreed for DIDComm sends. Herald is
   the alternative, but Herald is an OAuth provider and this is a client.
2. **Tenancy.** Recommended: single-tenant first, acting only for the node wallet's
   DIDs. A hosted domain serving many Users needs per-User authentication to the
   service and is a later phase.

## Phase 0: spike

Throwaway; not merged as product code.

- Publish a static client metadata document and JWKS on an HTTPS host. Signed-out
  Sessions need no redirect, so a static host suffices.
- Against both live Companies, script: discovery, the issuer and `poppy_domains`
  check (§3.2), client and Session assertions with `aud` set to `auth.issuer`, a
  DPoP signed-out Session including a nonce retry, a Bearer Session Token for the
  MCP server with `resource`, and listing its tools.
- Try ES256K and EdDSA client assertions too, to settle the algorithm question in
  #1395 from real servers.

Gate: a signed-out Session reaches both Companies' MCP servers. Otherwise stop, or
report the failure upstream.

## Phase 1: `services/poppy`

- Public routes through Drawbridge (which forwards only whitelisted upstream
  paths): `/poppy/agent.json`, `/poppy/jwks.json`, `/poppy/callback`.
- ES256 signing key persisted under `./data` with a `kid`. Import with
  `{ extractable: true }` (the Herald persistence bug). Follow the guides on
  rotation: publish a new key before signing with it, keep the old one until its
  assertions expire.
- Discovery through the shared public HTTPS transport that validates connected
  destinations. Follow redirects only to HTTPS, with limits on redirect count,
  response size and time. Cache metadata within bounds.
- Sessions: JWT-bearer signed-out Sessions and renewal (§4.2); DPoP proofs signed
  per request with per-server nonce handling (§4.3); fresh assertion and proof on
  every retry; Bearer tokens only for MCP, scoped by `resource`.
- Sign-in: Direct (PKCE S256, single-use `state`, exact `iss` check) and Device
  (`interval`, `slow_down`). Mediated Sign-In deferred because it handles
  passwords.
- Account Tokens encrypted at rest under the wallet; replaced when the Company
  rotates them, deleted on `invalid_grant`, revoked at sign-out (§4.8, §4.9).
- Internal API protected by `X-Archon-Admin-Key`.
- Tests against an in-repo fake Company: wrong `aud`, swapped `iss`, reused `jti`,
  nonce challenge, `account_mismatch`, `invalid_session`, `rate_limited` with
  `Retry-After`, and secret redaction in logs. An optional live test against
  Stacktree.

## Phase 2: surfaces

- MCP tools: `poppy_discover`, `poppy_start_session`, `poppy_sign_in` (returns a
  link for the User; never handles credentials), `poppy_call` (proxies a Company
  MCP or OpenAPI call and labels the result as untrusted Company content), and
  `poppy_sign_out`. Read-only tools first; writes marked mutating.
- CLI commands in `scripts/archon-cli.js`, `packages/keymaster/src/cli.ts` and
  `python/keymaster/src/keymaster/cli.py`, with MCP mappings, if the feature is
  exposed through the CLI.
- Wallet: a "Connected companies" list with Disconnect. Either the standalone
  clients get it too, or the allowlist in `tests/wallet/ui-capability-parity.test.ts`
  records why not.

## Phase 3: deferred until needed

Conversations (§7), browser sessions (§5), Mediated Sign-In (§4.7), and the
Operations extension.

## Phase 4: verifiable agent identity (optional)

Per-Company `client_id` allowlisting favors large domains. Archon can offer a
verifiable link for self-hosted agents: client metadata naming the node's DID, the
DID document listing the `client_id` and JWKS key, and optionally a credential
vouching for the agent. Poppy declares identity extensible, so this would be an
extension proposal or feedback issue upstream, written after Phases 0–1 and only
with maintainer approval. A recoverable P-256 key in Keymaster may be justified at
that point.

## Risks

- Draft churn before 1.0, possibly incompatible. Keep spec-facing code in one
  module and record the draft version implemented.
- Self-hosted `client_id`s refused in practice. Phase 0 cannot measure this, since
  both test Companies accept unknown agents; Phase 4 is the response.
- Secrets or Company content reaching the model. Treat as design constraints from
  Phase 1, enforced by tests.
