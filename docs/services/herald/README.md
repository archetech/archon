# Archon Herald — Service Specification

Language-agnostic contract for **Herald** — the Archon name service.
Users prove DID ownership via challenge-response, claim a short
`@name` handle, receive a verifiable credential attesting to their
membership, and are published to a directory served as JSON, IPNS,
LUD-16, WebFinger, and OIDC.

The canonical implementation is
[services/herald/server/](../../../services/herald/server/).

> **Related specs.** Herald is a Keymaster client end-to-end. Its
> challenge-response auth uses Keymaster's
> [`createChallenge`/`verifyResponse`](../keymaster/README.md#93-challenges-and-responses);
> its credential issuance uses
> [`bindCredential`/`issueCredential`/`updateCredential`/`revokeCredential`](../keymaster/README.md#9-credentials-and-challenges).
> When fronted by [Drawbridge](../drawbridge/README.md), Herald's
> `/.well-known/*` and `/api/*` are reached through Drawbridge's
> `/.well-known/*` and `/names/*` mounts respectively (see
> [Drawbridge spec §2.1](../drawbridge/README.md#21-public-routes-no-auth)).

---

## 1. Service responsibilities

Herald is a single-tenant naming authority. One instance owns one
namespace and serves:

1. **Login flow** — the user scans a QR pointing at a wallet URL with a
   challenge query param; the wallet returns a response DID; Herald
   verifies it via Keymaster and stores the resulting authenticated DID
   in an Express session.
2. **Name claim / release** — authenticated users claim a unique
   `@name` (3-32 chars, `[a-z0-9-_]i`); the name is recorded on the
   Herald's local user database and a verifiable credential is issued
   and stored as an asset DID owned by the Herald's service identity.
3. **Public registry** — the full `name → DID` directory is served as
   JSON at `/api/registry`, `/directory.json`, and `/.well-known/names`.
   Optionally published to IPNS for decentralized resolution.
4. **Lookup adapters** — every name is reachable via:
   - `GET /api/name/:name` — JSON `{ name, did }`
   - `GET /api/member/:name` — full resolved DID document
   - `GET /api/name/:name/avatar` — PNG/JPEG bytes of the user's
     avatar (asset DID linked from their profile)
   - `GET /.well-known/lnurlp/:name` + `GET /api/lnurlp/:name/callback`
     — full LUD-16 Lightning address (delegates to the user's DID's
     Lightning service entry)
   - `GET /.well-known/webfinger?resource=acct:name@domain` — RFC 7033
     WebFinger
5. **OAuth 2.0 / OIDC** — `/oauth/authorize`, `/oauth/token`,
   `/oauth/userinfo`, `/oauth/.well-known/jwks.json`, plus discovery at
   `/.well-known/openid-configuration`. ES256-signed JWTs.
6. **Owner admin** — a single `ARCHON_HERALD_OWNER_DID` has admin
   privilege: list users, delete users, trigger IPNS publication.

The service holds either a full Keymaster wallet (standalone mode) or
a Keymaster client connection (shared mode); see [§4](#4-keymaster-binding).

---

## 2. HTTP API contract

Single Express app on `${ARCHON_HERALD_PORT}` (default `4230`).
Sessions cookie-based via `express-session`. Routes are split into
several namespaces:

### 2.1 Health, config, version

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/version` | `1` (the literal integer). Stable schema version of the API. |
| `GET` | `/api/config` | `{ serviceName, serviceDomain, publicUrl, walletUrl }`. |

### 2.2 Login (challenge-response)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/challenge` | Creates a Keymaster challenge, stores it on the session, returns `{ challenge, challengeURL }`. `challengeURL` is `<walletUrl>?challenge=<DID>`. |
| `GET` | `/api/login?response=<DID>` | Verifies the response DID via Keymaster `verifyResponse({ retries: 10 })`. On match, sets `session.user = { did }` and returns `{ authenticated: true }`. |
| `POST` | `/api/login` | Same as GET but takes `{ response }` in the JSON body. |
| `POST` | `/api/logout` | Destroys the session. Returns `{ ok: true }`. |
| `GET` | `/api/check-auth` | `{ isAuthenticated, userDID, isOwner, profile }`. |

### 2.3 Profile & names (session auth)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/users` | Authenticated. Returns `string[]` of all known DIDs. |
| `GET` | `/api/profile/:did` | Authenticated. Returns the user's profile. |
| `GET` | `/api/profile/:did/name` | Authenticated. Returns `{ name }`. |
| `PUT` | `/api/profile/:did/name` | Owner-of-`:did` only. Body: `{ name }`. Validates, claims, issues credential. |
| `DELETE` | `/api/profile/:did/name` | Owner-of-`:did` only. Releases name + revokes credential. |
| `GET` | `/api/credential` | Authenticated. Returns the caller's `{ hasCredential, credentialDid, credentialIssuedAt, credential }`. |

### 2.4 Stateless name management (Bearer token)

For programmatic clients that already hold a verified Keymaster
challenge response.

| Method | Path | Notes |
| --- | --- | --- |
| `PUT` | `/api/name` | Body: `{ name }`. Auth: `Authorization: Bearer <responseDid>` — Herald calls `keymaster.verifyResponse(responseDid)` itself. Returns `{ ok, name, did, credentialDid, credentialIssuedAt, credential }`. |
| `DELETE` | `/api/name` | Bearer auth. Releases the caller's name + revokes credential. |

### 2.5 Public lookups (no auth)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/registry` | `{ version: 1, updated, names: { "<name>": "<DID>" } }`. |
| `GET` | `/directory.json` | Same as `/api/registry`. Convention for IPNS publication. |
| `GET` | `/api/name/:name` | `{ name, did }` or 404 `{ error: "Name not found" }`. |
| `GET` | `/api/member/:name` | Full `DidCidDocument` of the named member, fetched via Keymaster. |
| `GET` | `/api/name/:name/avatar` | Binary image bytes; sets `Content-Type` to a safe-listed image MIME (`image/png`, `image/jpeg`, `image/webp`, `image/gif`); strips other types. |

### 2.6 LUD-16 Lightning address

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/.well-known/lnurlp/:name` | Standard LUD-06 metadata: `{ tag: "payRequest", callback, minSendable, maxSendable, metadata }`. minSendable=1000 msats, maxSendable=100000000000 msats (100k sats). Errors as `{ status: "ERROR", reason }`. |
| `GET` | `/api/lnurlp/:name/callback?amount=<msats>` | Resolves the named member's DID, follows the `Lightning` service entry, requests an invoice, normalizes the response to LUD-06 `{ pr, routes }`. Onion endpoints routed via `ARCHON_HERALD_TOR_PROXY` if set. |

### 2.7 WebFinger and well-known

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/.well-known/names` | Same as `/api/registry`. |
| `GET` | `/.well-known/names/:name` | Same as `/api/name/:name`. |
| `GET` | `/.well-known/webfinger?resource=acct:name@domain` | RFC 7033. `domain` MUST equal `ARCHON_HERALD_DOMAIN` (when set). Returns a JRD with `subject`, `aliases: [<DID>]`, and `links`. |
| `GET` | `/.well-known/openid-configuration` | OIDC discovery; advertises `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`, `/oauth/.well-known/jwks.json`. |

### 2.8 OAuth 2.0 / OIDC (`/oauth`)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/oauth/authorize` | Authorization Code with PKCE flow. Triggers Herald login if the user isn't authenticated, then redirects with `?code=<authcode>` to the registered `redirect_uri`. |
| `POST` | `/oauth/callback` | Internal — completes the authorization code exchange started by `/oauth/authorize`. |
| `GET` | `/oauth/poll` | Polling endpoint for desktop / native flows. |
| `POST` | `/oauth/token` | Exchange `code` (or `refresh_token`) for an `access_token` + `id_token`. Form-encoded body. |
| `GET` | `/oauth/userinfo` | Bearer-token-protected. Returns `{ sub, name, preferred_username, picture }`. |
| `GET` | `/oauth/.well-known/jwks.json` | The Herald's ES256 public signing key. |
| `POST` | `/oauth/clients` | Internal client registration — present in the reference but locked down by deployment policy. |

ID tokens are signed with **ES256**. The signing keypair is generated
on first startup and persisted at
`${ARCHON_HERALD_DATA_DIR}/oauth-signing-key.json` (as a JSON-encoded
private JWK with `kid`). `kid` defaults to
`archon-social-signing-key-1`. Implementations MUST persist the key —
rotating it invalidates all outstanding sessions.

### 2.9 Admin (owner-only)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/admin` | Owner. Admin dashboard payload. |
| `POST` | `/api/admin/publish` | Owner. Publishes the current registry to IPNS. Returns `{ ok, cid, name, gateway }`. |
| `DELETE` | `/api/admin/user/:did` | Owner. Removes the user record + revokes their credential. |

The owner is the single DID in `ARCHON_HERALD_OWNER_DID`. There is no
finer-grained role system.

### 2.10 Bypass & CORS

- `morgan('dev')` HTTP request logging.
- `express.json()` (default 100kB limit).
- `express.urlencoded({ extended: true })` — required for OAuth token
  requests which use form encoding.
- `cors()` is per-route. Login routes use a per-request `corsOptions`
  closure that whitelists the configured wallet origin and credentials.
- Sessions: `httpOnly`, `secure: 'auto'` (HTTPS proxies set `secure`),
  `sameSite: 'lax'`.

### 2.11 Error envelope

`application/json` `{ "error": "<message>" }` for most failures. Login
endpoints return `{ authenticated: false }` on a non-match (200, not
401) so the wallet can poll cleanly. LUD-16 errors return `{ status:
"ERROR", reason }` per the LUD-06 spec rather than HTTP error codes.

---

## 3. Authentication model

### 3.1 Session auth (browser)

1. Frontend calls `GET /api/challenge`. Herald creates a Keymaster
   challenge, stores it on the session, returns
   `{ challenge, challengeURL }`.
2. Frontend renders `challengeURL` as a QR (or deep link). The user
   scans into their Archon wallet.
3. Wallet calls `keymaster.createResponse(challenge)` and POSTs the
   resulting DID back to `/api/login`.
4. Herald calls `keymaster.verifyResponse(response, { retries: 10 })`.
   On match, sets `session.user = { did: verify.responder }`.
5. Subsequent calls use the session cookie. `session.user.did` is the
   authenticated identity. `session.user.did === ARCHON_HERALD_OWNER_DID`
   grants admin scope.

### 3.2 Bearer auth (programmatic)

For tools that don't want sessions, send the response DID as a Bearer
token:

```
Authorization: Bearer did:cid:<response DID>
```

Herald calls `keymaster.verifyResponse(<token>)` on every request
(no caching). Used by `/api/name PUT/DELETE`. The response DID is
single-use server-side caching is not part of the spec — clients that
expect to make many calls SHOULD cache the response DID until it
expires.

### 3.3 OAuth bearer

Access tokens issued by `/oauth/token` are random opaque strings
backed by an in-memory map (or persistent store in production).
ID tokens are ES256 JWTs. Both expire per the standard
`expires_in` field returned in the token response (default 3600 s).

---

## 4. Keymaster binding

Herald operates in one of two mutually-exclusive modes; the boot
sequence picks based on env:

### 4.1 Shared keymaster (HTTP client)

Set `ARCHON_HERALD_KEYMASTER_URL` to the Keymaster's URL. Herald
constructs a `KeymasterClient` and calls Keymaster's HTTP API for
every wallet operation (challenge, response verification, asset
creation, credential issuance / revocation).

This is the recommended deployment mode in a multi-service stack.

### 4.2 Standalone wallet (in-process)

Leave `ARCHON_HERALD_KEYMASTER_URL` empty and set
`ARCHON_HERALD_WALLET_PASSPHRASE`. Herald instantiates a
`Keymaster` object backed by a JSON wallet file at
`${ARCHON_HERALD_DATA_DIR}/wallet.json` and a Gatekeeper HTTP client
at `ARCHON_GATEKEEPER_URL`. The passphrase decrypts the wallet
in-process (see [Keymaster spec §3.1](../keymaster/README.md#31-at-rest-encryption)).

This mode is suitable for single-purpose Herald deployments that
don't need the full Keymaster service surface.

### 4.3 Service identity

On startup Herald ensures a Keymaster ID exists with the name
`ARCHON_HERALD_NAME` (default `name-service`). If the wallet doesn't
have it, Herald creates it (`keymaster.createId(name)`). The
resulting DID is the Herald's "service identity" — it owns every
issued credential.

Herald also calls `keymaster.setCurrentId(<service name>)` at every
credential issue / revoke to ensure the operation is signed by the
right identity, and restores the previous current ID on completion
where possible.

---

## 5. Name validation and lifecycle

### 5.1 Validation rules

- Length: 3–32 chars (after trim).
- Allowed characters: `[A-Za-z0-9_-]` (case-preserved when stored,
  but lookups are lowercase).
- Names are case-insensitive: claim `Alice`, lookup matches `alice`.
- A DID can hold at most **one** name at a time. Claiming a new name
  releases the previous claim (and revokes the previous credential).
- A name is unique: claiming a name already held by another DID
  returns HTTP 409 `{ ok: false, message: "Name already taken" }`.
- A user can re-claim their own name (idempotent).

### 5.2 Credential issuance

When `PUT /api/name` (or `/api/profile/:did/name`) succeeds:

1. Herald sets the current ID to the service identity.
2. If the user already has a `credentialDid` (renaming):
   - Fetch the existing VC.
   - Update `credentialSubject.name` to `<newName>@<serviceDomain>`.
   - Set `validFrom = now`.
   - `keymaster.updateCredential(credentialDid, vc)`.
3. Otherwise (first claim):
   - `boundCredential = keymaster.bindCredential(<userDid>, { schema:
     ARCHON_HERALD_MEMBERSHIP_SCHEMA_DID, validFrom: now, claims: {
     name: "<name>@<serviceDomain>" } })`.
   - `credentialDid = keymaster.issueCredential(boundCredential)`.
   - Persist `{ credentialDid, credentialIssuedAt }` on the user record.

### 5.3 Credential revocation

On `DELETE /api/name` or rename-displacement:

```
keymaster.revokeCredential(credentialDid)
delete user.name; delete user.credentialDid; delete user.credentialIssuedAt
```

Failures during `revokeCredential` are logged but don't roll back the
local user-record update. Revoking is idempotent on the Keymaster
side.

### 5.4 Default schema

If `ARCHON_HERALD_MEMBERSHIP_SCHEMA_DID` is unset, Herald falls back to
`did:cid:bagaaieravnv5onsflewvrz6urhwfjixfnwq7bgc3ejhlrj2nekx75ddhdupq`,
a published schema for `{ name: string }`. Operators MAY substitute
their own schema DID; the credential's `credentialSchema.id` is
whatever was passed.

---

## 6. Storage backends

User database backs `User` records keyed by DID. Three implementations:

| Backend | Path | Selector |
| --- | --- | --- |
| JSON file | `${ARCHON_HERALD_DATA_DIR}/db.json` | `ARCHON_HERALD_DB=json` (default) |
| SQLite | `${ARCHON_HERALD_DATA_DIR}/db.sqlite` | `ARCHON_HERALD_DB=sqlite` |
| Redis | namespace `${ARCHON_HERALD_NAME}:` | `ARCHON_HERALD_DB=redis` |

`User` shape:

```jsonc
{
  "firstLogin":  "<RFC 3339>",
  "lastLogin":   "<RFC 3339>",
  "logins":      <int>,
  "name":        "<lowercase ASCII>",
  "credentialDid":      "<DID>",
  "credentialIssuedAt": "<RFC 3339>",
  // arbitrary additional fields are allowed; readers MUST tolerate them
}
```

Every backend implements:

```ts
interface DatabaseInterface {
  init?(): Promise<void>;
  close?(): Promise<void>;
  getUser(did: string): Promise<User | null>;
  setUser(did: string, user: User): Promise<void>;
  deleteUser(did: string): Promise<boolean>;
  listUsers(): Promise<Record<string, User>>;
  findDidByName(name: string): Promise<string | null>;
}
```

`findDidByName` is a case-insensitive lookup; implementations MAY
normalize to lowercase at index time. Concurrency: writes MUST be
atomic from the point of view of `findDidByName` — uniqueness checks
are a load-modify-save pattern that needs serialization (the JSON
backend uses an async-promise lock per AbstractBase).

---

## 7. IPNS publication

`POST /api/admin/publish` (owner-only) builds the registry, pins it
to IPFS via `${ARCHON_HERALD_IPFS_API_URL}` (default
`http://localhost:5001/api/v0`), and updates the IPNS record under the
key `ARCHON_HERALD_IPNS_KEY_NAME` (default `ARCHON_HERALD_NAME`).

The IPNS key is created on startup if missing. The published JSON is
identical to `/directory.json` — clients can fetch it via any IPFS
gateway at `ipns://<key-id>/`.

---

## 8. Lifecycle and configuration

### 8.1 Startup

1. Validate `ARCHON_HERALD_SESSION_SECRET` is set and not a placeholder.
2. Bind HTTP listener.
3. Initialize the database backend.
4. Construct Keymaster (shared HTTP client or in-process, see §4).
5. `initServiceIdentity()` — ensure the service ID exists; log the
   service DID.
6. `ensureIpnsKeyExists()` — generate the IPNS key if missing.
7. Mount OAuth router at `/oauth`.

### 8.2 Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHON_HERALD_PORT` | `4230` | HTTP listen port. |
| `ARCHON_HERALD_NAME` | `name-service` | Service identity name (Keymaster ID). Owns issued credentials. |
| `ARCHON_HERALD_DOMAIN` | empty | Domain for credential subjects (`<name>@<domain>`) and WebFinger validation. |
| `ARCHON_HERALD_DB` | `json` | `json` / `sqlite` / `redis`. |
| `ARCHON_HERALD_DATA_DIR` | `/app/server/data` | Filesystem root for JSON / SQLite / OAuth signing key. |
| `ARCHON_HERALD_SESSION_SECRET` | unset (**required**) | Secret for Express sessions. MUST NOT be a placeholder string. |
| `ARCHON_HERALD_OWNER_DID` | empty | Single owner DID with admin scope. |
| `ARCHON_HERALD_KEYMASTER_URL` | empty | When set, runs in shared mode. |
| `ARCHON_HERALD_WALLET_PASSPHRASE` | empty | Required for standalone mode; ignored in shared mode. |
| `ARCHON_HERALD_WALLET_URL` | `https://wallet.archon.technology` | URL embedded in `challengeURL` so wallets know where to load. |
| `ARCHON_HERALD_IPFS_API_URL` | `http://localhost:5001/api/v0` | Kubo HTTP API for IPNS publication. |
| `ARCHON_HERALD_IPNS_KEY_NAME` | `${ARCHON_HERALD_NAME}` | IPNS key name. |
| `ARCHON_HERALD_MEMBERSHIP_SCHEMA_DID` | `did:cid:bagaaieravnv5o...` | Schema DID for issued membership credentials. |
| `ARCHON_HERALD_TOR_PROXY` | empty | SOCKS5 proxy `host:port` for `.onion` Lightning lookups. |
| `ARCHON_HERALD_JWT_KEY_PATH` | `${DATA_DIR}/oauth-signing-key.json` | Persisted ES256 OAuth signing key. |
| `ARCHON_GATEKEEPER_URL` | `http://localhost:4224` | Used in standalone mode. |
| `ARCHON_DRAWBRIDGE_PORT` | `4222` | Used to compute `PUBLIC_URL`. |
| `ARCHON_DRAWBRIDGE_PUBLIC_HOST` | `http://localhost:${DRAWBRIDGE_PORT}` | External canonical URL of the Drawbridge that fronts this Herald; used to build `PUBLIC_URL = <host>/names`. |
| `ARCHON_ADMIN_API_KEY` (or `ARCHON_HERALD_ADMIN_API_KEY`) | empty | Used by the Keymaster client when in shared mode. |

### 8.3 Public URL convention

`PUBLIC_URL = ${ARCHON_DRAWBRIDGE_PUBLIC_HOST}/names` — used in:
- The OAuth issuer URL.
- The LUD-06 callback URL.
- The OIDC `iss` claim.

Drawbridge proxies `/names/*` → Herald's `/api/*`, so external callers
hit `https://your-domain.example/names/api/login` etc.

### 8.4 Shutdown

No explicit handler. SIGTERM / SIGINT terminate the Express server.
The OAuth signing key and IPNS key persist on disk.

---

## 9. Logging conventions

`morgan('dev')` for HTTP requests; otherwise `console.log` /
`console.error`. No structured logger by default. Notable startup
lines:

- `<service-name>: <serviceDID>`
- `Owner: <ownerDid>` (or warning if unset)
- `<service-name> using keymaster at <url>` (shared mode)
- `<service-name> using gatekeeper at <url>` (standalone mode)
- `<service-name> using wallet at <walletUrl>`
- `<service-name> listening on port <port>`

---

## 10. Reference implementation and tests

- Source: [services/herald/server/](../../../services/herald/server/)
- DB backends: [src/db/](../../../services/herald/server/src/db/)
- OAuth: [src/oauth/index.ts](../../../services/herald/server/src/oauth/index.ts)
- Image: built per [services/herald/Dockerfile](../../../services/herald/Dockerfile)
- README: [services/herald/README.md](../../../services/herald/README.md)

Validation: end-to-end against a running Herald + Drawbridge stack.
There is no dedicated unit test suite; the React frontend at
[apps/herald-client/](../../../apps/herald-client/) and the
[scripts/](../../../services/herald/scripts/) directory exercise the
contract.

A conformant third implementation MUST:

- Honor the route table in [§2](#2-http-api-contract), including the
  exact response shapes and the LUD-06 error envelope.
- Implement the challenge-response flow in [§3.1](#31-session-auth-browser)
  against the Keymaster's `createChallenge`/`verifyResponse` API.
- Validate names per [§5.1](#51-validation-rules) (length, charset,
  case-insensitivity, single-name-per-DID).
- Issue + revoke credentials through Keymaster's
  `bindCredential`/`issueCredential`/`updateCredential`/`revokeCredential`.
- Persist user records via the `DatabaseInterface` shape in
  [§6](#6-storage-backends), with atomic `findDidByName`.
- Persist the OAuth ES256 signing key on disk; rotation invalidates
  all outstanding tokens.
- Refuse to start when `ARCHON_HERALD_SESSION_SECRET` is empty or a
  known placeholder (`change-me`, `change-me-to-a-random-string`).
- Ensure the service identity exists in Keymaster on startup
  (creating it if necessary).
