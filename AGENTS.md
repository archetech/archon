# Archon Agent Workflow

These rules apply to coding agents working in this repository.

## Branching

- Treat each new task or new PR as a new branch from `main` unless the user explicitly says to continue on the current branch.
- Never commit directly on `main` unless the user explicitly requests it.
- Never mix unrelated changes on the same branch.

## Before Committing

- Check the current branch before making a commit if the task has changed or if there is any ambiguity about scope.
- If the current branch contains unrelated work, create a new branch from `main` before proceeding.
- When a PR shows unexpected files or checks fail on unrelated paths, inspect branch ancestry and merge-base state before making code changes.
- If a feature branch was started from stale local history, rebuild it from `origin/main` early instead of patching around the contamination.

## Hygiene

- Always save lessons learned in this file or another persistent repo instruction file. Do not rely on session memory for process corrections.
- Herald avatar/image handlers that use `KeymasterClient` should normalize JSON-serialized Buffer payloads (`{ type: "Buffer", data: [...] }`) back into real `Buffer` instances before sending binary responses.
- Keep `apps/gatekeeper-client/src/KeymasterUI.jsx` and `apps/keymaster-client/src/KeymasterUI.jsx` identical. When one changes, update the other to match rather than maintaining intentional drift.
- For GitHub operations in this repo, use `gh` by default, especially for write actions and PR creation. Do not try the GitHub app first and then fall back to `gh` unless the user explicitly asks for the app or `gh` cannot perform the operation.
- When generating or updating npm lockfiles, use the repo-pinned npm version from the root `package.json` so lockfiles stay compatible with CI.
- Internal service-to-service admin auth should use `X-Archon-Admin-Key` consistently. Reserve `Authorization` for user/session/OAuth-style flows unless a file explicitly documents a different scheme.
- For Herald agent guidance, prefer Keymaster address commands (`check-address`, `add-address`, `remove-address`, etc.) in quick starts while keeping direct API endpoint documentation available for lower-level integrations.
- Keymaster address metadata should stay in parity across TypeScript and Python implementations; when Herald exposes a domain relay agent, store it with the address as `relay` and surface it through list/get address APIs.
- Publishing a Keymaster address always sets `didDocumentData.address`; it adds the `#email` service endpoint with `type: "Email"` and `serviceEndpoint: "mailto:<address>"` only when the stored address has a Herald `relay`. Unpublishing removes both the property and the service.
- After a PR is merged, always do the standard local cleanup unless the user says otherwise: switch to `main`, fast-forward from `origin/main`, and delete the merged local branch.
- Do not use stash-based branch juggling as the default workflow.
- Never run mutating git operations in parallel. Serialize `git add`, `git commit`, `git push`, branch moves, stash operations, and any command that writes to `.git`.
- Prefer a clean branch cut over moving changes around after the fact.
- If branch state becomes confusing, stop and cleanly reestablish scope before making more commits.
- When adding Prometheus HTTP route labels, normalize dynamic path segments like DIDs, hashes, txids, and CIDs before recording metrics so dashboards do not create one time series per identifier.
- Nostr event IDs in Python parity code must use compact JSON serialization (`separators=(",", ":")`) to match the TypeScript `JSON.stringify` hashing/signing contract.
- Python Lightning invoice parity should only surface `expiry` and `expires` when the BOLT11 invoice actually includes an expiry tag; the `bolt11` library exposes a default expiry even when the tag is absent.
- Python keymaster flavor runs in CLI CI use `ARCHON_KEYMASTER_DB=redis` exactly like the TypeScript service; no override is needed.
- The Python keymaster service MUST be a drop-in replacement for the TypeScript keymaster. `docker/compose/keymaster-py.yml` and `docker/compose/keymaster-ts.yml` must agree on env, ports, healthcheck behaviour, volumes, and `user:` overrides. The data dir is a host bind mount of `./data` running as `${ARCHON_UID}:${ARCHON_GID}`, identical to the ts flavor — do not switch py to a named volume to dodge UID issues; fix the UID setup instead.
- For Python package publishing prep, build and check artifacts locally, but do not upload to TestPyPI or PyPI unless the user explicitly asks for publication.
- When reproducing Python CI checks locally, prefer the repo `.venv` Python so helper scripts and imports run in the same prepared environment.
- Satoshi mediator discovered items must be unique by height/index/txid/DID; duplicate rows can leave later copies unimported and make the import loop reprocess the same batches every interval.
- The Zcash wallet service is Zebra-backed and transparent-only: Zebra provides chain/address-index/broadcast RPCs, while the wallet derives transparent keys from the Keymaster mnemonic and signs locally. Do not assume Zebra has wallet RPCs like `getwalletinfo`.
- Zcash transparent wallet broadcasts should use the NU6.1 v4 transaction builder path unless v5 transparent signatures have been proven against Zebra; v5-built P2PKH spends can fail Zebra consensus validation with `ScriptInvalid`.
- Zcash transparent wallet fees must satisfy ZIP-317 action-based conventional fees, not only byte-rate estimates; low-fee anchors can be rejected by Zebra as `Unpaid actions is higher than the limit`.
- Keep Zcash mediator registry strings as `ZEC:mainnet`/`ZEC:testnet` distinct from Bitcoin `BTC:*`; Gatekeeper accepts well-formed registry names generically, while mediator-specific registry restrictions belong in mediator config/validation.
- Gatekeeper confirmed-resolution peer fallback is HTTP-layer proxy behavior only. It should not import events, cache delegated documents, or change core Gatekeeper package resolution semantics unless explicitly requested.
- Gatekeeper registry validation is name-shape validation, not a closed allowlist. Use `supportedRegistries` to decide what a node can create/update/queue locally, and keep mediator-specific registry restrictions inside the mediators.
- Rust Gatekeeper timestamp upper bounds must come from event-level blockchain registration metadata (`height`, `txid`, `batch`, `opidx`), not DID operation registration (`version`, `type`, `registry`).
- Zcash mediator Grafana dashboards should mirror the Satoshi mediator layout, but use `zcash_*` mediator metrics, `wallet_balance_*_zec`, and `wallet_fee_estimate_zat_per_vb` for the ZEC wallet.
- Release version bumps must include every runtime flavor and client package, not only JavaScript services: root `package.json`/`package-lock.json`, Rust Gatekeeper `Cargo.toml`/`Cargo.lock`, Python Keymaster service metadata, Python SDK metadata, and any service/app `package.json` files that report `/version` or `service_version_info`.
- Ethereum Archon registries should use one canonical `ArchonRegistry` contract per registry name (for example `ETH:sepolia`); custom/private deployments need distinct registry naming or explicit non-canonical configuration to avoid fragmenting discovery.
- Solana devnet Archon registry support currently uses the Solana Memo program with an `ARCHON_BATCH_V1:` payload prefix and a deterministic registry address for `SOL:devnet`; discover by registry address, do not scan every slot or the global Memo program, and keep any future custom Solana program under a distinct canonical registry decision.
- Solana Memo instruction accounts are signer attestations. Do not attach a registry marker account as read-only/non-signer; canonical Memo-based Solana registries need a deterministic signer marker or a real custom program.
