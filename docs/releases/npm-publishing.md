# npm publishing recovery

The 2026-09-24 publish run created all seven package tags at commit
`4178b032` but could not push its version commit to protected `main`.
GitHub requires a PR and status checks. The npm publish step did not run.

Preserve already-created tags and versions. Bring the tagged version commit into
a release PR; do not repeat the version bump or bypass branch protection.
For recovery, select `current` with the publishing workflow at the release branch.
That mode checks out the selected release tag **before** dependency installation
and building, then uses `lerna publish from-package` to publish versions absent
from npmjs. For this all-package patch release, all seven tags share one commit.
Use npm 10.9.2 for dependency/lockfile operations and verify each npm version and
`latest` tag afterward. Never print registry authentication credentials.

The regular bump path still attempts a direct push to main and requires a future
PR-based versioning workflow before it can be reused under current repository
rules. Single-package selection and prerelease recovery have separate limitations;
this recovery uses all packages and stable patch versions only.
