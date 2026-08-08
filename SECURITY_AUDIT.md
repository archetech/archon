# 🔒 Archon Security Audit Report — August 2026

**Date:** August 8, 2026
**Scope:** Full repository — `archetech/archon`, branch `main` @ `daf2c2accee5640bd49fe64ca74b28cf6c8b1db2` (2026-08-05)
**Auditor:** Morningstar (automated + manual review)
**Supersedes:** February 2026 audit (branch `release-0.2`; retained in git history) — 569 commits since
**Distribution:** Public — filed in-repo, superseding the previous in-repo report. Unfixed findings below (H-01, H-02, H-03) describe default-configuration weaknesses that are already evident from the shipped `sample.env` and compose files; they are disclosed here so operators can harden their deployments. Report anything new privately per [`SECURITY.md`](SECURITY.md) rather than in a public issue.

---

## Methodology & Tools (all outputs verified)

| Tool | Version | Coverage | Result |
|------|---------|----------|--------|
| gitleaks | 8.24.3 | Full git history (1,992 commits, 25.35 MB) | 13 findings — **all verified false positives** |
| npm audit | npm 11.8.0 | Root workspace lockfile | 30 vulns: 1 critical, 17 high, 5 moderate, 7 low |
| semgrep | latest (uv) | `p/owasp-top-ten` + `p/security-audit`, excl. node_modules/tests | 38 findings — triaged below |
| Manual review | — | Auth middleware, L402/macaroon, OAuth, extension messaging, cipher, docker | See findings |

---

## Executive Summary

Archon has grown substantially since the Feb 2026 audit: Drawbridge (L402 Lightning paywall gateway), Herald (DID-based OAuth/email service), DIDComm relay, vault/dmail/nostr/lightning Keymaster routers, plus Rust and Python service ports. **569 commits** landed since the prior audit baseline.

The most serious new finding was a **complete L402 paywall bypass** in Drawbridge: a stub subscription-auth middleware accepted any `X-Subscription-DID` header as authenticated, skipping all payment verification. **Fixed in PR #866 (merged 2026-08-08).**

