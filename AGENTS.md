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
- Keep Gatekeeper, Drawbridge, and Keymaster HTTP clients and their wire contracts in `@didcid/clients`; do not make that package depend on the Gatekeeper, Keymaster, Cipher, or IPFS runtimes. Keymaster should consume the Drawbridge contract from this lightweight package rather than depending on Gatekeeper. Compatibility `types` modules must use type-only exports from the `*-types` entry points so their generated JavaScript stays runtime-empty.
- The demo client UI lives once, in `packages/keymaster-ui`, and both standalone clients alias it. It used to be two byte-identical copies that had to be edited in lockstep; if you find yourself adding an app-local copy back, that is the drift the move removed (#99).
- A keymaster capability should reach both UI surfaces -- the wallets (`packages/wallet-ui` plus the apps that mount it) and the standalone clients (`packages/keymaster-ui` plus theirs) -- or its absence should be recorded, with a reason, in the allowlists in `tests/wallet/ui-capability-parity.test.ts`. The clients are demos and need not carry every wallet feature; the point is that leaving one out is a decision someone wrote down rather than one nobody noticed (#935).
- For GitHub operations in this repo, use `gh` by default, especially for write actions and PR creation. Do not try the GitHub app first and then fall back to `gh` unless the user explicitly asks for the app or `gh` cannot perform the operation.
- When generating or updating npm lockfiles, use the repo-pinned npm version from the root `package.json` so lockfiles stay compatible with CI.
- Run root typechecking after package builds finish; build scripts remove `dist` first, and concurrent typechecking can report missing package exports while declarations are being regenerated.
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
- Gatekeeper HTTP route tests should import `createGatekeeperApp` from `services/gatekeeper/server/src/gatekeeper-api.ts` or `createV1Router` from `services/gatekeeper/server/src/v1-router.ts` and inject fake dependencies; keep production DB/IPFS startup behind `main()` so imports remain testable.
- When splitting Gatekeeper route files, keep `swaggerConf.js` route sources explicit and ordered so regenerated OpenAPI does not churn path ordering.
- When splitting Keymaster route files, preserve the public `/ready`, `/version`, and `/login` routes before `createRequireAdminKey(config)`, then mount protected domain routers intentionally so the admin boundary does not move. Keep address, DIDComm, Nostr, and Lightning routes in their own Keymaster routers rather than folding them back into identity routes.
- Keep Keymaster credential routes split by route family (challenge, response, groups, schemas, agents, credentials, keys, schema-template tail) and list those files in `swaggerConf.js` in mount order.
- Keep Keymaster content routes split by route family (assets, polls, images, files/IPFS, vaults, dmail, notices) and list those files in `swaggerConf.js` in mount order.
- When verifying Keymaster Swagger coverage, compare all mounted router methods against `docs/keymaster-api.json`; public routes such as `/login` need generated OpenAPI coverage too.
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

- Keep chain-position and controller-history selection in Gatekeeper event authorization, shared by imports, confirmation replacements, reorganization, and verified replay. Low-level operation verification takes an explicitly selected authorizing document and does not resolve chain history. Select replacement/reorganization authority from the operation's predecessor, not the latest state.
- When changing Gatekeeper resolution metadata, update the resolution algorithm and field-omission rules in `docs/services/gatekeeper/README.md` alongside the implementations and parity tests. Deleted documents omit `updated`, including any earlier update timestamp.

- Chain mediators must skip unavailable batch/operation references and continue importing later entries; unavailable and nonexistent content cannot be distinguished. Persist failed entries for retry across restarts, continue past failures in retry passes too, and retain original chain metadata on recovery. Skipping is not evidence of complete controller history (#1150/#1151). Archon already gossips signed operations and batch assets; do not assume key-change records are absent merely because chain anchors contain references.

- When a maintainer changes an issue’s scope or splits acceptance criteria into a follow-up, synchronize the issue bodies and PR description. Explicitly retain unresolved correctness requirements in the follow-up; resolving a review thread as tracked elsewhere does not mean the defect is fixed.

- Archon nodes derive their best current authorization state from available evidence. Keep imported candidates durably separate from accepted histories; controller-history changes must reconsider rejected candidates and replay dependent histories at the import layer. `confirmed` records anchoring, not irrevocable authorization. Preserve original chain positions, distinguish repeated anchors of the same operation during deduplication, and rank competing unanchored successors by the lexicographically smallest canonical CID (ASCII order of canonical base32 strings). Apply the preference during insertion and replay; receipt order and ordinals cannot decide unanchored forks.

- Enforce self-controlled agents and agent-only asset owners at Gatekeeper authorization, including prospective transfers and immutable DID type. Use real signed fixtures to test rejected controller cycles; do not add replay oscillation/quarantine policy for relationships the protocol forbids. Controller removal and garbage collection must replay dependents before returning; public history reads must wait for startup repair and active replay.

- Before adding protocol safeguards, demonstrate reachability with real signed operations and the ordinary importer. Mocked failure tests establish containment, not protocol validity; distinguish inputs accepted by permissive implementation code from the documented agent/asset model.

- Public history reads and verification must hold the history lock throughout asynchronous resolution, including status-cache refreshes. GC persistence failures must propagate to callers and preserve pending imports; only successful GC performs queue cleanup. Parity ingress must preserve every fixture ordinal component.

- Canonical operation identity includes the complete proof; never deduplicate by signature alone. Retrieval CIDs may alias canonical operations only through cached content, not peer-supplied opid claims. Preserve cached aliases and signed predecessor bytes during startup repair; test canonical and alias predecessors plus real storage restarts.

- Confirm-fallback eligibility compares the confirmed prefix with local resolution under the same version/time bounds. Peer replies must match the DID, respect those bounds, and advance existing confirmed state; HTTP delegation must not mutate local history.

- CID batch ingress derives `registration.opidx` from the original CID-list index in both ports, independently of the batch ordinal prefix; parity coverage must record the anchoring block to exercise timestamp metadata.

- Treat startup health timeouts after replay changes as performance regressions to measure, not merely timeout settings to increase. Benchmark populated histories in isolation; agents are self-controlled, so replay their histories before assets without repeatedly rebuilding each controller’s dependents. Finish snapshot comparisons before resetting benchmark storage.
- When optimizing signature verification, compare acceptance against the existing verifier, including high-S rejection, malformed scalars, and compressed-key interpretation. Native SHA-256 verification must receive the signing bytes before the final hash, not the digest. Compare recovered benchmark outputs because historical snapshots may still need canonical-ID repair.
- Parallel replay must account for rejected evidence in the candidate journal: mixed-type creates or misaddressed events can invalidate independence assumptions even when accepted histories obey controller rules. Preserve sequential ordering at those boundaries.
- Keep Gatekeeper startup phases observable in both implementations with aggregate counts and elapsed time. Throttle progress logs, avoid per-DID identifiers and extra database reads, and report completed work rather than timer-based apparent progress.

- Hyperswarm wraps repeated operations in fresh receipt timestamps and ordinals. Sync optimizations must cover those restamped hints, preserve their first observation per canonical operation/registry, and keep distinct blockchain anchors eligible for authorization replay.

- Mediator batch completion must use batch-scoped pending evidence, not Gatekeeper's global pending count. When event processing throws, preserve the active event and remaining queue and propagate failure; never clear work and report zero pending. Preserve retries for the batch's own deferred events, busy/failed processing, and incomplete CID fetches; keep older Gatekeeper responses conservative.

- Gatekeeper performance checks must include concurrent resolution during TypeScript/Redis status scans and unchanged deferred-event retries, not only successful duplicate imports. Compare accepted histories structurally/canonically because Redis hydration can change object key order; retain missing-evidence recovery while avoiding repeated dependent replay.

- Protocol hardening work is tracked in `docs/plans/protocol-hardening-1149.md`. Registration validation may be enforced in version 1 per the 2026-09-17 user decision after a clean production-history audit and confirmation that other nodes share the database (see `docs/plans/registration-hardening-1158.md`). Preserve historical acceptance for key-permission and byte-limit changes unless their separate compatibility policy is explicitly revised. Validate a direct operation's target predecessor before storage/queue writes; keep import's historical predecessor selection and deferred recovery.

- For cross-port interoperability bugs, fix the failing implementation first. Treat changes to generated operation CIDs or genesis identifiers as a separate protocol migration; establish that a localized repair is insufficient before expanding scope.

- Before tightening protocol acceptance, add signed cross-port fixtures for the current behavior across submission, import, and restart. Keep proposed stricter rules explicitly separate from active rules, and select future policy from immutable genesis version rather than mutable registration metadata.

- Local TypeScript operation validation must treat optional `undefined` members as JSON omission, while still rejecting malformed JSON values such as `null`. Exercise both direct SDK calls and serialized imports when tightening field validation.

- Signed negative protocol fixtures should isolate the invariant under test: keep required fields complete and avoid unrelated invalid controller/document changes. For immutable-kind cases, changing only the registration kind should make the fixture valid if that equality check is removed.

- Preserve numeric JSON-RPC error codes when wrapping Zebra responses. Reorg tests must exercise the actual HTTP-200 `{error: {code: -5, message: "block height not in best chain"}}` envelope through the RPC client; a message-only mock misses the failure that stalls checkpoint recovery.

- In Zcash scan tests, inject transport failures at the client promise boundary rather than using Nock `replyWithError`, whose mock socket can emit delayed unhandled errors between cases. Keep actual HTTP-envelope coverage for JSON-RPC application errors.

- Mediator backlog metrics must retain newly observed tips before subsequent block reads, including mid-pass tip changes; test a successful block followed by a higher tip and a failed next block. Avoid redundant persistence when the observed tip is unchanged.

- Hyperswarm historical cutoffs and resolved update/deletion dates use operation `proof.created`, not node receipt time. Set the envelope time in the mediator and normalize imported/stored candidates before replay; resolution reads event time. Preserve predecessor order, operation bytes, and ordinals; do not extend this rule to local or anchored registries or introduce backdating safeguards without an explicit protocol decision (#1149).

- Before implementing protocol fixes, trace event production, transport, imports, durable evidence, and replay; establish ownership of the faulty value before adding resolver exceptions.

- Validate Rust startup optimizations against an isolated production-scale Redis copy with matching persistence settings, including timestamp-repair and unchanged startups. Build startup search/status views from the complete accepted replay snapshot after publication; exclude candidate-only histories, preserve runtime cache refreshes, and compare canonical histories, counters, and search/query results.
- When fixing Gatekeeper startup performance, trace both TypeScript and Rust service initialization. Both must consume replay-derived search/status views without immediately repeating full database scans; keep startup benchmark harnesses aligned with the actual service entry points.

- Gatekeeper Compose startup grace is configured by ARCHON_GATEKEEPER_START_PERIOD consistently across both runtime flavors and parity. Measure container-start-to-readiness time separately from individual phase/status timers; a longer grace period is not a replay performance fix.
- For standards-defined serialization such as RFC 8785, evaluate established libraries before extending a custom serializer. Test raw decimal parsing as well as output formatting; preserve canonical bytes through hashing and storage instead of parsing and re-encoding them.

- Before opening a code PR, run the root lint check as well as relevant builds/tests; fixture-generator scripts are linted by CI even when they are not executed by the test suite.

- Preserve canonicalizer return types: a missing JSON serialization must be rejected before encoding/hashing/storage, while optional undefined object members retain normal JSON omission semantics.

- Protocol documentation must distinguish whole-component replacement from field merging, predecessor-registry confirmation from a migration's resulting registry, and accepted-branch deletion from later evidence revalidation. Cross-check both Gatekeepers before turning explanatory prose into acceptance requirements.

- When consolidating protocol rules, search procedural checklists and pseudocode for superseded wording too; a new normative table does not correct contradictory identity, size-limit, or registry-selection instructions elsewhere.

- Convergence work must exercise ordinary signed imports with tied receipts, late predecessors, mixed local/gossip hints, chain confirmation, and controller-dependent replay. Distinguish finite permutation coverage from a formal proof, and audit retained production evidence before claiming existing forks.

- Choose provisional competing successors in the shared importer by canonical CID; do not globally CID-sort replay traversal. Preserve efficient predecessor-first processing and benchmark populated histories before changing replay ordering. An anchor outside the predecessor’s expected chain registry remains provisional for sibling preference.

- For provisional sibling ordering, `pin` supplies no chain priority even though it is a supported DID registry. Keep this distinct from the local/Hyperswarm helper used for receipt deduplication; cover pin-only and mixed pin/local imports with signed convergence fixtures.

- Formal convergence work must distinguish a unique canonical projection from proof that the production insertion/replay loop computes it. State graph, authorization, evidence-retention, and CID-abstraction assumptions explicitly; keep a checked bridge to shared signed fixtures, and audit theorem axioms without treating finite examples as a universal implementation proof.

- Proof CI must enforce the documented theorem-axiom allowlist and regenerate signed source vectors before checking the Lean bridge. Validate the bridge’s genesis and update-shape assumptions; do not rely on a fixed operation-table index for genesis. Apply these checks to each new bridge, derive actions from operation records, and emit warnings-as-errors in generated Lean modules too.

- Operational replay proofs must model late genesis, missing predecessors, duplicate identity, suffix truncation, and the actual stop-on-unchanged condition. Distinguish operation-ID path equality from the runtime’s serialized event-record equality; a path-level pass bound is not automatically a bound on all metadata transitions.

- Convergence proofs must distinguish operation-path agreement from event-record stability: duplicate expected-registry receipts retain the first representation. Prove phase composition before applying an operation-ID pass bound to full-record replay; separate phase theorems do not establish the combined runtime loop.

- When extending Lean replay proofs, prove the event-to-ID projection and complete-path phase boundary before reusing path/metadata bounds. Keep synthetic receipt projection examples distinct from full signed-record bridge cases, and retain the existing transitive axiom allowlist.

- Replay proof bridges should compare the actual per-event replay importers against Lean-checked intermediate pass states and the final serialized stopping decision, while retaining public ingress/restart coverage. Codec round-trip assumptions apply to normalized JSON/model values, not arbitrary JavaScript object identity; finite bridge traces do not prove general serializer or executable refinement.

- In convergence models, derive an agent operation's signing authority from its signed predecessor chain. Deletion makes that predecessor terminal; it does not prevent a preferred sibling from replacing a deleted branch through an earlier live predecessor. Keep signature-oracle assumptions distinct from executable verification claims.

- When modeling multiple verification methods, keep normalized method identity separate from public-key identity: a method can retain its name while replacing its key. Model current version-1 named-method lookup without inventing relationship-membership enforcement while #1156 is paused.

- Full-state convergence bridges must preserve whole-component replacement and omission semantics for didDocument, didDocumentData, and didDocumentRegistration. Keep the full-document/method-list projection explicit; deletion clears document/data while retaining registration, and registry changes require the separate chain-ordering model.

- In generated component proofs, intern repeated opaque payload values and check their decoding once; do not repeat large JSON-string equality reductions for every delivery permutation. Measure proof memory before running expensive Lean and cross-port suites together.

- A proof projection contract must be required by the convergence theorem and instantiated by generated fixtures; a standalone agreement lemma does not connect independent authorization and payload tables. Keep deletion metadata assertions independent of payload assertions in cross-port fixtures.

- Repeated expected-chain anchors must reconsider earlier valid ordinals even after a copy is confirmed. A late predecessor can make a later copy apply first; retaining it can make controller cutoffs and asset authorization depend on gossip order. Reauthorize earlier replacements and cover reversed hints plus repeat/startup replay with signed evidence.

- Keep chain-anchor minimum proofs conditional on settled paths and fixed per-anchor authorization. Rank complete ordinals lexicographically, state tie/missing-position exclusions, and instantiate the general theorems from shared signed fixtures; do not present a minimum-selection lemma as a proof of dynamic controller replay.

- Chain-anchor fixture bridges must derive settled paths from signed predecessor IDs using paired operation/ID tables. Reordering source events (with remapped deliveries) or paired operation tables must preserve generated proofs; use stable ordinal descriptions rather than source offsets in generated annotations.

- When composing chain anchor priorities with successor replay, state the settled-anchor phase boundary explicitly. Preserve operation identity under priority encoding and instantiate the composed theorem from signed competing branches; passing finite runtime traces does not prove the interleaved replay loop reaches that boundary.

- Count distinct delivery permutations when reporting fixture coverage, and test uniqueness for each scenario size. Negative bridge tests must mutate the exact field guarded by the claimed invariant in both operation tables and matching event records.

- Interleaved replay proofs must distinguish next-event settlement under a fixed predecessor from whole-path convergence. Check signed intermediate event records and the serialized stopping pass in both ports before claiming the model matches runtime interleaving.

- Interleaved replay bounds must use decreasing operation/predecessor levels, not event priority ranks. Instantiate the depth condition in signed fixtures, include the extra stability-detection pass, and keep proof fuel distinct from production replay limits.

- Proof-model projection contracts must state local eligibility/representation obligations and be instantiated by the shared signed fixtures; derive history equality rather than assuming it as a bridge premise.

- When combining convergence and authorization proofs, derive event eligibility from the signed predecessor document and prove decoded paths execute; state separately whether shared fixtures cover combined chain-anchor/key-rotation behavior or only each domain independently.

- When a combined proof starts after genesis, seed the same preferred genesis event in runtime transition fixtures and retain separate public-import coverage for late genesis. Include wrong-branch keys and invalid ancestors when composing document authorization with chain priorities.

- When prepending a compiled genesis rank in a proof, require its owner to be the document genesis and expose decoded full-history equality; a parentless selected rank alone does not establish identity.

- Migration convergence audits must derive the expected registry from signed predecessor ancestry: confirm the migration on the old registry, its successors on the new registry, and never rank receipts from different registries by ordinal alone. Test misleading destination/old-chain receipts and return migrations through ordinary imports and restart.

- Registry-prefix proofs must exclude the incoming operation’s own change when selecting its expected registry. Keep receipt registry equality distinct from chain-priority policy, especially for local, hyperswarm, and pin.

- Migration proof receipt ranks may group registries arbitrarily, but must preserve ordinal order within each chain. Derive anchor eligibility from signed predecessor registry state, retain wrong-chain receipts in the proof input, and prove eligible sibling anchors share a registry before interpreting their ranks as chain priority.

- When bridging migration priorities, kernel-check the same-chain ordinal-rank contract against complete source ordinals, and distinguish compiled replay equality from correspondence with raw interleaved replay. Derive compiled acyclicity from the operation graph rather than expanding every receipt rank into a termination case.
- Lean simplification of generic natural-number equality can pull in `Classical.choice` through ordering instances. Under the proof axiom allowlist, use explicit `Option.some_beq_some`/`Nat.beq_eq_true_eq` reductions and recheck transitive dependencies instead of broadening the allowlist.
- A fixture generator for a strict ordinal-rank theorem must reject ties across every eligible same-chain receipt pair, including distinct operations at different ancestry depths. Validate the theorem's full domain, not only comparisons performed by the expected-path oracle.

- Migration ordering bridges may collapse multiple provisional receipts of one operation to one CID rank, but must track full receipt identity separately and preserve the first provisional observation. Exercise both gossip-first and wrong-chain-first deliveries through both per-event importers, and do not infer full metadata or stopping refinement from rank equality alone.
- Protocol proof completion is tracked by fixed criteria A1–C3 in `docs/plans/protocol-convergence-completion.md`. Map proof PRs to those IDs, distinguish protocol semantics from universal runtime refinement, and report scope changes explicitly instead of extending the rolling roadmap.

- Integrated agent proofs must derive registry changes and document authorization from the same component tables. Prove registry-fold/component agreement, including deletion carry-forward, and distinguish abstract Lean examples from the signed cross-port bridge required by A4.

- When composing agent replay proofs, derive local priority projection from normalized receipt ownership and preferred-rank selection. Synthetic provisional representatives establish ordering only; keep stored receipt metadata and the source-to-rank bridge as explicit separate obligations.

- Proof documentation must distinguish Lean module filenames from qualified theorem names (`Archon.*`) and update earlier status paragraphs when a criterion is completed; keep per-module axiom counts unambiguous.

- Chain ordinal uniqueness must be demonstrated per producer: Solana instruction indices are transaction-local, and separate transactions can collide. Keep the signed A2 tie regression through import/repeat/restart in both ports; distinguish equal present ordinals from missing-position policy.

- Agent convergence must cover the authorization-relevant receipt view, not only operation IDs/documents. Controller anchoring eligibility follows the confirmed prefix and per-version expected registry; an unconfirmed wrong-registry suffix must not switch proof-time versus chain-position authorization.

- Convergence audits must trace authoritative receipt producers and trust-boundary normalization before expanding protocol selection rules. Chain receipts require nonempty ordinals; missing-position examples admitted only by permissive imports do not establish a bundled-mediator or production occurrence. Preserve ordinal-free local/Hyperswarm/pin hints.
