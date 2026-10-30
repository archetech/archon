#!/usr/bin/env bash
# Decides which expensive CI jobs a change can affect, as key=value lines for
# $GITHUB_OUTPUT:
#
#   unit    the Jest suites and coverage: anything but Markdown and deploy/,
#           except Markdown a test reads
#   images  the Docker image builds: the paths the Dockerfiles copy from
#   e2e     the CLI and parity tests against those images: images, plus the
#           tests and fixtures that drive them
#
# tests/ci/ci-affected.test.ts derives these inputs from the Dockerfiles, the
# tests and the parity runner, so a new input fails CI rather than being
# skipped.
#
# Main, tags and an empty diff run everything. A branch is compared with its
# merge base on main, so a later documentation-only commit still runs what the
# branch's earlier commits need. A pull_request checkout is the merge commit,
# whose first parent is the base.
#
# `--paths` reads the changed paths from stdin instead, for testing.
set -euo pipefail

everything() {
    printf 'unit=true\nimages=true\ne2e=true\n'
}

classify() {
    local paths code
    paths=$(grep -v '^$' || true)
    if [ -z "$paths" ]; then
        everything
        return
    fi
    # Workflow and action changes run everything: they can change any job.
    if grep -qE '^\.github/' <<<"$paths"; then
        everything
        return
    fi
    code=$( { grep -vE '(\.md$|^deploy/)' <<<"$paths"; grep -E '^docs/scheme\.md$' <<<"$paths"; } || true)
    local unit=false images=false e2e=false
    [ -n "$code" ] && unit=true
    # Root-level files (package.json, lockfiles, tsconfig, compose files,
    # sample env) are included wholesale.
    if grep -qE '^(docker/|packages/|services/|apps/|scripts/|rust/|python/|prebuilds/|[^/]+$)' <<<"$code"; then
        images=true
        e2e=true
    elif grep -qE '^(tests/(cli|cli-tests|gatekeeper|fixtures)/|tests/convergence/vectors\.json$)' <<<"$code"; then
        e2e=true
    fi
    printf 'unit=%s\nimages=%s\ne2e=%s\n' "$unit" "$images" "$e2e"
}

if [ "${1:-}" = --paths ]; then
    classify
    exit 0
fi

ref=${GITHUB_REF:-}
if [ "$ref" = refs/heads/main ] || [[ "$ref" == refs/tags/* ]]; then
    everything
    exit 0
fi

if [ "${GITHUB_EVENT_NAME:-}" = pull_request ]; then
    base=$(git rev-parse HEAD^1)
else
    git fetch --quiet --no-tags origin main
    base=$(git merge-base FETCH_HEAD HEAD)
fi

git diff --name-only "$base" HEAD | classify
