# Forking and Rebranding Project: Archon

## Overview

This document tracks the forking and rebranding effort from MDIP/Keychain to **Archon**.

## Status: COMPLETE

---

## Decisions Needed

- [x] New project name: **Archon**
- [x] New package names - `@didcid/*` scope
- [x] New DID method prefix - `did:cid` instead of `did:mdip`
- [ ] New protocol identifiers
- [ ] Domain/URLs for documentation and services
- [ ] License considerations

## Scope of Changes

### 1. NPM Packages (119 files reference @mdip/*)
| Current | Proposed |
|---------|----------|
| `@mdip/cipher` | `@didcid/cipher` |
| `@mdip/common` | `@didcid/common` |
| `@mdip/gatekeeper` | `@didcid/gatekeeper` |
| `@mdip/inscription` | `@didcid/inscription` |
| `@mdip/ipfs` | `@didcid/ipfs` |
| `@mdip/keymaster` | `@didcid/keymaster` |
| Root: `keychain` | `archon` |

### 2. DID Method Prefix (20+ files)
| Current | Proposed |
|---------|----------|
| `did:mdip:` | `did:cid:` |

### 3. Repository/GitHub URLs (10+ files)
| Current | Proposed |
|---------|----------|
| `github.com/KeychainMDIP/kc` | `github.com/archetech/archon` |
| `keychain.org` | `archetech.github.io/archon` |

### 4. Docker Images (docker-compose.yml + 3 workflows)
Using GitHub Container Registry: `ghcr.io/archetech/*`

| Current | Proposed |
|---------|----------|
| `keychainmdip/gatekeeper` | `ghcr.io/archetech/gatekeeper` |
| `keychainmdip/keymaster` | `ghcr.io/archetech/keymaster` |
| `keychainmdip/hyperswarm-mediator` | `ghcr.io/archetech/hyperswarm-mediator` |
| `keychainmdip/satoshi-mediator` | `ghcr.io/archetech/satoshi-mediator` |
| `keychainmdip/inscription-mediator` | `ghcr.io/archetech/inscription-mediator` |
| `keychainmdip/cli` | `ghcr.io/archetech/cli` |
| `keychainmdip/explorer` | `ghcr.io/archetech/explorer` |
| `keychainmdip/search-server` | `ghcr.io/archetech/search-server` |
| `keychainmdip/react-wallet` | `ghcr.io/archetech/react-wallet` |
| `keychainmdip/feathercoin` | `ghcr.io/archetech/feathercoin` |
| `keychainmdip/bitcoin-core` | `ghcr.io/archetech/bitcoin-core` |

### 5. Configuration & Environment
| Current | Proposed |
|---------|----------|
| `KC_MDIP_PROTOCOL=/MDIP/v1.0-public` | `/ARCHON/v0.1` |
| `KC_*` env var prefix | `ARCHON_*` |

### 6. Android App (4 files)
| Current | Proposed |
|---------|----------|
| `org.keychain.android` | `org.archon.android` or similar |
| `android:scheme="mdip"` | `android:scheme="archon"` |

### 7. Python SDK
| Current | Proposed |
|---------|----------|
| `keymaster-sdk` | `keymaster-sdk` (no change) |

### 8. CLI Scripts
| Current | Proposed |
|---------|----------|
| `kc` wrapper | `archon` |
| `keychain-cli.js` | `archon-cli.js` |

### 9. Documentation (~30 markdown files)
- All README files in packages/
- Protocol specification in doc/01-protocol/
- Deployment guides
- CLI documentation

---

## Decisions Made

| Decision | Old Value | New Value | Date | Notes |
|----------|-----------|-----------|------|-------|
| Project name | MDIP/Keychain | Archon | Today | |
| DID prefix | `did:mdip` | `did:cid` | Today | Content-addressed ID |
| NPM scope | `@mdip` | `@didcid` | Today | Matches DID method |
| GitHub repo | `KeychainMDIP/kc` | `archetech/archon` | Today | |
| Container registry | Docker Hub `keychainmdip/*` | GHCR `ghcr.io/archetech/*` | Today | |
| Docs website | `keychain.org` | `archetech.github.io/archon` | Today | GitHub Pages |
| Env var prefix | `KC_*` | `ARCHON_*` | Today | |
| CLI command | `kc` | `archon` | Today | |
| Service names | `gatekeeper`/`keymaster` | Keep same | Today | Descriptive, less churn |

---

## Decisions Pending

All major decisions have been made. Ready to begin implementation.

---

## Implementation Plan

### Phase 1: Preparation ✓
- [x] Audit all brand references in codebase
- [x] Make key naming decisions (above)
- [x] Set up new npm org/Docker registry if needed

### Phase 2: Core Code Changes ✓
- [x] Update all package.json names and dependencies
- [x] Update DID method prefix in code
- [x] Update protocol identifiers
- [x] Update imports across all files

### Phase 3: Configuration & Docker ✓
- [x] Update docker-compose.yml image names
- [x] Update environment variable names/defaults
- [x] Update sample.env

### Phase 4: Documentation ✓
- [x] Update all README files
- [x] Update protocol specification
- [x] Update deployment guides
- [x] Update CLI documentation

### Phase 5: CI/CD & External ✓
- [x] Update GitHub Actions workflows
- [x] Update Docker Hub/registry references
- [ ] Update Android app package naming (deferred - not in scope)

### Phase 6: Verification ✓
- [x] Run full test suite (959 tests passing, 97.76% coverage)
- [x] Verify all imports resolve
- [x] Test DID creation/resolution with new prefix
- [ ] Build all Docker images (requires CI/CD setup)
- [ ] Manual testing of key workflows (requires runtime setup)

---

## Notes

### File counts by category:
- 119 files reference `@mdip/*` packages
- 20+ files contain `did:mdip` examples
- 10+ package.json files with repository URLs
- 30+ markdown documentation files

### Breaking changes:
- All downstream consumers of `@mdip/*` packages will need to update imports
- Existing DIDs with `did:mdip` prefix will not be compatible
- Docker image users will need to update their configurations

