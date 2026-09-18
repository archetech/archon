# Operation size compatibility (#1159)

On 2026-09-17 the user explicitly chose **preserve version 1; align Rust**.
The current protocol limit is 65,536 UTF-16 code units in compact ECMAScript JSON,
including proof, keys, values, punctuation, and extension members. Rust previously
counted UTF-8 bytes. Align its counting with legacy TypeScript acceptance; do not
retroactively apply a stricter UTF-8 rule or activate version 2.

The TypeScript `maxOpBytes` option retains its legacy name/unit for local
submissions only. Import and historical verification always use the fixed protocol
limit, independent of node configuration. Transport limits remain separate.

## Production audit

A read-only local Redis snapshot completed at 2026-09-17T23:49:28.016Z:

- 40,047 accepted operations, none exceeding 65,536 UTF-8 bytes.
- 40,383 candidate rows (40,060 unique operation IDs), none exceeding that size.
- Largest serialized operation: 65,336 bytes/code units.
- 27 accepted operations contain non-ASCII content; all are within both limits.
- No missing operation payloads; accepted histories were unchanged across the
  export's two consistency reads. Candidate entries were read without locking.

This clean snapshot does not establish that every possible historical operation
fits the stricter byte limit, and does not override the chosen compatibility rule.
Local artifacts: `/tmp/1159-audit/size-report.json` and the accompanying snapshots.

## Validation contract

Shared signed fixtures cover ASCII, BMP, supplementary characters, short/long
escapes, quote/backslash escapes, exact-limit/over-limit cases, and the original
40,000-`é` reproduction. Creation, update, and deletion exercise submission,
import, stored-history replay, and restart in both ports. Compact repetition recipes
expand into signed payloads before verification, avoiding large fixture files.
Additional shared measurements cover JSON keys, containers, and ECMAScript number
formatting. TypeScript tests separate local submission caps from import/replay and
prove larger configured caps cannot increase the protocol maximum.

CID/signature serialization is unchanged; broader number/CID parity remains #1180.
Stricter UTF-8 enforcement is deferred to a future version design. #1156 remains
paused and independent of this repair.

## Local verification

- TypeScript Gatekeeper: 700 test cases covered; initial full run passed 699 and
  timed out one JSON history-recovery case. The entire 82-case recovery suite
  passed on rerun. Final size/CRUD run passed all 53 cases.
- Rust: 69 unit tests and 29 integration tests passed (3 ignored benchmarks/tests).
  The size-specific tests passed again after formatting.
- Isolated live TypeScript/Rust HTTP services agreed on all 34 signed
  submission/import scenarios. Temporary memory/JSON stores were used, with no
  production writes; results are in `/tmp/1159-live/results.json`.
- Gatekeeper package/server builds, root typecheck, and lint passed.