The fail-open admin-auth pattern flagged in Feb persists across **all four** server implementations (TS Gatekeeper, TS Keymaster, Python Keymaster, Rust Gatekeeper): with `ARCHON_ADMIN_API_KEY` unset, every administrative endpoint — including wallet mnemonic export and DB reset — is unauthenticated. Reach differs by service: default compose publishes Gatekeeper on all interfaces, while Keymaster is loopback-bound (though still reachable from the victim's own browser via H-03). Drawbridge and Herald are already fail-closed. A new variant appears in the Python Keymaster: `POST /api/v1/login` returns the admin API key to anyone when the wallet passphrase is unset. The TS Keymaster shares the source but not the exposure — its Keymaster constructor rejects an empty passphrase and the process dies, leaving only a startup window (H-02).

Positive: secrets hygiene is clean (zero real secrets in 1,992 commits), Drawbridge's macaroon/L402 crypto is well implemented (timing-safe, fail-closed, refuses to boot without a 32+ char secret), Herald enforces session secrets fail-closed with timing-safe admin comparison, the Feb NoSQL-injection finding is fixed (only `$in` supported now), and compose files now bind Mongo/Redis/Keymaster/signet-RPC to localhost with healthchecks.

| Severity | Count |
|----------|-------|
| 🔴 Critical | 1 (fixed — PR #866) |
| 🟠 High | 4 |
| 🟡 Medium | 7 |
| 🔵 Low | 8 |
| ✅ Positive/Fixed | 9 |

---

## 1. Critical Findings

### C-01: L402 paywall bypass via stub subscription-auth middleware — **fixed**

**Severity:** 🔴 Critical (when `ARCHON_DRAWBRIDGE_L402_ENABLED=true`)
**Status:** ✅ Fixed on `main` — [PR #866](https://github.com/archetech/archon/pull/866), merged 2026-08-08. Vulnerable on the audited commit `daf2c2ac` and on every release up to that point.
**Location:** `services/drawbridge/server/src/middleware/subscription-auth.ts`, `middleware/auth.ts`, `middleware/l402-auth.ts:71-74`

The subscription-auth middleware marked any request carrying an `X-Subscription-DID` header as authenticated — with **no credential verification**:

```ts
// For now, if the header is present, mark as subscription-authed and pass through.
if (subscriptionDid) {
    (req as any).subscriptionAuth = { credentialDid: subscriptionDid };
}
```

The L402 middleware then skipped all payment enforcement:

```ts
// If subscription auth already passed, skip L402
if ((req as any).subscriptionAuth) {
    next();
    return;
}
```

The middleware chain (`createAuthMiddleware`) ran subscription-auth first on every protected route. The file self-documents as a stub (`TODO (#121)`), introduced in commit `20584529` (2026-02-25).

**Impact:** `curl -H "X-Subscription-DID: did:example:anything" https://<drawbridge>/api/v1/<any-paid-route>` bypassed the entire Lightning paywall. Any node relying on L402 for revenue or abuse-deterrence had neither.

**Fix (PR #866):** `createAuthMiddleware` now builds an L402-only chain by default; the stub is included only when `ARCHON_DRAWBRIDGE_SUBSCRIPTIONS_ENABLED=true` is explicitly set (documented in `sample.env` as an insecure dev toggle pending #121), with a startup warning when combined with L402.

---

## 2. High Severity Findings

### H-01: Admin auth fails open by default on four of six services

**Severity:** 🟠 High
**Locations:**
- `services/gatekeeper/server/src/v1-admin.ts:11-16`
- `services/keymaster/server/src/keymaster-admin.ts:11-16`
- `python/keymaster_service/src/keymaster_service/app.py:125-132`
- `rust/services/gatekeeper/src/api.rs:2107-2116`

Identical pattern in all four: `if (!config.adminApiKey) { next(); return; }`. Combined with `bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0'` (both TS configs) and `sample.env` shipping `ARCHON_BIND_ADDRESS=0.0.0.0` with `ARCHON_ADMIN_API_KEY=` empty, every administrative endpoint — mnemonic export (`/api/v1/wallet/mnemonic`), DB reset, wallet overwrite, key rotation — is unauthenticated. The Feb audit called this "mitigated" — the mitigation is opt-in and unchanged in effect.

How far that reaches depends on the service's host binding, which differs:

- **Gatekeeper is reachable from the network in a default compose deployment.** `docker/compose/gatekeeper-ts.yml:33` publishes `${ARCHON_GATEKEEPER_PORT}:4224` with no host-bind prefix, so DB reset and the other Gatekeeper admin routes are exposed on all interfaces with no key set.
- **Keymaster is not**, by default: `docker/compose/keymaster-ts.yml:30` publishes `${ARCHON_KEYMASTER_HOST_BIND:-127.0.0.1}:...:4226`, so mnemonic export is loopback-only unless the operator overrides `ARCHON_KEYMASTER_HOST_BIND` (or runs Keymaster outside compose, where `ARCHON_BIND_ADDRESS=0.0.0.0` from `sample.env` applies directly). Note this is *not* a defence against H-03: a malicious web page can still reach loopback Keymaster from the victim's own browser.

**Fail-closed reference implementations already in this repo:** Drawbridge's `services/drawbridge/server/src/v1-admin.ts` returns 403 `{"error":"Admin API key not configured"}` when the key is empty and compares with `crypto.timingSafeEqual` — it is the same Express `RequestHandler` shape and header as the affected TS services, so it is a near-verbatim copy-paste template. Herald (`services/herald/server/src/oauth/index.ts:189`) is fail-closed and timing-safe too. The four services above compare keys with `!==`/`==`/Python `!=` (not timing-safe) — see L-06.

**Remediation:** Fail closed in production: refuse to start (or refuse admin routes) when `NODE_ENV=production` and no admin key is set. Use `timingSafeEqual` everywhere.

### H-02: `/api/v1/login` discloses the admin API key when passphrase is unset

**Severity:** 🟠 High on the Python service (fresh deployments); 🔵 Low (startup window only) on the TS service — see "Reachability" below
**Locations:** `python/keymaster_service/src/keymaster_service/app.py:148-157`; same source shape in `services/keymaster/server/src/keymaster-public-router.ts:100-115`

```ts
if (!config.keymasterPassphrase) {
    // No passphrase configured — return key directly (dev mode)
    res.json({ adminApiKey: config.adminApiKey || '' });
    return;
}
```

An operator who sets `ARCHON_ADMIN_API_KEY` but leaves `ARCHON_ENCRYPTED_PASSPHRASE` empty (its documented default in `sample.env`) gets no protection from the key: POST `/api/v1/login` with an empty body returns it. The config that looks most secure is silently the bypass.

**Reachability differs sharply between the two ports, and the original draft of this
finding did not distinguish them:**

- **Python — live on a fresh deployment.** The finding is in the FastAPI service (`python/keymaster_service`, image `ghcr.io/archetech/keymaster-python`, selected with `ARCHON_KEYMASTER_FLAVOR=py`), not the `python/keymaster` library. `Keymaster.__init__` (`python/keymaster/src/keymaster/core.py:126`) assigns `self.passphrase = passphrase` with no validation, so nothing rejects an empty one at construction.
  Whether the service then survives startup depends on wallet state, because `startup()` calls `load_wallet()`:
  - **No wallet yet → runs indefinitely.** `load_wallet` falls through to `new_wallet()`, which encrypts the mnemonic with `encrypt_with_passphrase(mnemonic, "")` (`core.py:197`). PBKDF2 over an empty string is valid, so the wallet saves and round-trips through `decrypt_wallet` without complaint. The service comes up and serves the dev-mode `/login` branch for as long as it runs. **This is the exposed case.**
  - **Existing wallet encrypted under a real passphrase → fails safe by accident.** `decrypt_wallet` raises `KeymasterError("Incorrect passphrase.")` (`core.py:219`), so clearing `ARCHON_ENCRYPTED_PASSPHRASE` on an already-initialised node stops the service rather than opening `/login`.
- **TypeScript — effectively unreachable in steady state.** `config.keymasterPassphrase` feeds both `/login` and the `Keymaster` constructor at `keymaster-api.ts:290`, and that constructor rejects an empty passphrase (`packages/keymaster/src/keymaster.ts:223`, asserted by `tests/keymaster/utils.test.ts:109`). An empty passphrase therefore throws inside the `app.listen` callback; the rejection is unhandled and Node terminates the process. The two reachable states are "passphrase set, login authenticates properly" and "service dead".
  The residual TS exposure is a **startup window**: the callback runs after `listen`, and `gatekeeper.connect({ waitUntilReady: true })` on line 276 can block for a long time when Gatekeeper is not yet up. During that window the server is listening and `/login` returns the key. A crash-looping container reopens the window on every restart.

Additionally, on both ports: passphrase comparison is non-constant-time (`!==` / `!=`, a timing oracle), and there is no rate limit or lockout — the passphrase is online-brute-forceable, and it also protects wallet encryption.

**Remediation:** Never return the admin key from an unauthenticated endpoint; require the passphrase unconditionally when an admin key is configured; add rate limiting; use timing-safe comparison. Fix Python first. For TS, also consider validating the passphrase *before* `app.listen` so the process fails to start rather than dying mid-callback with a live socket.

### H-03: CORS allows all origins on Gatekeeper and Keymaster

**Severity:** 🟠 High
**Locations:** `services/keymaster/server/src/keymaster-api.ts:133-134`, `services/gatekeeper/server/src/gatekeeper-api.ts:116-117`

`app.use(cors())` + `app.options('*', cors())`. Any website can drive a victim's browser against a Keymaster on localhost or a LAN address (`http://localhost:4226/api/v1/...`). With H-01 in a default config, a malicious page can exfiltrate the wallet mnemonic cross-origin — the loopback binding is no defence when the request originates in the victim's own browser. (Carried over from Feb H-04; still present.)

**Remediation:** Default-deny origin list; allow only configured wallet origins.

### H-04: Vulnerable dependencies in runtime paths

**Severity:** 🟠 High
**Source:** `npm audit` (30 total: 1 critical / 17 high / 5 moderate / 7 low)

Runtime-relevant (selection):
- **`tar` (CRITICAL)** — arbitrary file creation/overwrite; reached via `sqlite3` → `node-gyp` → `cacache`/`make-fetch-happen` (WalletSQLite build chain)
- **`@libp2p/kad-dht` (HIGH)** — unvalidated PUT_VALUE records allow unbounded storage; reached via `helia` (packages/ipfs — Gatekeeper's IPFS layer)
- **`ip` (HIGH)** — SSRF improper categorization in `isPublic`; no fix available
- **`@hono/node-server` (MODERATE)** — path traversal in `serve-static`; reached via `@modelcontextprotocol/sdk` (packages/mcp-server)
- **`nanoid`, `image-size`, `brace-expansion`, `js-yaml` (HIGH)** — DoS classes; mostly dev/build chains (metro/react-native/lerna)

**Remediation:** `npm audit fix` where non-breaking; override `tar` to ≥ patched version; evaluate replacing `sqlite3` with `better-sqlite3` (prebuilt, no node-gyp); pin/override `@hono/node-server` in mcp-server; track the `ip` SSRF for any user-controlled URL validation usage.

---

## 3. Medium Severity Findings

### M-01: Macaroon `did` caveat and rate-limiting keyed on self-asserted `X-DID` header

**Location:** `services/drawbridge/server/src/middleware/l402-auth.ts:133,169`

The `did` caveat is verified against `req.headers['x-did']` — client-controlled, never authenticated. The caveat therefore binds the token to nothing (any holder restates any DID). Rate limits are likewise keyed on `did || ip`, so rotating fake `X-DID` values evades per-identity limits. `req.ip` is used without `trust proxy` configuration (`grep -rn "trust proxy" services/ --include=*.ts` returns nothing), so behavior behind the documented nginx proxy will either collapse all clients to one IP or trust spoofed X-Forwarded-For, depending on deployment.

### M-02: `max_uses` race allows single-use token replay

**Location:** `services/drawbridge/server/src/middleware/l402-auth.ts:180-185`

Usage increments are deferred to `res.once('finish')`. N concurrent requests with the same priced (single-use) macaroon all read `currentUses = 0` before any increment lands and all pass. Check-and-increment must be atomic in the store (Redis `INCR` + compare in a Lua script, or conditional at verification time).

### M-03: Error messages leak internals to clients — 182 sites

**Locations:** all `services/*/server/src/*.ts` — 182 occurrences of `error.toString()`, via `grep -ro "error\.toString()" services/*/server/src/ | wc -l` on `daf2c2ac`. Raw-error passthrough in other forms (e.g. `error.message`, Python `str(exc)`) is additional.

e.g. `res.status(500).json({ error: error.toString() })` in `v1-search-router.ts:87`, `v1-did-router.ts` (5 sites), and the Python service's global handler returns `str(exc)`. Stack paths, Redis/Mongo errors, and internal hostnames leak to unauthenticated callers on public routers. (Feb M-02 — still widespread.)

### M-04: Herald inbound-email webhook fails open

**Location:** `services/herald/server/src/routes.ts:374-376`

`if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET)` — when `ARCHON_HERALD_WEBHOOK_SECRET` is unset (default `''` in config), the SendGrid inbound-parse webhook accepts forged email from anyone. The secret is also passed as a **query parameter**, which lands in access logs and proxy histories. Use a header and fail closed.

### M-05: Insecure defaults committed in `sample.env` and `data/btc-*/bitcoin.conf`

- `sample.env`: `ARCHON_BIND_ADDRESS=0.0.0.0`, empty `ARCHON_ADMIN_API_KEY`, empty passphrases — copy-paste deployments inherit the worst configuration (feeds H-01/H-02).
- `data/btc-signet/bitcoin.conf` and `data/btc-testnet4/bitcoin.conf`: committed `rpcuser=signet / rpcpassword=signet` (and `testnet4/testnet4`) with `rpcbind=0.0.0.0` + `rpcallowip=0.0.0.0/0`. Compose now binds host ports to `127.0.0.1` (verified in `docker/compose/btc-signet.yml`), so exposure is limited to the docker network — but any container compromise reaches the RPC with trivial credentials. Test networks only (no mainnet funds at risk), hence Medium.

### M-06: PBKDF2 iteration count env-overridable without a floor

**Location:** `packages/cipher/src/passphrase.ts:10-18`

`PBKDF2_ITERATIONS` accepts any value > 0, silently weakening wallet-at-rest encryption below the 100k default (e.g. `PBKDF2_ITERATIONS=1`). Enforce a minimum (e.g. 100,000) and warn on override. (Feb M-12 — still present.)

### M-07: Stored-XSS-capable OAuth client name + third-party CDN script without SRI

**Location:** `services/herald/server/src/oauth/index.ts:274,323`

The consent page interpolates `client.name` unescaped into HTML. Client registration (`POST /oauth/clients`) is admin-gated and fail-closed (verified), so exploitation requires a compromised/malicious admin — Medium-Low. The page also loads `qrcode.min.js` from jsdelivr without an integrity hash; a CDN compromise yields JS execution in the auth flow. Positive: `redirect_uri` is strictly validated against the registered list (verified at lines 222-228), and challenges are server-generated.

---

## 4. Low Severity Findings

| ID | Finding | Location |
|----|---------|----------|
| L-01 | Extension `GET_PASSPHRASE` (and state handlers) have no `sender` validation — any extension context (incl. content scripts on `<all_urls>`) can read the session passphrase. Current content scripts don't relay it, but one careless relay addition exposes it to every web page. | `apps/browser-extension/src/background/background.ts:179-180` |
| L-02 | `<all_urls>` content script + host permissions persist (Feb H-07). Partially mitigated: handoff messages now validate (`isDidLike`, action allowlist) and NIP-07 has per-origin consent with auto-approve list. | `apps/browser-extension/src/static/manifest.json` |
| L-03 | `wasm-unsafe-eval` in extension CSP (Feb M-11) — required by crypto deps; document and scope tightly. | manifest.json |
| L-04 | `/metrics` publicly mounted before auth middleware on TS services. | keymaster-api.ts:150, gatekeeper-api.ts:161 |
| L-05 | Public `GET /invoice/:did` on Drawbridge creates invoices via the Lightning mediator with no auth — resource-abuse/spam vector (rate limiting not applied on this path). | drawbridge-api.ts:397 |
| L-06 | Admin-key comparison not timing-safe in TS Gatekeeper/Keymaster (`!==`), Rust Gatekeeper (`==`), or the Python service (plain `!=`; `hmac.compare_digest` is used nowhere under `python/keymaster_service/src/`). Drawbridge and Herald already use `crypto.timingSafeEqual`. | gatekeeper `v1-admin.ts`, `keymaster-admin.ts`, `api.rs:2116`, `keymaster_service/app.py:131` |
| L-07 | `window.postMessage(..., "*")` for NIP-07 responses (semgrep `wildcard-postmessage-configuration`); low impact since responses target the requesting page, but `messageTargetOrigin` is available and unused there. | contentScript.ts:28-40 |
| L-08 | Dev-chain dependency hygiene: `dependabot-missing-cooldown`, `.npmrc` missing `minimum-release-age`, Express 4.x maintenance mode, `@noble/ciphers` 0.x, alpha `@capacitor/core` (carried from Feb). | assorted |

---

## 5. Semgrep triage notes (38 raw findings)

- `run-shell-injection` in `.github/workflows/npm-package-publish.yml` — **not exploitable**: `workflow_dispatch` only, and all interpolated inputs (`package`, `version`, `preid`) are `type: choice` with fixed option lists. Consider env-var indirection anyway as hardening.
- `crypto-mode-without-authentication` in `python/keymaster/src/keymaster/didcomm_crypto.py:192` — **false positive**: A256CBC-HS512 implements encrypt-then-MAC with HMAC-SHA-512/32 and `compare_digest` verified before decryption (lines 180-216). Correct JWE construction.
- `direct-response-write` (9×, drawbridge v1-router) — reviewed, JSON responses of internal data; no injection sink.
- `missing-user` in `services/herald/Dockerfile` — consistent with Feb H-05 (containers run as root); compose-level `user:` directives exist on some services but not uniformly.

---

## 6. Positive / Verified-Fixed Findings

1. **Secrets hygiene: clean.** gitleaks over full history (1,992 commits): 13 hits, all verified false positives — W3C DIDComm spec vectors, cross-implementation test envelopes with `did:test` keys, the BIP32 documentation example xprv/xpub in `packages/browser-hdkey/README.md`, and a dummy hex macaroon secret in tests.
2. **Drawbridge macaroon implementation is solid** (`macaroon.ts`): `timingSafeEqual` for payment-hash/preimage, strict hex format validation, fail-closed on unknown caveats, and the service **refuses to start** without a 32+ char `MACAROON_SECRET` (drawbridge-api.ts:336-339). Payment completion checks mediator-side settlement, deletes pending invoices after redemption, and expires them (410). Drawbridge's admin auth (`v1-admin.ts`) is also **fail-closed** (403 when no key is configured) and timing-safe — unlike the services in H-01.
3. **Herald hardening:** fail-closed session secret with placeholder rejection, timing-safe admin comparison, admin-gated client registration, strict `redirect_uri` validation.
4. **Feb M-03 (NoSQL injection via `queryDocs`) fixed:** `packages/gatekeeper/src/search-index.ts` implements a custom matcher supporting only `{$in: [...]}` — no operator passthrough to Mongo.
5. **Compose posture improved:** Mongo/Redis/IPFS-API/Keymaster/signet-RPC all bind `127.0.0.1`; healthchecks present (Feb M-06); node containers take `user:` directives.
6. **Extension improvements since Feb:** passphrase moved from offscreen-document memory to `chrome.storage.session` (memory-only, cleared with the session); NIP-07 per-origin consent flow; validated handoff message allowlist.
7. **`SECURITY.md` published** (vulnerability disclosure policy) — added this cycle.
8. **No code-injection sinks:** no `eval`/`new Function`/`child_process.exec` with user input found in service code (semgrep + manual grep).
9. **CI publish workflow** constrained to maintainer-dispatched choice inputs.

---

## 7. Prior Audit Findings — Status on `main`

Complete mapping: every finding in the February report has a row here. This
report replaces that document in the tree, so anything left open below has no
other tracking surface.

| Feb ID | Finding | Status Aug 2026 |
|--------|---------|-----------------|
| C-01..C-03 | Unauthenticated admin endpoints | ⚠️ Partially — middleware exists but fails open by default on TS Gatekeeper/Keymaster, Python, Rust (see H-01) |
| C-04 | Wallet in git | ✅ Resolved — verified no wallet files tracked |
| H-01 | No TLS | ℹ️ Unchanged by design (reverse proxy terminates TLS; nginx example provided) |
| H-02 | No security headers | ⚠️ Still absent on TS services |
| H-03 | No rate limiting | ⚠️ Proxy-level only; Drawbridge has app-level limiting (with M-01 caveats); Keymaster/Gatekeeper none |
| H-04 | CORS-all | ❌ Still present (H-03 this report) |
| H-05 | Root containers | ⚠️ Partial (compose `user:` on some services; Dockerfiles unchanged — herald flagged by semgrep) |
| H-06 | `.gitignore` missing data exclusions | ✅ Resolved — `data/.gitignore` excludes `*.json`, `*.db`, and each service/chain data dir |
| H-07 | `<all_urls>` extension | ⚠️ Present, partially mitigated (L-02) |
| H-08 | Plaintext passphrase in offscreen | ✅ Improved — `chrome.storage.session` |
| H-09 | Signet RPC exposed | ✅ Mitigated — localhost-bound in compose |
| M-01 | No input-validation library/schema | ❌ Still present — no schema-validation dependency in any `services/*/server/package.json` |
| M-02 | Error message leaks | ❌ Still present — 182 sites (M-03) |
| M-03 | NoSQL injection | ✅ Fixed — `$in`-only custom matcher |
| M-04 | Empty passphrase fallback in Keymaster | ❌ Still present in the config layer, and it is the trigger for H-02 (live on Python; TS refuses to run with it) |
| M-05 | Default creds in sample.env | ❌ Still present (M-05) |
| M-06 | No container health checks | ✅ Fixed — healthchecks on core and Drawbridge-stack services |
| M-07 | No resource limits | ❌ Still present — no `mem_limit` / `cpus` / `deploy.resources` in any compose file |
| M-08 | No network segmentation | ❌ Still present — flat default network, no `networks:` definitions |
| M-09 | Broad volume mounts | ✅ Improved — services now bind per-service subdirectories (`data/herald`, `data/drawbridge`, …) rather than all of `data/` |
| M-10 | Untrusted page→extension messaging | ✅ Improved — validated allowlist |
| M-11 | `wasm-unsafe-eval` in extension CSP | ⚠️ Present, accepted — required by crypto deps (L-03 this report) |
| M-12 | PBKDF2 env override | ❌ Still present (M-06) |
| L-01 | `mongo:8.0` not patch-pinned | ❌ Still present — `docker/compose/core.yml:3` |
| L-02 | Build tools in final image | ❌ Still present — `docker/Dockerfile.hyperswarm:5` installs `python3 make g++` in a single-stage build |
| L-03 | CLI container idles on `tail -f` | ❌ Still present — `docker/Dockerfile.cli:21`; accepted (interactive `docker compose exec` container) |
| L-04 | No `security_opt` / capability dropping | ❌ Still present — neither appears in any compose file |
| L-05 | No restart policies | ⚠️ Mostly absent — only `docker/compose/lightning.yml` sets `restart:` |
| L-06 | `@noble/ciphers` on 0.x | ❌ Still present (folded into L-08 this report) |
| L-07 | `@capacitor/core` alpha | ❌ Still present (folded into L-08 this report) |
| L-08 | Express 4.x maintenance mode | ❌ Still present (folded into L-08 this report) |
| L-09 | `/metrics` public | ❌ Still present (L-04 this report) |
| L-10 | Redis unauthenticated | ⚠️ Unchanged, accepted — no `requirepass`, but bound `127.0.0.1:6379` and docker-network-isolated |
| L-11 | Bitcoin RPC hardcoded creds | ⚠️ Unchanged, accepted — test networks only; host ports localhost-bound (carried into M-05) |
| L-12 | MongoDB unauthenticated | ⚠️ Unchanged, accepted — no auth, but bound `127.0.0.1:27017` and docker-network-isolated |

---

## 8. Remediation Priorities

1. **C-01** — ✅ Done: PR #866, merged 2026-08-08. Any L402 deployment running a build older than that merge is still bypassable and should be updated.
2. **H-02** — Stop returning the admin key from `/login` without passphrase verification. Python first (live); TS is a startup-window edge case, best closed by validating the passphrase before `app.listen`.
3. **H-01** — Fail closed on admin auth in production; timing-safe comparisons (copy Drawbridge's `v1-admin.ts` into TS Gatekeeper/Keymaster, `hmac.compare_digest` in Python, a constant-time compare in Rust); secure-by-default `sample.env` (`ARCHON_BIND_ADDRESS=127.0.0.1`, generated admin key); add a host bind to the Gatekeeper compose port mapping to match Keymaster's.
4. **H-03** — CORS allowlist.
5. **H-04** — `tar` override; `@hono/node-server` pin; assess `helia`/`@libp2p/kad-dht` exposure.
6. **M-01/M-02** — Stop trusting `X-DID`; atomic check-and-increment for macaroon uses.
7. **M-03** — Generic client-facing error messages; log internals server-side only.

---

*Evidence basis: every finding above cites a file/line read directly from the working tree @ `daf2c2ac`, or quoted tool output (gitleaks 8.24.3, npm audit, semgrep). No finding rests on assumption.*
