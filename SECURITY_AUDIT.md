# 🔒 Archon Security Audit Report — August 2026

**Date:** August 8, 2026
**Scope:** Full repository — `archetech/archon`, branch `main` @ `daf2c2accee5640bd49fe64ca74b28cf6c8b1db2` (2026-08-05)
**Auditor:** Morningstar (automated + manual review)
**Supersedes:** February 2026 audit (branch `release-0.2`; retained in git history) — 569 commits since
**Classification:** Internal — Confidential

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

The most serious new finding was a **complete L402 paywall bypass** in Drawbridge: a stub subscription-auth middleware accepted any `X-Subscription-DID` header as authenticated, skipping all payment verification. **Fix submitted in PR #866.**

The fail-open admin-auth pattern flagged in Feb persists across **all four** server implementations (TS Gatekeeper, TS Keymaster, Python Keymaster, Rust Gatekeeper): with `ARCHON_ADMIN_API_KEY` unset, every administrative endpoint — including wallet mnemonic export and DB reset — is unauthenticated, and all services bind `0.0.0.0` by default. A new variant appears in TS/Python Keymaster: `POST /api/v1/login` returns the admin API key to anyone when the wallet passphrase is unset.

Positive: secrets hygiene is clean (zero real secrets in 1,992 commits), Drawbridge's macaroon/L402 crypto is well implemented (timing-safe, fail-closed, refuses to boot without a 32+ char secret), Herald enforces session secrets fail-closed with timing-safe admin comparison, the Feb NoSQL-injection finding is fixed (only `$in` supported now), and compose files now bind Mongo/Redis/Keymaster/signet-RPC to localhost with healthchecks.

