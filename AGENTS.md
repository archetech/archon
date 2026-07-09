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
- For repo-wide version sweeps, search tracked files with `git ls-files` rather than raw filesystem traversal so local `node_modules`, `data`, and build outputs cannot pollute the bump.
- For focused Rust Gatekeeper fixes, avoid broad `cargo fmt` churn if the crate has pre-existing formatting drift; format only touched code or trim unrelated rustfmt changes before committing.
- Internal service-to-service admin auth should use `X-Archon-Admin-Key` consistently. Reserve `Authorization` for user/session/OAuth-style flows unless a file explicitly documents a different scheme.
- Drawbridge's bundled Tor SOCKS host port should default to `127.0.0.1:9050`; internal services should keep using the Docker network address `tor:9050`.
- Keymaster's Docker host port should default to localhost via `ARCHON_KEYMASTER_HOST_BIND=127.0.0.1`; internal services should keep using `keymaster:4226`.
- Server-side Keymaster can use Drawbridge as its Gatekeeper URL when it needs Drawbridge-hosted gateway features; in compose, set `ARCHON_KEYMASTER_GATEKEEPER_URL=http://drawbridge:4222` rather than changing the host-facing `ARCHON_GATEKEEPER_URL`.
- For Herald agent guidance, prefer Keymaster address commands (`check-address`, `add-address`, `remove-address`, etc.) in quick starts while keeping direct API endpoint documentation available for lower-level integrations.
- Bundled LNbits may start before CLN REST is ready after CLN startup or sync; keep the CLN REST startup wait configurable and long enough for cold starts.
- Keymaster address metadata should stay in parity across TypeScript and Python implementations; when Herald exposes a domain relay agent, store it with the address as `relay` and surface it through list/get address APIs.
- Keymaster CLI command additions should keep `scripts/archon-cli.js`, `packages/keymaster/src/cli.ts`, and `python/keymaster/src/keymaster/cli.py` in parity; commands that only query Gatekeeper, such as registry listing, should not require an existing local wallet.
- Publishing a Keymaster address always sets `didDocumentData.address`; it adds the `#email` service endpoint with `type: "Email"` and `serviceEndpoint: "mailto:<address>"` only when the stored address has a Herald `relay`. Unpublishing removes both the property and the service.
- After a PR is merged, always do the standard local cleanup unless the user says otherwise: switch to `main`, fast-forward from `origin/main`, and delete the merged local branch.
- Do not use stash-based branch juggling as the default workflow.
- Never run mutating git operations in parallel. Serialize `git add`, `git commit`, `git push`, branch moves, stash operations, and any command that writes to `.git`.
- After opening a PR, add follow-up fixes with normal commits and regular pushes; do not amend published commits or force-push unless the user explicitly requests history rewriting.
- When the user asks to evaluate PR comments, only inspect and assess the comments. Do not edit code, commit, push, reply, or resolve threads unless the user explicitly asks for action after the evaluation.
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
- Ethereum and Solana mediator Grafana dashboards should mirror the Satoshi/Zcash chain dashboard layout. Use `ethereum_*` plus `wallet_balance_confirmed_eth`, `wallet_fee_estimate_wei`, and `wallet_eth_block_height` for ETH; use `solana_*` plus `wallet_balance_confirmed_sol` and `wallet_solana_slot_height` for SOL.
- Release version bumps must include every runtime flavor and client package, not only JavaScript services: root `package.json`/`package-lock.json`, Rust Gatekeeper `Cargo.toml`/`Cargo.lock`, Python Keymaster service metadata, Python Keymaster runtime metadata (`python/keymaster_service/src/keymaster_service/__init__.py` and fallback in `config.py`), Python SDK metadata, and any service/app `package.json` files that report `/version` or `service_version_info`.
- NPM package publishing must target `https://registry.npmjs.org` in both workflow setup and Lerna publish config. After a publish failure that already pushed version commits/tags, recover by publishing current package versions with Lerna `from-package` rather than running another version bump.
- NPM provenance/trusted publishing requires a current npm CLI for the publish step; if npm returns `E404 Not found` after OIDC exchange, upgrade the publish-step npm before falling back to token-only publishing.
- Lerna `from-git` only publishes tags on the checked-out commit; if release workflow fixes move the branch past the version tags, `from-git` can exit successfully with "No tagged release found". Recovery workflows must check out the tagged release commit or fail when the publish summary is empty.
- Ethereum Archon registries should use one canonical `ArchonRegistry` contract per registry name (for example `ETH:sepolia`); custom/private deployments need distinct registry naming or explicit non-canonical configuration to avoid fragmenting discovery.
- Ethereum mediator Gatekeeper block checkpoints are canonical every 10 confirmed blocks (`height % 10 == 0`) starting at `ARCHON_ETH_START_BLOCK`, and any block containing an `ArchonBatch` event must also be recorded for exact upper-bound timestamps. Keep the mediator's private scan cursor exact even when Gatekeeper block storage is sparse.
- Solana Archon registry support currently uses the Solana Memo program with an `ARCHON_BATCH_V1:` payload prefix and a deterministic registry address for `SOL:mainnet-beta` and `SOL:devnet`; discover by registry address, do not scan every slot or the global Memo program, and keep any future custom Solana program under a distinct canonical registry decision.
- Solana Memo instruction accounts are signer attestations. Do not attach a registry marker account as read-only/non-signer; canonical Memo-based Solana registries need a deterministic signer marker or a real custom program.
- Solana mediator scan cursors are internal slots, but Gatekeeper registration/block metadata should use produced Solana block heights. Keep `ARCHON_SOL_START_BLOCK` as the only operator-facing import/register floor; do not expose a Solana start-slot env var.
- Solana mediator block checkpoints are canonical every 100 finalized produced blocks (`blockHeight % 100 == 0`) starting at `ARCHON_SOL_START_BLOCK`; do not make this interval configurable because all nodes must independently produce the same checkpoint set.
- Auxiliary storage pinning is opt-in by registry through `ARCHON_GATEKEEPER_REGISTRIES_PIN`; consumers drain the generic `pin` queue, and local/ephemeral DIDs stay out of pin queues by default because storage can have ongoing payment cost.
- Generic pinning provider requests should not include registry in the human-readable pin name or provider metadata; the pin is identified by operation fingerprint/CID, while registry only controls enqueue eligibility.
- Optional Docker Compose fragments should remain included from the root `docker-compose.yml` and be toggled with Docker Compose profiles via `COMPOSE_PROFILES`; avoid asking operators to comment include files in and out by hand.
- Generic auxiliary pinning should target the standard IPFS Pinning Service API from the `pin` queue when possible; reserve per-operation Filecoin/Synapse storage for cases that need Filecoin proofs because small Archon ops are dominated by provider minimums and setup fees.
- `pin` in Gatekeeper `supportedRegistries` can be both the auxiliary pin queue and a DID registration registry when enabled; do not assume old auxiliary-only rejection semantics still apply.
