# Move Herald's Personal Agent Protocol support to 0.4 (#1609)

Status: plan for review. Nothing here is built.

Herald serves the [Personal Agent Protocol](https://personalagentprotocol.org/docs/0.4/spec)
(Poppy) at draft 0.2 ([poppy-1395.md](poppy-1395.md), #1403). Upstream published 0.4 on
November 10, 2026 as the 1.0 release candidate. Before 1.0, a Personal Agent uses a
`poppy.json` only if its minor version matches one the agent implements, so an agent on
0.4 cannot use Herald at all.

This is not a field rename. Between 0.2 and 0.4 the protocol moved Sessions out of OAuth,
and most of Herald's Poppy module follows the old shape:

| | Draft 0.2, as Herald has it | 0.4 |
|---|---|---|
| Starting a Session | A `jwt-bearer` grant at the token endpoint returns a Session Token | No step. The first request with a new `sid` starts it |
| Naming the Session on a request | The Session Token, DPoP-bound | A `Poppy-Session` header: a JWT signed for that one request |
| Signing in | Needs a `session_id`; returns a signed-in Session Token and an Account Token | Plain OAuth, knows no Session; returns an access token and a refresh token |
| Finding the issuer | `auth.issuer` in `poppy.json`, confirmed by `poppy_domains` | The domain's protected resource metadata, confirmed by `protected_resources` |

## What changes in Herald

Section numbers are from 0.4.

**Discovery (section 3)**

- `poppy.json`: `protocol_version` becomes `0.4`. `auth.direct` and `auth.device` go;
  `auth.scopes` and `auth.scope_hints` describe the scopes instead (3.1, 4.7).
- New: protected resource metadata at `/.well-known/oauth-protected-resource` on the
  public host, with `resource` exactly `https://{domain}` and the issuer in
  `authorization_servers` (3.2). Drawbridge already forwards all of `/.well-known` to
  Herald.
- Authorization server metadata: `protected_resources` replaces `poppy_domains`, and
  `grant_types_supported` drops `jwt-bearer` (3.2). The sign-in types Herald offers are
  read from that list, no longer from `poppy.json`.

**Sign-in and tokens (section 4)**

- The `jwt-bearer` grant, Session Tokens and `session_id` on token requests are removed.
- The authorization code, device code and refresh grants return an RFC 6749 token
  response: `access_token`, `token_type`, `expires_in`, `refresh_token`, and `scope` when
  fewer scopes were granted than asked. `session_id`, `signed_in` and
  `refresh_token_expires_in` go (4.7).
- A sign-in grants at least one scope and none beyond those asked. If the User approves
  none, it ends as a decline (4.7).
- Client assertions: `ES256` must be accepted and `PS384` should be (4.1). Herald accepts
  `ES256` and `RS256` today.
- Loopback redirect URIs (4.1, 4.2, RFC 8252 §7.3). An agent's `redirect_uris` may list one
  for an app on the User's computer, and the authorization request matches it whatever
  its port. Herald refuses any `redirect_uris` entry that is not HTTPS on the agent's
  domain, and matches redirects exactly, so an agent that lists one cannot be loaded at
  all, for sign-in or for Session verification.
- A sign-in opened on another device follows RFC 10027 §2, as Device Sign-In already must
  (4.2, 10.8). Herald's consent page and the wallet challenge text already name the agent
  and ask the User to continue only if they started it; both need checking against the
  guide's wording.
- Kept as they are: PKCE with S256, `iss` on every redirect, `private_key_jwt` addressed to
  the issuer, revocation, and the device verification link on the issuer's host.

**The Session header (section 5)** — new

- Verifying `Poppy-Session` (5.2, 5.3): fetch the agent's client metadata and keys; verify
  the delegation in `poppy_dlg` (signed by a key from `jwks_uri`, at most 24 hours long)
  and then the Session JWT with the delegated key; check `typ`, `aud` (Herald's issuer),
  `htm`, `htu` and `iat`.
- Joining the header to the access token (5.3, step 3). With a token, `ath` must match it
  and the token must have been issued to the `client_id` in the header's `iss`. A matching
  `ath` alone shows only that the header covers those token bytes, not that both belong to
  one agent; today the two cannot differ, because one Session Token carries both. Without
  a token, `ath` must be absent.
- `Poppy-Version` is checked wherever the Session header is verified. A missing or
  unserved version gets `version_unsupported` (3.4).
- Sessions are found by `client_id`, `sid` and User ID. An unknown combination starts one.

**The API (section 7)**

- A signed-in request carries an access token and the Session header, and no longer a
  Session Token.
- Errors change. A request that needs the account and has no token gets `401` with a
  challenge naming the scopes, which replaces `403 sign_in_required`. Session failures are
  `400 invalid_session` or `400 session_ended` in a JSON body. A rate-limited request gets
  `429` with `Retry-After`; the `rate_limited` error code is gone (5.6).
- A token for a different account than the Session used before may be refused with
  `session_ended`, which replaces `account_mismatch` (5.4).

**Unchanged**

- The account settings page that lists and disconnects agents.
- Herald's OIDC issuer at `/names`. The Poppy issuer stays at `/names/poppy`.

## Not in this plan

- An MCP interface (#1404), which follows this.
- Conversations (section 8), browser join (section 6), tasks and feedback (section 9),
  extensions (3.3) and operator signatures (5.3). `poppy.json` needs one of `agent`,
  `apis` or `web`, and Herald keeps listing only `apis`.

## Decisions needed

1. **Which version to build.** Recommended: 0.4 now. It is the release candidate, and the
   1.0 draft so far only adds clarifications. When 1.0 is published Herald moves again,
   since 0.4 and 1.0 differ in major version; the version stays in one constant.
   The alternative is to wait for 1.0 and leave Herald unusable by current agents until
   then.

2. **Whether to keep serving 0.2 beside 0.4.** Recommended: no. `supported_versions`
   allows it, but it means running both token endpoints and both API authentications, and
   no agent is known to use Herald at 0.2. Existing grants survive either way: an Account
   Token is a refresh token, and still works at the refresh grant.

3. **Whether Herald verifies the Session header.** The spec lets an endpoint that uses no
   Session claims accept the header without verifying it, and says Companies should verify
   it on every request that carries it (5.3).
   - *Verify (recommended).* Herald knows which agent and User each request is from,
     signed in or out, can limit agents individually, and can bind a Session to one
     account. This is the larger half of the work: the delegation and Session JWT checks,
     a Session record, and the three Session errors.
   - *Accept without verifying.* Signed-out lookups become anonymous public reads, limited
     only by Drawbridge's per-source limits, and signed-in requests rest on the access
     token alone. Much less code, and still conforming.

4. **Whether access tokens stay DPoP-bound.** Recommended: yes. Binding is the Company's
   choice in 0.4 (4.5), Herald already implements and tests it, and it keeps a copied
   token useless. An agent without DPoP support could then not sign in to Herald.

5. **What the scopes are called.** 0.4 no longer defines `poppy:read` and `poppy:write`,
   or reserves the `poppy:` prefix; each Company names its own. Recommended: rename to
   `profile:read` and `name:write`, described in `auth.scopes` with `scope_hints`
   (`profile:read`: no changes, personal data; `name:write`: irreversible, personal data,
   because releasing a name revokes the membership credential and frees the name for
   someone else).
   Grants issued under the old names would be read as the new ones.

6. **Which issuers the domain's protected resource metadata lists.** Recommended: the
   Poppy issuer only, so `auth.issuer` is not needed and every agent finds the same one.
   Herald's OIDC issuer at `/names` is not an authorization server for this resource.

## Delivery

Poppy is off unless `ARCHON_HERALD_POPPY_ENABLED=true`. Each PR leaves `main` consistent.

| PR | Delivers |
|---|---|
| 1 | Session header verification as its own module, with tests: delegations, the Session JWT checks, `Poppy-Version`. Nothing calls it yet |
| 2 | The switch to 0.4: `poppy.json`, the protected resource and authorization server metadata, the token endpoint without Sessions, the API on access tokens and the Session header, and the new errors. The 0.2 Session grant and Session Tokens are removed |
| 3 | The Herald README, this plan's status, and the store records 0.2 no longer needs |

With decision 3 answered "accept without verifying", PR 1 is dropped and PR 2 shrinks.

## Testing

- Unit tests for the verifier with real signed JWTs: a valid delegation and Session JWT,
  and each refusal (wrong `typ`, `aud`, `htm`, `htu`, `ath`, an expired or over-long
  delegation, a Session JWT signed directly with a `jwks_uri` key, a `kid` that is not the
  delegated key's thumbprint, an access token issued to another agent, and an `ath` on a
  signed-out request).
- Loopback redirects: a listed loopback URI matched on another port, and a refused HTTP
  redirect that is not loopback.
- Route tests through the real router for discovery, each grant, revocation, and each API
  error in the table of section 7.
- An end-to-end test with a test agent that discovers Herald the way 5.3 and 3.2 describe,
  signs in with each grant, and calls the API signed out and signed in.
- Upstream publishes an implementation kit for Companies, with a checklist
  (`kit/company`, `skills/implement-personal-agent-protocol`). The work is checked against
  it before each PR.

## Risks

- **1.0 may still change.** Keeping the Poppy code in its own module, as now, limits what a
  further move touches.
- **Client metadata fetches.** Verifying a Session header fetches from a URL the caller
  names. Herald already does this for client assertions, with address checks and a budget
  for unknown `client_id` values; signed-out API requests would now reach that path
  without any prior authentication, so the same limits must cover them.
- **Sign-in is security-sensitive.** The existing tests for assertions, DPoP, PKCE and
  revocation stay, and are extended, not rewritten.
