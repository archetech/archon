# Personal Agent Protocol support (#1395)

Status: proposed; nothing built. Based on Draft 0.1 of the
[specification](https://personalagentprotocol.org/docs/spec), the
[guides](https://personalagentprotocol.org/docs/guides) and the Company
implementation kit, as read on 2026-10-18.

## Direction

Archon implements Poppy as a **Company**, not as a Personal Agent. A Herald domain
such as archon.social publishes a `poppy.json`, and Personal Agents (ChatGPT- or
Meta-style products) can use Archon on their Users' behalf: look up names, resolve
DIDs and verify proofs while signed out, and manage the User's Herald account once
the User signs in with their Archon wallet.

Why not the Personal Agent side: it is generic OAuth-client plumbing that uses none
of Archon's machinery; the named Personal Agent partners are OpenAI and Meta, whose
products would speak Poppy themselves; Companies allowlist agents by `client_id`, so
an unknown domain is likely held to guest access; and a hosted agent would hold every
User's refresh tokens for their other accounts. The Company side gives Archon reach
into those agents through the channel Companies are adopting, and builds on what
Herald already runs: wallet sign-in, an OAuth/OIDC provider with a persisted ES256
key, public pages behind Drawbridge, and name and profile APIs.

Two live Companies show the expected shape. Stacktree (`stacktr.ee`, live since
2026-10-11) and Ample Computer (`ample.computer`, live since 2026-10-17) both offer
signed-out Sessions, Direct Sign-In and Account Tokens, and expose an MCP server
(Stacktree also an OpenAPI description). Neither implements Device or Mediated
Sign-In, browser sessions, conversations, or extensions.

## How Poppy maps onto Herald

| Poppy | Herald |
| --- | --- |
| Company | One Herald domain. Each node's Herald is a separate Company. |
| `auth.issuer` | A dedicated issuer, e.g. `https://<domain>/names/poppy`, kept apart from Herald's existing OIDC issuer (`/names`) so Poppy's metadata cannot change how existing OIDC relying parties behave. Ample Computer did the same after Stacktree reported the conflict (upstream #12). |
| Account | A DID registered with Herald. A Session is signed in to at most one DID (§4.4). |
| Signing in | Herald's existing wallet challenge: the User scans or opens the challenge in their Archon wallet and Herald verifies the response. The User's keys never leave the wallet. |
| Personal Agent | Any `client_id` URL serving client metadata and a JWKS; verified on each Session start. |
| User ID | Opaque `sub` chosen by the agent; stored with the Session, never shown or linked to the DID until the User signs in. |

Mediated Sign-In does not apply: Archon accounts have no passwords to submit.

Writes that need the User's own signature (creating DIDs, issuing credentials,
updating DID documents) cannot be performed by the Company, because the keys live in
the User's wallet. They stay out of scope unless a later flow has the wallet approve
each operation; the Operations extension is the place to evaluate that.

## Decisions

1. **What Personal Agents can do.** Recommended starting set:
   - Signed out (what any website visitor can do): look up a name, read a public
     member profile, resolve a DID through Gatekeeper, read the directory.
   - Signed in, `poppy:read`: the User's profile and name, and their Herald
     membership credential.
   - Signed in, `poppy:write`: claim, change or release the User's name.
   - Candidates to decide on: verifying a credential or challenge response for an
     agent (useful, but makes Herald a verification service), and sending email
     through the Herald bridge (abuse and spoofing risk).
2. **Interface type.** Recommended: OpenAPI first, then MCP. Every listed API must
   accept Session Tokens (§6): DPoP for OpenAPI, Bearer for MCP. Archon's
   `@didcid/mcp-server` is a local stdio server over the User's wallet, so the MCP
   API would be a new remote Streamable HTTP server with RFC 9728 protected resource
   metadata, not that package.
3. **Agent policy.** Recommended: accept any `client_id` (no registration), with
   per-`client_id` and new-client rate limits as the guides suggest for guest
   access.
4. **State.** Sessions, Account Token records, `jti` replay and DPoP nonces need
   expiring shared state. Herald's default store is a JSON file
   (`ARCHON_HERALD_DB=json`); recommended to use Redis, already in the core stack,
   for replay and nonces.

## Milestones

The milestones follow the kit's validator (`kit/company/validate` in
`personal-agent-protocol/personal-agent-protocol`), which acts as a test Personal
Agent and checks each milestone against a live deployment. Each milestone is done
when the validator reports no MUST failures for it on a test deployment.

### 1. Foundation

- `/.well-known/poppy.json` on the Herald domain. `organization.domain` is the serving host after
  redirects. List only what is live.
- RFC 8414 metadata for the Poppy issuer at
  `/.well-known/oauth-authorization-server/names/poppy`, with `poppy_domains`,
  `token_endpoint`, `revocation_endpoint` and `dpop_signing_alg_values_supported`
  including ES256. Drawbridge already forwards all of `/.well-known` to Herald.
- Agent verification: fetch the `client_id` URL without following redirects through
  the shared destination-validating HTTPS transport (`packages/common/src/net-node.ts`),
  with size and time limits; check `client_id`, and that `jwks_uri` and
  `redirect_uris` are HTTPS on the same domain; cache within bounds; refetch on an
  unknown `kid` at most once per key URL per interval, counting failures (Ample
  Computer's report).
- Token endpoint: JWT-bearer grant with `private_key_jwt` client assertion and DPoP
  Proof; both assertions verified against the agent's JWKS with `aud` equal to the
  issuer as a single string; reused `jti` rejected; signed-out Session Tokens with a
  lifetime of hours; renewal by `session_id`; `scope` and `resource` accepted; OAuth
  error codes from §4.2.
- DPoP verification per RFC 9449 §4.3, with optional nonces.

### 2. Interfaces

- OpenAPI 3.1 description of the agreed API subset, listed in `apis`.
- Middleware on those Herald routes accepting DPoP Session Tokens, passing the
  verified `client_id`, User ID, account and scopes to the handlers; errors in
  `WWW-Authenticate` (`invalid_token`, `sign_in_required`, `insufficient_scope`).
  Existing cookie and Bearer authentication for Herald's own clients is unchanged.
- Signed-out Sessions allowed exactly what a signed-out visitor can do.
- Later: the remote MCP server, Bearer tokens issued only for its `resource`, and
  protected resource metadata naming the Poppy issuer.

### 3. Sign-in

- Direct Sign-In: authorization code with PKCE (S256 only), exact `redirect_uri`
  match against the agent's metadata, `iss` on every redirect (RFC 9207). The
  consent page shows the agent's name, logo and `client_id` domain, and each
  requested scope as a choice; the User signs in with the wallet challenge.
- Device Sign-In: device authorization request with client assertion; verification
  page with the same consent; polling with `authorization_pending`, `slow_down`,
  `access_denied`, `expired_token`. Opening the link must not approve by itself.
  This suits the wallet's scan-to-sign-in flow.
- Account Tokens: refresh grant with client assertion and DPoP; accepted only from
  the issuing `client_id`; `scope` may narrow only; `account_mismatch` when a
  Session was signed in to another DID; revocation endpoint.
- Account settings in Herald's UI: list the agents connected to the User's DID and
  let the User disconnect each one.

### Later, on demand

Conversations (§7) with a Company Agent, browser sessions (§5), and the Operations
extension for wallet-approved writes.

## Testing

- Unit and route tests in `tests/herald` with a fake Personal Agent: wrong `aud`,
  redirecting or cross-domain client metadata, reused `jti`, nonce challenge,
  token reuse across `client_id`s, `account_mismatch`, scope narrowing, and secret
  redaction in logs.
- The kit validator against a test deployment for each milestone.
- An implementation report filed upstream once milestone 3 passes, if the
  maintainer agrees.

## Upstream identity feedback (parallel, optional)

Poppy's trust in an agent stops at its domain, and delegation stays inside each
Company. Archon's DIDs and credentials could supply what is missing: client
metadata naming the agent's DID, a DID document listing the `client_id` and JWKS
key, and credentials vouching for an agent or for a User's delegation. Poppy
declares identity extensible. Any proposal goes upstream as a feedback issue or
extension only with maintainer approval, preferably after milestone 1 gives it an
implementation behind it.

## Risks

- Draft churn before 1.0, possibly incompatible. Keep the Poppy code in its own
  Herald module and record the draft version implemented.
- Abuse of guest access by anonymous agents. Rate-limit by `client_id`, by User ID
  and by Session.
- Unauthenticated requests making Herald fetch remote metadata. Throttle fetches
  and validate destinations at connection time.
- Confusing Poppy's issuer with Herald's OIDC issuer. Keep them separate and test
  that existing OIDC sign-in is unaffected.
