# npm release procedure

Use a dedicated release branch from main and merge its version changes through a
PR after publication. Package versions are independent of the Archon application
version. Confirm the requested bump before dispatching the workflow.

The successful August 26 release used `npm-package-publish.yml`, `package=all`,
npm 10.9.2, Lerna and `NPM_TOKEN` (run 33009816035, PR #950). Commit `0c5dae83`
records that OIDC was disabled in May because per-package trusted publishers were
not configured then. Consult the successful run AND this history before changing
authentication; npm E404 alone does not establish token expiration.

## September 24 release status

Run 36033539172 generated all seven minor-version tags at `12fda06f` on
`release/npm-minor-2026-09-24`. Builds succeeded, but publication failed. Registry
reads found none of the new versions. PR #1284 supersedes unpublished patch PR
#1283; its old tags have been preserved.

The direct credential check in run 36034964815 established:

- The repository's stored NPM_TOKEN receives HTTP 401 from npm's whoami endpoint.
  This proves rejection of that credential; it does not distinguish expiration
  from revocation or other credential configuration problems.
- GitHub issues an OIDC identity, but npm's exchange endpoint returns HTTP 404:
  `OIDC token exchange error - package not found` for @didcid/common. Package
  settings must be checked before claiming trusted publishing is configured.

The maintainer confirmed that @didcid/common's trusted publisher settings were
empty and chose to renew the repository NPM_TOKEN rather than configure OIDC.
Publishing therefore uses npm 10.9.2 and token authentication only, matching the
successful August release. Do not re-enable OIDC without a separate decision and
verified per-package configuration. Never print credentials. The renewed token
is awaiting a successful publish run.

## Recovery and validation

A failed run can already have pushed its version commit and tags. Preserve them
and retry with `version=current`, never another bump. Recovery checks out the
release tag before installation/build and uses Lerna `from-package` to skip
published versions. Keep npm 10.9.2 for installation, lockfiles and token-based publishing. Verify every version and its `latest` dist-tag after publishing.

Do not count `lerna run test` as unit coverage: these packages have no test
lifecycle scripts. Check root unit and convergence CI separately. Do not merge
the release PR until publication and verification succeed.
