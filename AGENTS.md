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
- For GitHub operations in this repo, prefer `gh` by default, especially for write actions. Do not try the GitHub app first and then fall back to `gh` unless there is a clear reason to use the app.
- When generating or updating npm lockfiles, use the repo-pinned npm version from the root `package.json` so lockfiles stay compatible with CI.
- Internal service-to-service admin auth should use `X-Archon-Admin-Key` consistently. Reserve `Authorization` for user/session/OAuth-style flows unless a file explicitly documents a different scheme.
- For Herald agent guidance, prefer Keymaster address commands (`check-address`, `add-address`, `remove-address`, etc.) in quick starts while keeping direct API endpoint documentation available for lower-level integrations.
- After a PR is merged, always do the standard local cleanup unless the user says otherwise: switch to `main`, fast-forward from `origin/main`, and delete the merged local branch.
- Do not use stash-based branch juggling as the default workflow.
- Never run mutating git operations in parallel. Serialize `git add`, `git commit`, `git push`, branch moves, stash operations, and any command that writes to `.git`.
- Prefer a clean branch cut over moving changes around after the fact.
- If branch state becomes confusing, stop and cleanly reestablish scope before making more commits.
- When adding Prometheus HTTP route labels, normalize dynamic path segments like DIDs, hashes, txids, and CIDs before recording metrics so dashboards do not create one time series per identifier.
- Nostr event IDs in Python parity code must use compact JSON serialization (`separators=(",", ":")`) to match the TypeScript `JSON.stringify` hashing/signing contract.
- Python Lightning invoice parity should only surface `expiry` and `expires` when the BOLT11 invoice actually includes an expiry tag; the `bolt11` library exposes a default expiry even when the tag is absent.
- Python keymaster flavor runs in CLI CI must force `ARCHON_KEYMASTER_DB=json`; the generated CLI test `.env` still defaults keymaster DB to `redis` for the TypeScript service.
- Any generated `.env` used with bind-mounted service data must derive `ARCHON_UID` and `ARCHON_GID` from the current host user (`id -u` / `id -g`); hardcoding `1000:1000` breaks Python keymaster JSON wallet writes on CI runners and non-1000 hosts.
