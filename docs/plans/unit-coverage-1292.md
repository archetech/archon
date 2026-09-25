# Prioritized unit coverage audit (#1292)

The baseline is the merged unit and convergence artifacts from CI run
[36146268053](https://github.com/archetech/archon/actions/runs/36146268053),
commit `fc92c0cc`. Unit coverage alone understates Gatekeeper coverage because
convergence tests run separately.

## Changes

- OAuth: recreate the module/router against the real persisted key, compare
  JWKS, and verify ID tokens issued before and after restart using real JOSE
  verification. Also exercise corrupt-file replacement and expired code/token
  removal. Opaque tokens intentionally remain in memory.
- Portable networking: nonpublic IP representations, non-HTTPS URLs, redirect
  destination validation, missing Location, loop limits, relative redirects,
  response-body cancellation, and non-redirect 304 responses. These supplement
  the existing Node DNS/transport tests rather than duplicating them.
- Keymaster: signed DIDComm documents with explicit valid/missing/wrong-type
  routing methods; failed endpoint discovery without partial publication;
  signed authority replacement that leaves the wallet unable to repair;
  repair rejection and retry; address challenge transport failure and fallback.
- SQLite: inject a real trigger failure midway through reset, check rollback
  of previously deleted tables, reopen storage, remove the failure, then verify
  successful reset and subsequent writes. This tests persistence failure, not
  protocol acceptance.
- Herald integration: root discovery, mounted OAuth membership lookup,
  cross-session browser login recovery, and rejected authentication.

## Defect found

Reloading a persisted ES256 private key with JOSE's default non-extractable
import prevented rebuilding the public JWKS. Startup caught the export failure
and generated a replacement key, breaking verification of earlier ID tokens
against the current JWKS. Importing with `extractable: true` fixes this; no
protocol acceptance or network policy changes are needed.

Regression-testing lesson: a key file's existence does not establish restart
continuity. Load it in a fresh instance, check public-key identity and verify an
earlier signature. Keep opaque token persistence separate from signing-key
persistence. The Herald service documentation records this requirement too.

## Remaining scope and measurement boundaries

Gatekeeper's remaining uncovered lines were reviewed after the higher-priority
areas. They include malformed-key/format rejection, invalid configuration,
search/replay exception handling, auxiliary queue saturation, and old-record
fallbacks. Existing signed history-recovery and convergence suites already
exercise late evidence, dependent replay, durable reopen, and journal-write
failure. This change does not invent historical corruption or unreachable
protocol inputs to enter remaining catch blocks; it adds no Gatekeeper runtime
safeguards.

The separately configured `tests/didcomm/e2e.test.ts` uses real HTTP relay
transport, while the unit routing tests mock the transport boundary and use
real signed documents and encryption. CLI tests run against services; wallet
render tests use their own Vitest configurations. Rust, Python, mediator
sources, and most UI code are outside this merged Jest report. Its explicit
exclusions also include MongoDB/Redis adapters, browser storage variants,
Herald SQLite/SendGrid, Drawbridge storage, CLI entry points, and service
bootstrap files. Exclusion is not evidence of adequate coverage elsewhere.

Coverage configuration and thresholds are unchanged. The objective is useful
behavioral assertions, not 100% execution coverage.

## Validation and measured results

Local validation on Node 22.15.0: package builds and root typecheck pass.
Root lint reports only the two pre-existing warnings. The full unit run had
176 passing suites and one new assertion failure: Jest interpreted the dot in
an address as a nested property path. After correcting that assertion to use a
literal key, all 24 tests in the affected suite passed on rerun (3,602 passing
unit tests across the run and correction; three existing skipped tests).
All six convergence suites pass, with 236 tests.

The following combines the full unit and convergence reports, plus the
corrected address-suite rerun. Denominators match the CI baseline. These are
raw CI-to-local comparisons, not a controlled identical-environment benchmark.

| Area | Baseline lines → local | Baseline branches → local |
| --- | --- | --- |
| Overall | 96.27% → 96.83% | 87.76% → 87.45% |
| Keymaster | 94.71% → 95.27% | 83.62% → 84.08% |
| Herald routes | 90.41% → 91.80% | 87.50% → 89.28% |
| Portable network helper | 80.00% → 89.56% | 54.54% → 75.75% |
| Herald OAuth | 88.94% → 96.98% | 88.65% → 87.62% |
| Gatekeeper SQLite | 92.13% → 93.82% | 75.47% → 75.47% |
| Gatekeeper core | 97.60% → 97.60% | 92.94% → 92.94% |

Covered lines increased by 56; uncovered lines fell from 371 to 315.
Function coverage increased from 97.74% to 98.07%. Overall branch coverage is
lower because the local node's environment changes which configuration
fallbacks execute: the five service configuration modules cover 34 fewer
branches than CI. OAuth also has environment-sensitive admin-key/URL fallbacks
and a net reduction of one covered branch despite the newly exercised paths.
The other changed areas add 23 covered branches. CI will provide the comparison
under its own environment; do not present the local branch percentage as a
controlled measure of the test additions alone.

## Keymaster follow-up

Additional public-API tests cover malformed addresses, failed authenticated
claims without wallet mutation, server error messages and unusable lookup
responses, and implicit publication with zero/one/multiple stored addresses.
DIDComm coverage now includes local mailbox errors, rejected gateway challenges
and fetches, missing endpoints, cached discovery failure with delivery fallback,
invalid key-agreement references in signed documents, and unpublishing while
preserving unrelated services and signing authority. A real encrypted Forward
is left unacknowledged after a rejected delivery and acknowledged only after a
successful retry.

Both affected suites pass (99 tests). Merging their updated coverage with the
preceding full unit/convergence run raises `packages/keymaster/src/keymaster.ts`
from 95.27% to **96.34% lines**, 84.08% to **86.38% branches**, and 98.23% to
**98.82% functions**: 29 more covered lines and 25 more covered branches. This
follow-up changes tests only; it does not change Keymaster acceptance or retry
policy. Assertions exercise transport failure and signed document state rather
than calling private helpers solely to enter uncovered code.
