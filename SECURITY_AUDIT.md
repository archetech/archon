# 🔒 Archon Security Audit Report

**Date:** February 7, 2026 (updated February 9, 2026)
**Scope:** Full repository — `archetech/archon` (branch: `release-0.2`)
- **Auditor:** Automated Security Analysis
- **Classification:** Internal — Confidential

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Risk Summary Matrix](#risk-summary-matrix)
3. [Critical Findings](#1-critical-findings)
4. [High Severity Findings](#2-high-severity-findings)
5. [Medium Severity Findings](#3-medium-severity-findings)
6. [Low Severity Findings](#4-low-severity-findings)
7. [Informational / Positive Findings](#5-informational--positive-findings)
8. [Remediation Roadmap](#remediation-roadmap)
9. [Appendix — Files Reviewed](#appendix--files-reviewed)

---

## Executive Summary

Archon is a decentralized identity (DID) protocol implementation comprising microservices (Gatekeeper, Keymaster, mediators), client applications (React wallet, Chrome extension), and supporting infrastructure (Redis, MongoDB, IPFS, Bitcoin nodes).

**Architecture note:** The Gatekeeper and Keymaster services are designed to run behind a reverse proxy (nginx, Caddy, Traefik) that handles TLS termination, authentication, and public endpoint filtering. The services themselves are not intended to be directly exposed to the internet.

This audit identified **37 findings** across the codebase, infrastructure, and configuration. The most critical issues center around:

- **No application-level defense-in-depth** for admin endpoints — if the reverse proxy is misconfigured, destructive routes (wallet mnemonic, database reset) are fully exposed *(now mitigated — see [Remediation Applied](#remediation-applied))*
- **Hardcoded and default credentials** for Bitcoin RPC, Redis, MongoDB, and Grafana — some committed to version control
- **Sensitive data committed to Git** (encrypted wallet file in `data/wallet.json`)
- **No network isolation** between containers — flat Docker network topology

**Remediation applied in this release:**
- Admin API key middleware (`ARCHON_ADMIN_API_KEY`) added to both services for defense-in-depth
- Configurable bind address (`ARCHON_BIND_ADDRESS`) to restrict to localhost behind a proxy
- `GET /db/reset` blocked in production (`NODE_ENV=production`)
- Sample nginx reverse proxy configuration provided in `doc/nginx-proxy.conf.example`

The cryptographic implementation (cipher package) uses sound primitives (secp256k1, XChaCha20-Poly1305, AES-256-GCM with PBKDF2), and no code injection vectors (`eval`, `exec`, `Function()`) were found. SQL queries are properly parameterized.

| Severity | Count |
|----------|-------|
| ✅ Mitigated | 5 |
| 🔴 Critical | 4 |
| 🟠 High | 6 |
| 🟡 Medium | 12 |
| 🔵 Low | 9 |
| **Total** | **37** (5 mitigated) |

---

## Risk Summary Matrix

| ID | Severity | Category | Finding | Primary Location |
|----|----------|----------|---------|-----------------|
| C-01 | ✅ Mitigated | Auth | No authentication on API endpoints → admin key middleware added | `services/gatekeeper/server/`, `services/keymaster/server/` |
| C-02 | ✅ Mitigated | Auth | Unauthenticated DB reset via GET request → admin key + production guard | `services/gatekeeper/server/` — `GET /db/reset` |
| C-03 | ✅ Mitigated | Auth | Mnemonic exposed via unauthenticated endpoint → admin key required | `services/keymaster/server/` — `GET /api/v1/wallet/mnemonic` |
| C-04 | ✅ Mitigated | Secrets | Encrypted wallet committed to Git → `data/.gitignore` excludes `*.json`; file was never committed | `data/wallet.json` |
| H-01 | ✅ Mitigated | Transport | No TLS → bind address + nginx proxy config provided | All server files |
| H-02 | 🟠 High | Headers | No security headers (helmet) | `services/gatekeeper/server/`, `services/keymaster/server/` |
| H-03 | ✅ Mitigated | DoS | No rate limiting → nginx proxy rate limiting provided | All API servers |
| H-04 | 🟠 High | CORS | CORS allows all origins on Gatekeeper | `services/gatekeeper/server/` |
| H-05 | 🟠 High | Docker | Containers default to root user | All 7 Dockerfiles |
| H-06 | 🟠 High | Git | `.gitignore` missing critical data exclusions | `.gitignore` |
| H-07 | 🟠 High | Extension | `<all_urls>` content script + host permissions | `apps/chrome-extension/` — `manifest.json` |
| H-08 | 🟠 High | Extension | Plaintext passphrase stored in offscreen memory | `apps/chrome-extension/src/offscreen.ts` |
| H-09 | 🟠 High | Infra | Bitcoin signet RPC port exposed to all interfaces | `docker-compose.btc-signet.yml` |
| M-01 | 🟡 Medium | Validation | No input validation library/schema enforcement | All API servers |
| M-02 | 🟡 Medium | Info Leak | Error messages expose `error.message` to clients | All API servers |
| M-03 | 🟡 Medium | Injection | Potential NoSQL injection via `queryDocs` endpoint | `services/gatekeeper/server/` — `POST /dids/query` |
| M-04 | 🟡 Medium | Config | Empty passphrase fallback in Keymaster config | `services/keymaster/server/` — config |
| M-05 | 🟡 Medium | Secrets | Default credentials in `sample.env` | `sample.env` |
| M-06 | 🟡 Medium | Docker | No health checks on any container | All `docker-compose` files |
| M-07 | 🟡 Medium | Docker | No resource limits (CPU/memory) on containers | All `docker-compose` files |
| M-08 | 🟡 Medium | Docker | No network segmentation — flat topology | All `docker-compose` files |
| M-09 | 🟡 Medium | Docker | Broad volume mounts — entire `data/` shared | `docker-compose.yml` |
| M-10 | 🟡 Medium | Extension | Untrusted URL params from web pages forwarded via messaging | `apps/chrome-extension/src/contentScript.ts` |
| M-11 | 🟡 Medium | Extension | `wasm-unsafe-eval` in CSP | `apps/chrome-extension/` — `manifest.json` |
| M-12 | 🟡 Medium | Crypto | PBKDF2 iterations overridable via environment variable | `packages/keymaster/src/encryption.ts` |
| L-01 | 🔵 Low | Docker | `mongo:8.0` not pinned to patch version | `docker-compose.yml` |
| L-02 | 🔵 Low | Docker | Build tools (`python3`, `make`, `g++`) remain in final images | `Dockerfile.hyperswarm` |
| L-03 | 🔵 Low | Docker | CLI container runs idle with `tail -f /dev/null` | `Dockerfile.cli` |
| L-04 | 🔵 Low | Docker | No `security_opt` or capability dropping | All `docker-compose` files |
| L-05 | 🔵 Low | Docker | No restart policies on critical services | All `docker-compose` files |
| L-06 | 🔵 Low | Deps | `@noble/ciphers` on pre-stable 0.x line | `packages/cipher/package.json` |
| L-07 | 🔵 Low | Deps | `@capacitor/core` on alpha pre-release | `apps/react-wallet/package.json` |
| L-08 | 🔵 Low | Deps | Express 4.x in maintenance mode | `services/*/server/package.json` |
| L-09 | 🔵 Low | Observability | Prometheus metrics endpoints publicly accessible | Both API servers — `/metrics` |
| L-10 | 🔵 Low | Infra | Redis has no authentication, but is bound to localhost and isolated in Docker | `data/redis.conf` |
| L-11 | 🔵 Low | Infra | Bitcoin RPC hardcoded credentials → signet port bound to localhost; testnet4 not exposed; test networks only | `data/btc-signet/bitcoin.conf`, `data/btc-testnet4/bitcoin.conf` |
| L-12 | 🔵 Low | Infra | MongoDB has no authentication, but is bound to localhost and isolated in Docker | `docker-compose.yml` — `mongodb` service |

---

## 1. Critical Findings

### C-01: No Authentication on Any API Endpoint

**Severity:** 🔴 Critical → 🟡 **Mitigated**
**Category:** Authentication & Authorization
**Affected:** `services/gatekeeper/server/`, `services/keymaster/server/`

~~Neither the Gatekeeper nor Keymaster service implements any authentication or authorization middleware.~~

**Remediation applied:** Both services now support an `ARCHON_ADMIN_API_KEY` environment variable. When set, all admin/destructive endpoints require `Authorization: Bearer <key>`. Additionally, `ARCHON_BIND_ADDRESS` allows binding to `127.0.0.1` so only the local reverse proxy can reach the services. A sample nginx configuration (`doc/nginx-proxy.conf.example`) is provided that exposes only public-safe endpoints with rate limiting.

**Protected routes (Gatekeeper):** `/dids/remove`, `/db/reset`, `/db/verify`
**Protected routes (Keymaster):** `/wallet` (GET/PUT), `/wallet/new`, `/wallet/backup`, `/wallet/recover`, `/wallet/check`, `/wallet/fix`, `/wallet/mnemonic`, `/export/wallet/encrypted`, `/did/:id` (DELETE), `/ids` (POST), `/ids/:id` (DELETE), `/keys/rotate`, `/assets/:id/transfer`

**Remaining risk:** Operators must set `ARCHON_ADMIN_API_KEY` and configure the reverse proxy. Without both, the original risk remains. This should be enforced at deployment level.

**Deployment checklist:**
```bash
# In .env:
ARCHON_BIND_ADDRESS=127.0.0.1        # Only accept connections from localhost/nginx
ARCHON_ADMIN_API_KEY=$(openssl rand -hex 32)  # Defense-in-depth for admin routes
```

---

### C-02: Unauthenticated Database Reset via GET Request

**Severity:** 🔴 Critical → 🟡 **Mitigated**
**Category:** Authentication & Authorization
**Affected:** `services/gatekeeper/server/` — `GET /db/reset`

~~The entire Gatekeeper database can be wiped with a single unauthenticated HTTP GET request.~~

**Remediation applied:**
1. The route now requires the admin API key when `ARCHON_ADMIN_API_KEY` is set
2. The route returns `403 Forbidden` when `NODE_ENV=production`, regardless of API key
3. The sample nginx config blocks this route entirely from external access

**Remaining risk:** In development mode without an API key, the endpoint is still accessible. This is intentional for local development.

---

### C-03: Mnemonic Exposed via Unauthenticated Endpoint

**Severity:** 🔴 Critical → 🟡 **Mitigated**
**Category:** Authentication & Authorization
**Affected:** `services/keymaster/server/` — `GET /api/v1/wallet/mnemonic`

~~The decrypted BIP39 mnemonic phrase is returned in plaintext to any unauthenticated caller.~~

**Remediation applied:** This endpoint now requires the admin API key when `ARCHON_ADMIN_API_KEY` is set. The sample nginx config does not proxy this route externally.

**Remaining risk:** The endpoint still exists and returns the mnemonic when the correct API key is provided. Consider adding audit logging for mnemonic access.

---

### C-04: Encrypted Wallet Committed to Git

**Severity:** ✅ Mitigated
**Category:** Secrets Management
**Affected:** `data/wallet.json`

**Status:** This finding was a false positive. The `data/.gitignore` already contains a `*.json` rule that excludes `wallet.json`, and `git log --all -- data/wallet.json` confirms the file was never committed to the repository.

~~The file `data/wallet.json` contains an encrypted wallet with:~~
~~- AES-GCM encrypted mnemonic seed (salt, IV, ciphertext)~~
~~- Full encrypted wallet blob~~

~~This file is committed to the repository. Even though the mnemonic is encrypted, the `.gitignore` does not exclude it. If the passphrase is weak, guessable, or leaked, the entire key material is compromised. Additionally, Git history preserves all past versions of the file.~~

~~**Impact:** Encrypted secrets in version control are accessible to anyone with repo access. A weak passphrase enables offline brute-force.~~

**Recommendation:** No action required — existing controls are sufficient.

---

## 2. High Severity Findings

### H-01: No TLS/HTTPS on Any Service

**Severity:** 🟠 High → 🟡 **Mitigated by architecture**
**Category:** Transport Security

All inter-service and client-facing communication uses plain HTTP. This is acceptable when services are bound to `127.0.0.1` and a TLS-terminating reverse proxy handles external traffic. The sample nginx config (`doc/nginx-proxy.conf.example`) includes HTTPS server block templates.

**Remaining risk:** Inter-container traffic within Docker remains unencrypted. For high-security deployments, consider enabling TLS for Redis, MongoDB, and inter-service HTTP.

**Recommendation:**
- Set `ARCHON_BIND_ADDRESS=127.0.0.1` in production `.env`
- Deploy a TLS-terminating reverse proxy (nginx, Caddy, Traefik)
- Enable TLS for Redis (`tls-port`, `tls-cert-file`, `tls-key-file`) in sensitive environments
- Document that TLS is **mandatory** for any non-localhost deployment

---

### H-02: No Security Headers (Helmet)

**Severity:** 🟠 High
**Category:** HTTP Security

Neither Express server uses `helmet` or sets any security headers. Missing headers include:
- `Strict-Transport-Security` (HSTS)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy`
- `X-XSS-Protection`
- `Referrer-Policy`

**Recommendation:**
```typescript
import helmet from 'helmet';
app.use(helmet());
```

---

### H-03: No Rate Limiting

**Severity:** 🟠 High → 🟡 **Mitigated at proxy layer**
**Category:** Availability / DoS Protection

No rate limiting middleware (`express-rate-limit` or equivalent) is present on either API server. The sample nginx config (`doc/nginx-proxy.conf.example`) provides rate limiting zones at the proxy level, which is the recommended approach.

**Remaining risk:** Without the reverse proxy, or for inter-service traffic, there is no rate limiting.

**Recommendation:** Ensure the reverse proxy is deployed with the provided rate limiting configuration. Optionally add `express-rate-limit` as an additional defense layer.

---

### H-04: CORS Allows All Origins (Gatekeeper)

**Severity:** 🟠 High
**Category:** Cross-Origin Security
**Affected:** `services/gatekeeper/server/`

```typescript
app.use(cors());
app.options('*', cors());
```

CORS is configured to allow requests from **any origin**. Any website can make authenticated requests to the Gatekeeper API. For a DID/credential management API, this allows cross-site attacks from any malicious web page.

**Recommendation:** Restrict to known origins:
```typescript
app.use(cors({ origin: ['https://your-wallet.example.com'], credentials: true }));
```

---

### H-05: Containers Default to Root User

**Severity:** 🟠 High
**Category:** Container Security
**Affected:** All 7 Dockerfiles (`Dockerfile.cli`, `Dockerfile.explorer`, `Dockerfile.gatekeeper`, `Dockerfile.hyperswarm`, `Dockerfile.keymaster`, `Dockerfile.react-wallet`, `Dockerfile.satoshi`)

No Dockerfile includes a `USER` directive or creates a non-root user. While some services override with `user:` in `docker-compose.yml`, the images themselves default to root. `npm ci` and `npm run build` execute as root during build, and any container started outside of compose runs as root.

**Recommendation:** Add to each Dockerfile:
```dockerfile
RUN addgroup --system app && adduser --system --ingroup app app
USER app
```

---

### H-06: `.gitignore` Missing Critical Data Exclusions

**Severity:** 🟠 High
**Category:** Secrets Management
**Affected:** `.gitignore`

The following patterns are **not** excluded:
| Missing Pattern | Risk |
|----------------|------|
| `data/wallet.json` | Wallet secrets committed |
| `data/*.db` / `*.sqlite` | Database files may contain wallet data |
| `data/redis/` | Redis persistence files |
| `data/mongodb/` | MongoDB data files |
| `data/ipfs/` | IPFS data |
| `*.pem`, `*.key` | Private key files |

**Recommendation:** Add comprehensive data exclusions:
```gitignore
data/wallet.json
data/*.db
data/redis/
data/mongodb/
data/ipfs/
data/grafana/
data/prometheus/
*.pem
*.key
```

---

### H-07: Chrome Extension `<all_urls>` Permissions

**Severity:** 🟠 High
**Category:** Extension Security
**Affected:** `apps/chrome-extension/` — `manifest.json`

```json
"content_scripts": [{ "matches": ["<all_urls>"] }],
"host_permissions": ["<all_urls>"]
```

The content script runs on every page the user visits and the extension has host permissions for all URLs. This is an unnecessarily broad permission scope that:
- Increases attack surface if the extension is compromised
- May cause browser extension store review issues
- Allows content script to interact with all pages

**Recommendation:** Scope to specific URL patterns (e.g., `*://archon/*`, known wallet domains).

---

### H-08: Plaintext Passphrase in Offscreen Document Memory

**Severity:** 🟠 High
**Category:** Secrets Management
**Affected:** `apps/chrome-extension/src/offscreen.ts`

The wallet passphrase is stored as a plaintext string in a module-scoped variable within the offscreen document. It persists for the entire session and is retrievable by any extension page via `chrome.runtime.sendMessage`.

**Recommendation:**
- Clear passphrase from memory after a timeout
- Consider using the Web Crypto API to wrap the passphrase in a non-exportable key
- Implement session expiration requiring re-authentication

---

### H-09: Bitcoin Signet RPC Port Exposed on All Interfaces

**Severity:** 🟠 High
**Category:** Network Exposure
**Affected:** `docker-compose.btc-signet.yml`

```yaml
ports:
  - 38332:38332  # Bound to 0.0.0.0
```

Unlike MongoDB and Redis (which are correctly scoped to `127.0.0.1`), the Bitcoin signet RPC port is published to all host interfaces.

**Recommendation:** Bind to localhost: `127.0.0.1:38332:38332`

---

## 3. Medium Severity Findings

### M-01: No Input Validation Library

**Severity:** 🟡 Medium
**Category:** Input Validation

No schema validation library (Joi, Zod, AJV, etc.) is used at the API layer. Request bodies and parameters are passed directly to service methods without validation. This increases the risk of unexpected behavior, crashes, and potential injection.

**Recommendation:** Add Zod or Joi schema validation for all API request payloads.

---

### M-02: Error Messages Leak Internal Details

**Severity:** 🟡 Medium
**Category:** Information Disclosure

Both API servers return `error.message` directly to clients:
```typescript
res.status(500).json({ error: error.message });
```

This can leak stack traces, file paths, database error details, and internal class names.

**Recommendation:** Return generic error messages in production; log details server-side only.

---

### M-03: Potential NoSQL Injection via `queryDocs`

**Severity:** 🟡 Medium
**Category:** Injection
**Affected:** Gatekeeper `POST /dids/query`

A user-controlled `where` object is passed directly to the query layer:
```typescript
const where = req.body?.where;
const dids = await gatekeeper.queryDocs(where);
```

If the backing store is MongoDB, operators like `$gt`, `$regex`, `$where` could be injected.

**Recommendation:** Validate/sanitize the `where` object; whitelist allowed query operators.

---

### M-04: Empty Passphrase Fallback

**Severity:** 🟡 Medium
**Category:** Configuration Security
**Affected:** `services/keymaster/server/` config, `sample.env`

```
ARCHON_ENCRYPTED_PASSPHRASE=     # empty in sample.env
keymasterPassphrase: process.env.ARCHON_ENCRYPTED_PASSPHRASE || ''
```

An empty or trivial passphrase renders mnemonic encryption ineffective.

**Recommendation:** Enforce minimum passphrase length/complexity at startup. Refuse to start if passphrase is empty or below a threshold.

---

### M-05: Default Credentials in `sample.env`

**Severity:** 🟡 Medium
**Category:** Secrets Management

`sample.env` contains default credentials likely copied verbatim to production:
- `ARCHON_BTC_USER=bitcoin` / `ARCHON_BTC_PASS=bitcoin`
- `ARCHON_BTC_T4_USER=testnet4` / `ARCHON_BTC_T4_PASS=testnet4`
- `ARCHON_SIGNET_USER=signet` / `ARCHON_SIGNET_PASS=signet`
- `GRAFANA_ADMIN_USER=admin` / `GRAFANA_ADMIN_PASSWORD=admin`

**Recommendation:** Use placeholder values like `CHANGE_ME_REQUIRED` and validate at startup.

---

### M-06: No Health Checks on Containers

**Severity:** 🟡 Medium
**Category:** Reliability / Security

No `healthcheck:` blocks are defined for any service. `depends_on` only waits for container start, not readiness. Services may connect to unready databases.

**Recommendation:** Add health checks to all critical services.

---

### M-07: No Resource Limits on Containers

**Severity:** 🟡 Medium
**Category:** Availability

No `mem_limit` or `cpus` constraints are set. A runaway container can consume all host resources.

**Recommendation:** Set `deploy.resources.limits` for all services.

---

### M-08: No Docker Network Segmentation

**Severity:** 🟡 Medium
**Category:** Network Security

All containers share the default bridge network. A compromised explorer or react-wallet container can directly access MongoDB, Redis, Bitcoin RPC, and all internal services.

**Recommendation:** Segment into networks: `frontend`, `backend`, `database`, `blockchain`.

---

### M-09: Broad Volume Mounts

**Severity:** 🟡 Medium
**Category:** Container Security

The entire `./data` directory is mounted into multiple containers (gatekeeper, keymaster, satoshi mediators). A compromised container has read/write access to all persistent data.

**Recommendation:** Mount only the specific subdirectory each service needs.

---

### M-10: Untrusted URL Parameters from Web Pages

**Severity:** 🟡 Medium
**Category:** Extension Security
**Affected:** `apps/chrome-extension/src/contentScript.ts`

The content script extracts `challenge` and `did` parameters from `archon://` URLs on any web page and forwards them to the extension background via `chrome.runtime.sendMessage`. Any website can craft malicious `archon://` links.

**Recommendation:** Validate and sanitize parameters before processing. Consider a whitelist of allowed parameter formats.

---

### M-11: `wasm-unsafe-eval` in Extension CSP

**Severity:** 🟡 Medium
**Category:** Extension Security

```json
"content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

`wasm-unsafe-eval` allows WebAssembly execution with eval-like semantics. Likely needed for crypto WASM modules but expands the attack surface.

**Recommendation:** Document the justification. Ensure no untrusted WASM can be loaded.

---

### M-12: PBKDF2 Iterations Overridable via Environment Variable

**Severity:** 🟡 Medium
**Category:** Cryptographic Configuration
**Affected:** `packages/keymaster/src/encryption.ts`

```typescript
if (typeof process !== 'undefined' && process.env?.PBKDF2_ITERATIONS) {
    const parsed = parseInt(process.env.PBKDF2_ITERATIONS, 10);
    if (!isNaN(parsed) && parsed > 0) {
        return parsed;
    }
}
return ENC_ITER_DEFAULT; // 100,000
```

The PBKDF2 iteration count can be reduced to `1` via environment variable, making the KDF trivially brutable.

**Recommendation:** Enforce a minimum floor (e.g., 100,000) regardless of environment variable.

---

## 4. Low Severity Findings

### L-01: `mongo:8.0` Not Pinned to Patch Version

Pin to `mongo:8.0.4` (or specific patch) and consider SHA256 digest pinning for supply-chain hardening.

### L-02: Build Tools Remain in Final Images

`Dockerfile.hyperswarm` installs `python3`, `make`, `g++` for native module compilation but leaves them in the final image. Use multi-stage builds to reduce attack surface.

### L-03: CLI Container Runs Idle

`Dockerfile.cli` uses `CMD ["tail", "-f", "/dev/null"]` keeping the container alive indefinitely. Use one-shot execution (`docker compose run --rm cli ...`).

### L-04: No `security_opt` or Capability Dropping

No service uses `security_opt: [no-new-privileges:true]` or `cap_drop: [ALL]`. Containers retain default Linux capabilities.

### L-05: No Restart Policies

No `restart:` policy is defined on any service. Critical services stay down after crashes.

### L-06: `@noble/ciphers` on Pre-Stable 0.x

`packages/cipher/package.json` uses `@noble/ciphers` ^0.4.1. The current stable line is 1.x.

### L-07: `@capacitor/core` on Alpha

Both `apps/react-wallet` and `apps/chrome-extension` depend on `@capacitor/core` ^2.0.0-alpha.39. Alpha packages may contain unpatched security issues.

### L-08: Express 4.x in Maintenance Mode

Both services use Express ^4.21.0. Express 5 is now available with improved security defaults.

### L-09: Prometheus Metrics Publicly Accessible

Both API servers expose `/metrics` endpoints without authentication, leaking operational data (memory usage, request counts, timing, etc.).

### L-10: Redis Has No Authentication (Downgraded from C-05)

While Redis has no `requirepass` configured, the host port binding in `docker-compose.yml` is `127.0.0.1:6379:6379` (localhost only), and Redis is isolated within the Docker bridge network. It is not reachable from external networks. Access is limited to other containers in the compose stack and local host processes.

**Remaining risk:** A compromised container could perform lateral movement to Redis. Adding `requirepass` would provide defense-in-depth.

**Recommendation:** Consider adding authentication as a hardening measure:
```properties
requirepass <strong_random_password>
```

### L-11: Bitcoin RPC Hardcoded Credentials (Downgraded from C-06)

Simple RPC credentials exist in `bitcoin.conf` files for signet and testnet4. However, the signet RPC port is now bound to `127.0.0.1:38332` (localhost only), and testnet4 has no port mapping at all. Both are test networks with no real funds. Access is limited to the Docker network and local host processes.

**Remaining risk:** Credentials are in Git history. A compromised container could access the Bitcoin RPC within the Docker network.

**Recommendation:** Consider switching to `rpcauth` (hashed credentials) and moving passwords to `.env`.

### L-12: MongoDB Has No Authentication (Downgraded from C-07)

MongoDB is deployed without authentication, but the port is bound to `127.0.0.1:27017:27017` (localhost only) and is isolated within the Docker bridge network. It is not reachable from external networks. Access is limited to other containers in the compose stack and local host processes.

**Remaining risk:** A compromised container could access MongoDB without credentials within the Docker network.

**Recommendation:** Consider enabling authentication as a hardening measure:
```yaml
mongodb:
  image: mongo:8.0.4
  command: mongod --auth
  environment:
    - MONGO_INITDB_ROOT_USERNAME=${MONGO_USER}
    - MONGO_INITDB_ROOT_PASSWORD=${MONGO_PASS}
```

---

## 5. Informational / Positive Findings

The audit identified several security-positive patterns:

| Area | Assessment |
|------|-----------|
| **Cryptographic primitives** | ✅ Sound choices — secp256k1 via `@noble/secp256k1`, XChaCha20-Poly1305, AES-256-GCM, PBKDF2 with SHA-512 (100K iterations) |
| **No `eval()` / `exec()` / `Function()`** | ✅ No dynamic code execution found in any source file |
| **Parameterized SQL queries** | ✅ All SQLite operations use parameterized queries — no SQL injection risk |
| **No XSS vectors in source** | ✅ No `dangerouslySetInnerHTML` or `innerHTML` usage in application source code |
| **Chrome Extension uses Manifest V3** | ✅ More secure than V2; no `externally_connectable` or `web_accessible_resources` |
| **Wallet encryption** | ✅ Mnemonic encrypted at rest with AES-256-GCM + PBKDF2; random 16-byte salt and 12-byte IV per encryption |
| **BIP39 mnemonic generation** | ✅ Uses standard `bip39.generateMnemonic()` with proper entropy |
| **HD key derivation** | ✅ Standard BIP32 via `hdkey` package from master seed |
| **Signature verification** | ✅ ECDSA (secp256k1) with proper hash-then-sign pattern |
| **Redis Lua scripts** | ✅ Hardcoded script strings; arguments passed as ARGV parameters (not interpolated) |
| **Base images version-pinned** | ✅ All Dockerfiles use `node:22.15.0-bullseye-slim` |
| **JSON canonicalization** | ✅ Uses `canonicalize` for deterministic JSON before hashing/signing |

---

## Remediation Applied

The following changes were implemented in the `release-0.2` branch to address the most critical findings:

### 1. Admin API Key Middleware (C-01, C-02, C-03)

**Files changed:**
- `services/gatekeeper/server/src/gatekeeper-api.ts`
- `services/keymaster/server/src/keymaster-api.ts`
- `services/gatekeeper/server/src/config.js`
- `services/keymaster/server/src/config.js`

A `requireAdminKey` middleware was added to both services. When `ARCHON_ADMIN_API_KEY` is set, all admin routes require `Authorization: Bearer <key>`. This protects against reverse proxy misconfiguration.

**Gatekeeper admin routes protected:** `/dids/remove`, `/db/reset`, `/db/verify`
**Keymaster admin routes protected:** All `/wallet/*` routes, `/did/:id` (DELETE), `/ids` (POST/DELETE), `/keys/rotate`, `/assets/:id/transfer`, `/export/wallet/encrypted`

### 2. Production Guard on Database Reset (C-02)

`GET /api/v1/db/reset` now returns `403 Forbidden` when `NODE_ENV=production`, regardless of API key.

### 3. Configurable Bind Address (H-01)

**Files changed:** `services/*/server/src/config.js`, `docker-compose.yml`, `sample.env`

Both services now support `ARCHON_BIND_ADDRESS` (default `0.0.0.0`). Set to `127.0.0.1` in production so only the local reverse proxy can reach the services.

### 4. Sample Nginx Reverse Proxy Configuration

**File added:** `doc/nginx-proxy.conf.example`

A comprehensive nginx configuration that:
- Exposes only public-safe Gatekeeper endpoints
- Blocks all admin, internal, and metrics routes
- Adds rate limiting zones (30 req/s general, 5 req/s writes)
- Includes security headers (X-Content-Type-Options, X-Frame-Options, etc.)
- Provides HTTPS/TLS server block template
- Documents the recommended deployment pattern

### Deployment Quick Start

```bash
# 1. Generate a strong admin API key
echo "ARCHON_ADMIN_API_KEY=$(openssl rand -hex 32)" >> .env

# 2. Bind services to localhost only
echo "ARCHON_BIND_ADDRESS=127.0.0.1" >> .env

# 3. Set up nginx with the provided config
sudo cp doc/nginx-proxy.conf.example /etc/nginx/sites-available/archon
# Edit server_name and TLS settings
sudo ln -s /etc/nginx/sites-available/archon /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Remediation Roadmap

### Phase 1 — Immediate (Critical / High) — Target: 2 weeks

| Priority | Action | Effort | Status |
|----------|--------|--------|--------|
| 1 | Add authentication middleware to Gatekeeper and Keymaster APIs | Medium | ✅ Done |
| 2 | Remove or protect `GET /db/reset` and `GET /wallet/mnemonic` endpoints | Low | ✅ Done |
| 3 | Remove `data/wallet.json` from Git history (`git filter-repo`) and rotate keys | Low | ⬜ Open |
| 4 | Add `requirepass` to Redis config; enable MongoDB auth | Low | ⬜ Open |
| 5 | Restrict Bitcoin RPC `rpcallowip` to Docker internal CIDR | Low | ⬜ Open |
| 6 | Add `helmet` middleware to both Express servers | Low | ⬜ Open |
| 7 | Add rate limiting at proxy level | Low | ✅ Done (nginx config) |
| 8 | Restrict CORS to specific allowed origins | Low | ⬜ Open |
| 9 | Update `.gitignore` with comprehensive data exclusions | Low | ⬜ Open |
| 10 | Bind Bitcoin RPC ports to `127.0.0.1` in compose files | Low | ⬜ Open |

### Phase 2 — Short-Term (Medium) — Target: 4 weeks

| Priority | Action | Effort |
|----------|--------|--------|
| 11 | Add Zod/Joi input validation schemas for all API endpoints | Medium |
| 12 | Sanitize error responses (generic messages in production) | Low |
| 13 | Validate/sanitize `queryDocs` `where` parameter | Low |
| 14 | Enforce minimum passphrase strength at startup | Low |
| 15 | Replace default credentials in `sample.env` with `CHANGE_ME` placeholders | Low |
| 16 | Add Docker health checks to all services | Medium |
| 17 | Implement Docker network segmentation | Medium |
| 18 | Scope Chrome extension `<all_urls>` to necessary domains | Low |
| 19 | Add passphrase timeout/expiration in Chrome extension | Medium |
| 20 | Set minimum floor for PBKDF2 iterations | Low |

### Phase 3 — Ongoing (Low + Hardening) — Target: 8 weeks

| Priority | Action | Effort |
|----------|--------|--------|
| 21 | Add `USER` directives to all Dockerfiles | Low |
| 22 | Implement TLS/HTTPS (reverse proxy or direct) | Medium |
| 23 | Add Docker resource limits | Low |
| 24 | Scope volume mounts to per-service subdirectories | Low |
| 25 | Add `security_opt` and `cap_drop` to compose | Low |
| 26 | Multi-stage Docker builds to remove build tools | Medium |
| 27 | Upgrade `@noble/ciphers` to stable 1.x | Low |
| 28 | Upgrade Express to 5.x | Medium |
| 29 | Set up automated dependency vulnerability scanning (Dependabot / Snyk) | Low |
| 30 | Implement audit logging for sensitive operations | Medium |

---

## Appendix — Files Reviewed

### Configuration & Infrastructure
- `package.json` (root)
- `sample.env` *(updated with `ARCHON_BIND_ADDRESS` and `ARCHON_ADMIN_API_KEY`)*
- `.gitignore`
- `docker-compose.yml` *(updated with new env vars)*
- `docker-compose.btc-mainnet.yml`
- `docker-compose.btc-signet.yml`
- `docker-compose.btc-testnet4.yml`
- `Dockerfile.cli`, `Dockerfile.explorer`, `Dockerfile.gatekeeper`, `Dockerfile.hyperswarm`, `Dockerfile.keymaster`, `Dockerfile.react-wallet`, `Dockerfile.satoshi`
- `data/redis.conf`
- `data/wallet.json`
- `data/btc-signet/bitcoin.conf`
- `data/btc-testnet4/bitcoin.conf`
- `observability/prometheus/prometheus.yml`

### Core Packages
- `packages/cipher/src/cipher-base.ts`
- `packages/cipher/src/cipher-node.ts`
- `packages/cipher/src/cipher-web.ts`
- `packages/cipher/src/types.ts`
- `packages/cipher/package.json`
- `packages/gatekeeper/src/gatekeeper.ts`
- `packages/gatekeeper/src/gatekeeper-client.ts`
- `packages/gatekeeper/src/db/` (all DB implementations)
- `packages/gatekeeper/package.json`
- `packages/keymaster/src/keymaster.ts`
- `packages/keymaster/src/keymaster-client.ts`
- `packages/keymaster/src/encryption.ts`
- `packages/keymaster/src/db/` (all DB implementations)
- `packages/keymaster/package.json`
- `packages/common/package.json`
- `packages/ipfs/package.json`

### Services
- `services/gatekeeper/server/src/` (server entry, routes, config)
- `services/gatekeeper/server/package.json`
- `services/keymaster/server/src/` (server entry, routes, config)
- `services/keymaster/server/package.json`

### Client Applications
- `apps/chrome-extension/src/` (manifest, background, content script, offscreen, popup)
- `apps/chrome-extension/package.json`
- `apps/react-wallet/src/` (App, auth-related components)
- `apps/react-wallet/package.json`

---

*This report was generated through automated static analysis of the repository source code, configuration files, and infrastructure definitions. It does not include dynamic testing, penetration testing, or runtime analysis. Findings should be validated by the development team before remediation.*

### Files Added/Modified in Remediation
- `services/gatekeeper/server/src/config.js` — added `bindAddress`, `adminApiKey`
- `services/gatekeeper/server/src/gatekeeper-api.ts` — added `requireAdminKey` middleware, production guard on `/db/reset`
- `services/keymaster/server/src/config.js` — added `bindAddress`, `adminApiKey`
- `services/keymaster/server/src/keymaster-api.ts` — added `requireAdminKey` middleware to all admin routes
- `docker-compose.yml` — passes `ARCHON_BIND_ADDRESS` and `ARCHON_ADMIN_API_KEY` to services
- `sample.env` — documents new security env vars
- `doc/nginx-proxy.conf.example` — new file: sample reverse proxy configuration
