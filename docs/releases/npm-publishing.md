# npm release procedure

Use a dedicated release branch from main and merge its version changes through a
PR after publication. The successful 2026-08-26 release used the existing
`npm-package-publish.yml` workflow with `package=all`, npm 10.9.2, Lerna and
`NPM_TOKEN` in the production environment (run 33009816035, PR #950).
Package versions are independent of the Archon application version.

Confirm the requested bump before dispatching. A workflow run can successfully
push its version commit and package tags even when publication fails. Preserve
those versions and retry with `current`; never repeat the bump to recover a
publication failure. The existing current mode builds before checking out the
release tag, so dispatch from the tagged source commit, or a branch with identical
build inputs. Keep workflow changes separate from an instruction to repeat the
existing release process. Check the last successful run before proposing an
authentication change; an npm E404 alone does not prove a token expired.

The 2026-09-24 minor release generated all seven package tags at `12fda06f`
on `release/npm-minor-2026-09-24` in run 36033539172. Builds succeeded, but
publication failed with npm E404 responses. Registry reads immediately afterward
found none of the new versions. Resolve authentication before retrying and verify
each package version and its `latest` dist-tag after success. This supersedes the
unpublished patch release proposed in #1283; its old tags have been preserved.

Do not count the workflow's `lerna run test` step as unit-test coverage: these
packages have no test lifecycle scripts. Check the release PR's root unit and
convergence CI separately. Keep lockfile operations on npm 10.9.2, and never print
authentication credentials.