| Severity | Count |
|----------|-------|
| 🔴 Critical | 1 (fix in PR #866) |
| 🟠 High | 4 |
| 🟡 Medium | 7 |
| 🔵 Low | 8 |
| ✅ Positive/Fixed | 9 |

---

## 1. Critical Findings

### C-01: L402 paywall bypass via stub subscription-auth middleware — **fix in PR #866**

**Severity:** 🔴 Critical (when `ARCHON_DRAWBRIDGE_L402_ENABLED=true`)
**Status:** ✅ Fix submitted — [PR #866](https://github.com/archetech/archon/pull/866)
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

### H-01: Admin auth fails open by default on all four services

**Severity:** 🟠 High
**Locations:**
- `services/gatekeeper/server/src/v1-admin.ts:11-16`
- `services/keymaster/server/src/keymaster-admin.ts:11-16`
- `services/drawbridge/server/src/v1-admin.ts` (same pattern)
- `python/keymaster_service/src/keymaster_service/app.py:125-132`
- `rust/services/gatekeeper/src/api.rs:2107-2116`

Identical pattern everywhere: `if (!config.adminApiKey) { next(); return; }`. Combined with `bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0'` (both TS configs) and `sample.env` shipping `ARCHON_BIND_ADDRESS=0.0.0.0` with `ARCHON_ADMIN_API_KEY=` empty, a default deployment exposes mnemonic export (`/api/v1/wallet/mnemonic`), DB reset, wallet overwrite, and key rotation to the network with zero authentication. The Feb audit called this "mitigated" — the mitigation is opt-in and unchanged in effect.

Note: Herald's variant is **fail-closed** (403 when unconfigured) and uses `crypto.timingSafeEqual` — the model the others should copy. The TS/Rust services also compare keys with `!==`/`==` (not timing-safe).

**Remediation:** Fail closed in production: refuse to start (or refuse admin routes) when `NODE_ENV=production` and no admin key is set. Use `timingSafeEqual` everywhere.

### H-02: `/api/v1/login` discloses the admin API key when passphrase is unset

**Severity:** 🟠 High
**Locations:** `services/keymaster/server/src/keymaster-public-router.ts:100-115`; same in `python/keymaster_service/src/keymaster_service/app.py:148-157`

```ts
if (!config.keymasterPassphrase) {
    // No passphrase configured — return key directly (dev mode)
    res.json({ adminApiKey: config.adminApiKey || '' });
    return;
}
```

An operator who sets `ARCHON_ADMIN_API_KEY` but leaves `ARCHON_ENCRYPTED_PASSPHRASE` empty (its documented default in `sample.env`) gets **no protection at all**: anyone can POST `/api/v1/login` with an empty body and receive the admin key. The config that looks most secure is silently the bypass.

Additionally: passphrase comparison is `!==` (timing oracle), and there is no rate limit or lockout — the passphrase is online-brute-forceable, and it also protects wallet encryption.

**Remediation:** Never return the admin key from an unauthenticated endpoint; require the passphrase unconditionally when an admin key is configured; add rate limiting; use timing-safe comparison.

### H-03: CORS allows all origins on Gatekeeper and Keymaster

**Severity:** 🟠 High
**Locations:** `services/keymaster/server/src/keymaster-api.ts:133-134`, `services/gatekeeper/server/src/gatekeeper-api.ts:116-117`

`app.use(cors())` + `app.options('*', cors())`. Any website can drive a victim's browser against a Keymaster on localhost or a LAN address (`http://localhost:4226/api/v1/...`). With H-01/H-02 in default configs, a malicious page can exfiltrate the wallet mnemonic cross-origin. (Carried over from Feb H-04; still present and now worse given H-02.)

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

The `did` caveat is verified against `req.headers['x-did']` — client-controlled, never authenticated. The caveat therefore binds the token to nothing (any holder restates any DID). Rate limits are likewise keyed on `did || ip`, so rotating fake `X-DID` values evades per-identity limits. `req.ip` is used without `trust proxy` configuration (verified absent in all four services), so behavior behind the documented nginx proxy will either collapse all clients to one IP or trust spoofed X-Forwarded-For, depending on deployment.

### M-02: `max_uses` race allows single-use token replay

**Location:** `services/drawbridge/server/src/middleware/l402-auth.ts:180-185`

Usage increments are deferred to `res.once('finish')`. N concurrent requests with the same priced (single-use) macaroon all read `currentUses = 0` before any increment lands and all pass. Check-and-increment must be atomic in the store (Redis `INCR` + compare in a Lua script, or conditional at verification time).

### M-03: Error messages leak internals to clients — 186 sites

**Locations:** all `services/*/server/src/*.ts` (grep count: 186 occurrences of `error.toString()` / raw error passthrough)

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
| L-06 | Admin-key comparison not timing-safe in TS (`!==`) and Rust (`==`) services (Herald/Python use constant-time). | v1-admin.ts, keymaster-admin.ts, api.rs:2116 |
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
2. **Drawbridge macaroon implementation is solid** (`macaroon.ts`): `timingSafeEqual` for payment-hash/preimage, strict hex format validation, fail-closed on unknown caveats, and the service **refuses to start** without a 32+ char `MACAROON_SECRET` (drawbridge-api.ts:336-339). Payment completion checks mediator-side settlement, deletes pending invoices after redemption, and expires them (410).
3. **Herald hardening:** fail-closed session secret with placeholder rejection, timing-safe admin comparison, admin-gated client registration, strict `redirect_uri` validation.
4. **Feb M-03 (NoSQL injection via `queryDocs`) fixed:** `packages/gatekeeper/src/search-index.ts` implements a custom matcher supporting only `{$in: [...]}` — no operator passthrough to Mongo.
5. **Compose posture improved:** Mongo/Redis/IPFS-API/Keymaster/signet-RPC all bind `127.0.0.1`; healthchecks present (Feb M-06); node containers take `user:` directives.
6. **Extension improvements since Feb:** passphrase moved from offscreen-document memory to `chrome.storage.session` (memory-only, cleared with the session); NIP-07 per-origin consent flow; validated handoff message allowlist.
7. **`SECURITY.md` published** (vulnerability disclosure policy) — added this cycle.
8. **No code-injection sinks:** no `eval`/`new Function`/`child_process.exec` with user input found in service code (semgrep + manual grep).
9. **CI publish workflow** constrained to maintainer-dispatched choice inputs.

---

## 7. Prior Audit Findings — Status on `main`

| Feb ID | Finding | Status Aug 2026 |
|--------|---------|-----------------|
| C-01..C-03 | Unauthenticated admin endpoints | ⚠️ Partially — middleware exists but fails open by default on TS/Python/Rust (see H-01) |
| C-04 | Wallet in git | ✅ Resolved — verified no wallet files tracked |
| H-01 | No TLS | ℹ️ Unchanged by design (reverse proxy terminates TLS; nginx example provided) |
| H-02 | No security headers | ⚠️ Still absent on TS services |
| H-03 | No rate limiting | ⚠️ Proxy-level only; Drawbridge has app-level limiting (with M-01 caveats); Keymaster/Gatekeeper none |
| H-04 | CORS-all | ❌ Still present (H-03 this report) |
| H-05 | Root containers | ⚠️ Partial (compose `user:` on some services; Dockerfiles unchanged — herald flagged by semgrep) |
| H-07 | `<all_urls>` extension | ⚠️ Present, partially mitigated (L-02) |
| H-08 | Plaintext passphrase in offscreen | ✅ Improved — `chrome.storage.session` |
| H-09 | Signet RPC exposed | ✅ Mitigated — localhost-bound in compose |
| M-02 | Error message leaks | ❌ Still present — 186 sites (M-03) |
| M-03 | NoSQL injection | ✅ Fixed — `$in`-only custom matcher |
| M-05 | Default creds in sample.env | ❌ Still present (M-05) |
| M-10 | Untrusted page→extension messaging | ✅ Improved — validated allowlist |
| M-12 | PBKDF2 env override | ❌ Still present (M-06) |

---

## 8. Remediation Priorities

1. **C-01** — ✅ PR #866 (merged status tracked there). Any L402 deployment was unpaid until this lands.
2. **H-02** — Stop returning the admin key from `/login` without passphrase verification.
3. **H-01** — Fail closed on admin auth in production; timing-safe comparisons; secure-by-default `sample.env` (`ARCHON_BIND_ADDRESS=127.0.0.1`, generated admin key).
4. **H-03** — CORS allowlist.
5. **H-04** — `tar` override; `@hono/node-server` pin; assess `helia`/`@libp2p/kad-dht` exposure.
6. **M-01/M-02** — Stop trusting `X-DID`; atomic check-and-increment for macaroon uses.
7. **M-03** — Generic client-facing error messages; log internals server-side only.

---

*Evidence basis: every finding above cites a file/line read directly from the working tree @ `daf2c2ac`, or quoted tool output (gitleaks 8.24.3, npm audit, semgrep). No finding rests on assumption.*
