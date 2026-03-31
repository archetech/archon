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
- Do not use stash-based branch juggling as the default workflow.
- Never run mutating git operations in parallel. Serialize `git add`, `git commit`, `git push`, branch moves, stash operations, and any command that writes to `.git`.
- Prefer a clean branch cut over moving changes around after the fact.
- If branch state becomes confusing, stop and cleanly reestablish scope before making more commits.
